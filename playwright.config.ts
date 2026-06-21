import { defineConfig, devices } from '@playwright/test'

// E2E config for midee (Tier 3 of docs/TESTING_STRATEGY_2026-06-21.md).
//
// midee is a static Vite SPA whose flagship feature — MP4 export — runs entirely
// in the browser via WebCodecs (`VideoEncoder`/`AudioEncoder`) + Mediabunny. jsdom
// cannot exercise that, so these tests drive a real headless Chromium.
//
// webServer: `vite build && vite preview` — NOT `npm run build`. We deliberately
//   skip `tsc` (a separate CI step) and the whole postbuild chain (build-content,
//   build-og, stamp-sitemap, check-links, upload-sourcemaps) — none of it is needed
//   to serve `/`, and check-links/upload-sourcemaps do network I/O + need secrets.
//   A bare `vite build` is ~1.4s and produces a fully functional bundle.
//
// Speed: the default suite runs in ~28s serial (lean build + 6 light specs). We run
//   workers: 1 ON PURPOSE — playback.spec asserts the real-time clock advances at
//   ~real-time, which gets starved (and flaky) if a sibling spec saturates the CPU.
//   The one heavy/flaky spec — the AV MP4 export (software H.264 encode) — is gated
//   behind E2E_HEAVY (see e2e/export.spec.ts) so the default run stays fast and
//   deterministic. Run the full set with `npm run test:e2e:heavy`.

const PORT = Number(process.env.E2E_PORT ?? 4173)
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          // Only the AV export (E2E_HEAVY) needs these: VideoExporter.pickCodec
          // probes H.264 with `hardwareAcceleration: 'prefer-hardware'`, which plain
          // headless Chromium rejects (no HW encoder). ANGLE+SwiftShader gives it a
          // GPU-backed path. This is a TEST-SIDE WORKAROUND FOR BUG-1 (pickCodec
          // should fall back to software); remove these flags once BUG-1 is fixed.
          args: [
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--ignore-gpu-blocklist',
            '--enable-unsafe-swiftshader',
          ],
        },
      },
    },
  ],
  webServer: {
    command: `npx vite build && npx vite preview --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
