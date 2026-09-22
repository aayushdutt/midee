import { fileURLToPath } from 'node:url'
import { expect, type Page, test } from '@playwright/test'

const MIDI = fileURLToPath(new URL('../fixtures/multi-track.mid', import.meta.url))
const MATERIALS = [
  { id: 'opal', name: 'Opal', particles: 'pearl', particleName: 'Opal dust' },
  { id: 'liquid-glass', name: 'Liquid Glass', particles: 'liquid', particleName: 'Glass dust' },
] as const

function watchRenderingErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  // WebGL compilation/link errors can be console messages without throwing a
  // JavaScript exception. Ignore ordinary software-GPU performance warnings.
  page.on('console', (message) => {
    if (
      /shader.*(?:error|failed)|(?:error|failed).*shader|GL_INVALID|INVALID_OPERATION|linkProgram|WebGL.*error/i.test(
        message.text(),
      )
    ) {
      errors.push(message.text())
    }
  })
  return errors
}

async function openAppearance(page: Page): Promise<void> {
  const menu = page.locator('.ts-customize-menu')
  if ((await menu.getAttribute('class'))?.includes('ts-popover--open')) return
  await page.locator('#ts-customize').hover()
  await page.locator('#ts-customize').click()
  await expect(menu).toHaveClass(/ts-popover--open/)
}

async function closeAppearance(page: Page): Promise<void> {
  await page.locator('#ts-customize').click()
  await expect(page.locator('.ts-customize-menu')).not.toHaveClass(/ts-popover--open/)
}

async function selectMaterial(page: Page, material: (typeof MATERIALS)[number]): Promise<void> {
  await openAppearance(page)
  const tile = page.getByRole('button', { name: `${material.name} theme`, exact: true })
  await tile.click()
  await expect(tile).toHaveClass(/customize-theme-tile--on/)
  expect(await page.evaluate(() => localStorage.getItem('midee.theme'))).toBe(material.id)
}

async function seek(page: Page, seconds: number): Promise<void> {
  await page.locator('#hud-scrubber').evaluate((element, target) => {
    const input = element as HTMLInputElement
    input.value = String(target)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, seconds)
}

async function togglePlayback(page: Page): Promise<void> {
  await page.locator('#hud-play').hover()
  await page.locator('#hud-play').click()
}

test('material themes render MIDI, switch populated pools, and restore coordinated particles', async ({
  page,
}, testInfo) => {
  const errors = watchRenderingErrors(page)
  await page.goto('/')
  await page.locator('#midi-input').setInputFiles(MIDI)
  await expect(page.locator('#hud-play')).toBeVisible({ timeout: 30_000 })
  // Loading may auto-play after 250ms. Settle that real app behavior before
  // seeking and exercising every material's scheduled-note renderer.
  await page.waitForTimeout(400)
  if ((await page.locator('#hud-play').getAttribute('data-playing')) === 'true') {
    await togglePlayback(page)
  }

  for (const material of MATERIALS) {
    await seek(page, 0.2)
    await selectMaterial(page, material)
    await expect(
      page.getByRole('button', { name: `${material.particleName} particles`, exact: true }),
    ).toHaveClass(/--on/)
    expect(await page.evaluate(() => localStorage.getItem('midee.particle'))).toBe(
      material.particles,
    )
    await closeAppearance(page)
    await togglePlayback(page)
    await expect
      .poll(async () => Number(await page.locator('#hud-scrubber').inputValue()))
      .toBeGreaterThan(0.45)
    await togglePlayback(page)
    // A compositor screenshot forces the material through actual GPU rendering,
    // and leaves a useful visual artifact when inspecting browser-test results.
    await testInfo.attach(`${material.id}-scheduled`, {
      body: await page.locator('canvas').first().screenshot(),
      contentType: 'image/png',
    })
    expect(errors, `${material.name} rendering errors`).toEqual([])
  }

  await page.reload()
  await page.locator('#home-live').click()
  await openAppearance(page)
  await expect(page.getByRole('button', { name: 'Liquid Glass theme', exact: true })).toHaveClass(
    /--on/,
  )
  await expect(
    page.getByRole('button', { name: 'Glass dust particles', exact: true }),
  ).toHaveClass(/--on/)
  expect(errors).toEqual([])
})

test('live themes restore authored particles from Off and survive held chords across mobile resize', async ({
  page,
}, testInfo) => {
  const errors = watchRenderingErrors(page)
  await page.addInitScript(() => localStorage.setItem('midee.particle', 'none'))
  await page.goto('/')
  await page.locator('#home-live').click()
  const tonic = page.locator('#ts-chord-readout .ts-chord-readout-tonic')

  for (const material of MATERIALS) {
    await openAppearance(page)
    await page.getByRole('button', { name: 'Off particles', exact: true }).click()
    await selectMaterial(page, material)
    const pairedEffect = page.getByRole('button', {
      name: `${material.particleName} particles`, exact: true,
    })
    await expect(pairedEffect).toHaveClass(/--on/)
    expect(await page.evaluate(() => localStorage.getItem('midee.particle'))).toBe(
      material.particles,
    )
    // An explicit override remains possible; reselecting this same theme must
    // restore the complete authored preset, not return early on the theme id.
    await page.getByRole('button', { name: 'Sparks particles', exact: true }).click()
    await selectMaterial(page, material)
    await expect(pairedEffect).toHaveClass(/--on/)
    await closeAppearance(page)
    await page.locator('body').click({ position: { x: 5, y: 5 } })
    await page.keyboard.down('x')
    await expect(tonic).toHaveText('D')
    // Give the held note real duration: a zero-height onset never exercises the
    // material surface, especially the Liquid Glass mesh's fragment shader.
    await page.waitForTimeout(250)
    if (material.id === 'liquid-glass') {
      for (const key of ['z', 'c', 'v', 'b', 'q', 'e', 't']) await page.keyboard.down(key)
      await page.waitForTimeout(200)
      await page.setViewportSize({ width: 390, height: 844 })
      await testInfo.attach(`${material.id}-live-mobile`, {
        body: await page.locator('canvas').first().screenshot(),
        contentType: 'image/png',
      })
      await page.setViewportSize({ width: 1280, height: 720 })
      for (const key of ['z', 'c', 'v', 'b', 'q', 'e', 't']) await page.keyboard.up(key)
    }
    await testInfo.attach(`${material.id}-live`, {
      body: await page.locator('canvas').first().screenshot(),
      contentType: 'image/png',
    })
    await page.keyboard.up('x')
    await expect(tonic).toHaveText('-')
    expect(errors, `${material.name} live rendering errors`).toEqual([])
  }
})
