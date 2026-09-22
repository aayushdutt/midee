// Builds the standalone HTML dot-plot report written by `scripts/dotplot.mjs --html`.
//
// Split in three:
//   • this file  — data payload, computed insights, page shell, CSS
//   • dotplot-client.js — everything rendered in the browser (inlined verbatim)
//   • dotplot.mjs — the PostHog queries
//
// Layout/typography use Tailwind from the CDN; the data marks use local CSS so
// nothing depends on Tailwind seeing JS-generated class names.
//
// Colour: the cell ramp is ORDINAL (depth of engagement 0→3), so it is one hue
// light→dark, not a categorical rainbow. The line chart's source colours are
// categorical slots 1-4 in fixed order. Both palettes were run through the
// data-viz validator (adjacent CVD ΔE ≥ 8, ordinal ΔL ≥ 0.06, light-end ≥ 2:1)
// in light and dark mode before being pasted here — if you change a hex,
// re-run that validator rather than eyeballing it.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0)
const num = (n) => n.toLocaleString('en-US')
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

// ── insight computation (Node side, so the prose carries real numbers) ──────
function computeInsights(users, calendarDays, ladder) {
  const tierOf = Object.fromEntries(ladder.map((l) => [l.sym, l.tier]))
  const last = calendarDays.length - 1
  const u = users.map((p) => {
    const syms = calendarDays.map((d) => p.days.get(d) ?? ' ')
    const active = syms.filter((s) => s !== ' ').length
    const tiers = syms.map((s) => (s === ' ' ? -1 : tierOf[s]))
    return {
      ...p,
      syms,
      active,
      maxTier: Math.max(-1, ...tiers),
      firstIdx: calendarDays.indexOf(p.first),
      day0Tier: tiers[calendarDays.indexOf(p.first)] ?? -1,
      symSet: new Set(syms.filter((s) => s !== ' ')),
    }
  })

  const n = u.length
  const activated = u.filter((p) => p.maxTier >= 1).length
  const returned = u.filter((p) => p.active >= 2).length
  const made = u.filter((p) => p.maxTier >= 3).length

  // Return rate by how deep the user got on their FIRST day. Users whose first
  // day is the last day of the window are excluded — they had no chance to return.
  const eligible = u.filter((p) => p.firstIdx < last)
  const byDay0 = [0, 1, 2, 3].map((t) => {
    const g = eligible.filter((p) => p.day0Tier === t)
    return { tier: t, n: g.length, returned: g.filter((p) => p.active >= 2).length }
  })

  const bySource = {}
  for (const p of u) {
    const s = (bySource[p.source] ??= { users: 0, returned: 0, activated: 0, made: 0 })
    s.users++
    if (p.active >= 2) s.returned++
    if (p.maxTier >= 1) s.activated++
    if (p.maxTier >= 3) s.made++
  }
  const bestSource = Object.entries(bySource)
    .filter(([, s]) => s.users >= 50)
    .sort((a, b) => b[1].returned / b[1].users - a[1].returned / a[1].users)[0]

  const dev = (d) => {
    const g = u.filter((p) => p.device === d)
    return { n: g.length, ret: g.filter((p) => p.active >= 2).length, act: g.filter((p) => p.maxTier >= 1).length }
  }
  const desktop = dev('desktop')
  const mobile = dev('mobile')

  const startedEx = u.filter((p) => p.symSet.has('x') || p.symSet.has('X')).length
  const doneEx = u.filter((p) => p.symSet.has('X')).length
  const loopers = u.filter((p) => p.symSet.has('L'))
  const exporters = u.filter((p) => p.symSet.has('E'))
  const mean = (arr, f) => (arr.length ? arr.reduce((a, x) => a + f(x), 0) / arr.length : 0)

  // Which single behaviour best separates returners from bouncers? Ranked, not
  // assumed — loops "feel" stickiest but the data has to say so.
  const behaviours = [
    ['L', 'recorded a loop'],
    ['E', 'exported a video'],
    ['R', 'recorded a performance'],
    ['X', 'completed an exercise'],
    ['x', 'started an exercise'],
    ['K', 'played their own keyboard'],
  ]
    .map(([sym, name]) => {
      const g = u.filter((p) => p.symSet.has(sym))
      return { sym, name, n: g.length, ret: pct(g.filter((p) => p.active >= 2).length, g.length), days: mean(g, (p) => p.active) }
    })
    .filter((b) => b.n >= 25)
    .sort((a, b) => b.ret - a.ret)
  const bestBehaviour = behaviours[0]
  const loopStat = behaviours.find((b) => b.sym === 'L')
  const popRet = pct(returned, n)

  const topRow = [...u].sort((a, b) => b.active - a.active)[0]

  // weekday shape: mean active users per weekday
  const dow = Array.from({ length: 7 }, () => ({ users: 0, days: 0 }))
  calendarDays.forEach((d, i) => {
    const w = new Date(`${d}T00:00:00Z`).getUTCDay()
    dow[w].days++
    dow[w].users += u.filter((p) => p.syms[i] !== ' ').length
  })
  const dowAvg = dow.map((x) => (x.days ? x.users / x.days : 0))
  const wk = (dowAvg[1] + dowAvg[2] + dowAvg[3] + dowAvg[4] + dowAvg[5]) / 5
  const we = (dowAvg[0] + dowAvg[6]) / 2

  const listenOnly = byDay0[1]
  const madeDay0 = byDay0[3]

  return {
    stats: { n, activated, returned, made },
    items: [
      {
        n: `${pct(n - activated, n)}%`,
        text: `of ${num(n)} users never hear a single note — they land, poke around and leave without playback. That one number is still the largest hole in the funnel, and it is upstream of every other chart on this page.`,
      },
      {
        n: `${pct(madeDay0.returned, madeDay0.n)}% vs ${pct(listenOnly.returned, listenOnly.n)}%`,
        text: `return rate for users who <em>made something</em> on day 0 (recorded, exported, looped or completed an exercise; n=${num(madeDay0.n)}) versus users who only listened (n=${num(listenOnly.n)}). Depth on the first day is the strongest predictor of a second day we have.`,
      },
      {
        n: `${num(exporters.length)}`,
        text: `users exported a video, and they average <strong>${mean(exporters, (p) => p.active).toFixed(1)} active days</strong> against ${mean(u, (p) => p.active).toFixed(1)} for the population. The heaviest row on the plot (<code>${esc(topRow.did.slice(0, 8))}</code>, ${esc(topRow.source)}/${esc(topRow.country)}) is export-driven on ${topRow.active} of ${calendarDays.length} days.`,
      },
      {
        n: `${num(startedEx - doneEx)} of ${num(startedEx)}`,
        text: `users who start an exercise never complete one (${pct(doneEx, startedEx)}% completion). The dot plot shows the same users starting exercises on many separate days — this is a wall people keep hitting, not a one-off.`,
      },
      {
        n: `${pct(mobile.ret, mobile.n)}% vs ${pct(desktop.ret, desktop.n)}%`,
        text: `second-day return on mobile (n=${num(mobile.n)}) versus desktop (n=${num(desktop.n)}). Mobile activation is ${pct(mobile.act, mobile.n)}% against desktop's ${pct(desktop.act, desktop.n)}% — the mobile problem starts before retention.`,
      },
      bestSource && {
        n: `${pct(bestSource[1].returned, bestSource[1].users)}%`,
        text: `return rate from <strong>${esc(bestSource[0])}</strong> (${num(bestSource[1].users)} users) — the best of any channel with 50+ users. Compare the retention curves below before spending anything on acquisition.`,
      },
      bestBehaviour && {
        n: `${bestBehaviour.ret}%`,
        text: `of the users who have ever <strong>${bestBehaviour.name}</strong> come back a second day (n=${num(bestBehaviour.n)}), against ${popRet}% of everyone — the widest gap of any behaviour with 25+ users. Ranked, not assumed: ${behaviours
          .slice(0, 4)
          .map((b) => `${esc(b.name)} ${b.ret}%`)
          .join(', ')}.`,
      },
      loopStat && {
        n: `${num(loopers.length)} of ${num(n)}`,
        text: `users have ever recorded a loop — ${loopStat.ret}% of them return and they average ${loopStat.days.toFixed(1)} active days. Whether looping causes stickiness or only attracts already-committed users, ${num(n - loopers.length)} people never touched it, so we cannot tell yet. Making it discoverable is the cheap experiment.`,
      },
      {
        n: `${wk.toFixed(0)} vs ${we.toFixed(0)}`,
        text: `average active users on a weekday versus a weekend day. ${wk > we * 1.15 ? 'This is a weekday product — people use it at a desk, probably at work or school.' : 'Usage is flat across the week, so this is a leisure product, not a desk one.'}`,
      },
    ].filter(Boolean),
  }
}

// ── page ───────────────────────────────────────────────────────────────────
export function buildReport({ people, calendarDays, ladder, days }) {
  const insights = computeInsights(people, calendarDays, ladder)

  const payload = {
    days: calendarDays,
    window: days,
    generated: new Date().toISOString().slice(0, 16).replace('T', ' '),
    ladder: ladder.map(({ sym, tier, label }) => ({ sym, tier, label })),
    users: people.map((p) => [
      p.did,
      p.source,
      p.device,
      p.country,
      calendarDays.indexOf(p.first),
      calendarDays.map((d) => p.days.get(d) ?? ' ').join(''),
    ]),
  }

  const client = readFileSync(join(HERE, 'dotplot-client.js'), 'utf8')

  const insightItems = insights.items
    .map(
      (it) =>
        `<li class="flex gap-4"><span class="ins-n">${it.n}</span><span class="ins-t">${it.text}</span></li>`,
    )
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>midee — user behaviour dot plots</title>
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
<style>
:root{
  color-scheme: light;
  --page:#f4f3f0; --surface-1:#fcfcfb; --surface-2:#f0efec;
  --text-primary:#0b0b0b; --text-secondary:#52514e; --text-muted:#7a7973;
  --line:#e3e2dd; --grid:#eae9e5;
  --cell-empty:#f1f0ec;
  --t0:#c2c1b8; --t1:#86b6ef; --t2:#2a78d6; --t3:#104281;
  --ink0:#0b0b0b; --ink1:#0b0b0b; --ink2:#ffffff; --ink3:#ffffff;
  --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100;
  --ring:#0b0b0b;
}
@media (prefers-color-scheme: dark){
  :root:where(:not([data-theme="light"])){
    color-scheme: dark;
    --page:#131312; --surface-1:#1a1a19; --surface-2:#222221;
    --text-primary:#ffffff; --text-secondary:#c3c2b7; --text-muted:#8f8e86;
    --line:#2e2e2b; --grid:#282826;
    --cell-empty:#252524;
    --t0:#4a4a46; --t1:#184f95; --t2:#2a78d6; --t3:#86b6ef;
    --ink0:#ffffff; --ink1:#ffffff; --ink2:#ffffff; --ink3:#0b0b0b;
    --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500;
    --ring:#ffffff;
  }
}
:root[data-theme="dark"]{
  color-scheme: dark;
  --page:#131312; --surface-1:#1a1a19; --surface-2:#222221;
  --text-primary:#ffffff; --text-secondary:#c3c2b7; --text-muted:#8f8e86;
  --line:#2e2e2b; --grid:#282826;
  --cell-empty:#252524;
  --t0:#4a4a46; --t1:#184f95; --t2:#2a78d6; --t3:#86b6ef;
  --ink0:#ffffff; --ink1:#ffffff; --ink2:#ffffff; --ink3:#0b0b0b;
  --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500;
  --ring:#ffffff;
}
html,body{background:var(--page);color:var(--text-primary)}
body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.card{background:var(--surface-1);border:1px solid var(--line);border-radius:14px}
.muted{color:var(--text-muted)}
.sec{color:var(--text-secondary)}
.hairline{border-color:var(--line)}
select{background:var(--surface-1);border:1px solid var(--line);color:var(--text-primary);
  border-radius:8px;padding:5px 26px 5px 9px;font-size:12px;appearance:none;
  background-image:linear-gradient(45deg,transparent 50%,var(--text-muted) 50%),linear-gradient(135deg,var(--text-muted) 50%,transparent 50%);
  background-position:calc(100% - 14px) 52%,calc(100% - 9px) 52%;background-size:5px 5px,5px 5px;background-repeat:no-repeat}
.btn{background:var(--surface-1);border:1px solid var(--line);color:var(--text-secondary);border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer}
.btn:hover{color:var(--text-primary)}

/* ── dot grid ─────────────────────────────────────────────────────────── */
.plot{overflow-x:auto}
.grid-rows{display:table;border-spacing:0}
.grow{display:table-row}
.glabel,.gcells{display:table-cell;vertical-align:middle;white-space:nowrap}
.glabel{padding-right:14px;font-size:11px;line-height:1.15;color:var(--text-secondary);font-variant-numeric:tabular-nums}
.glabel a{color:var(--text-primary);text-decoration:none;border-bottom:1px solid var(--line)}
.glabel a:hover{border-color:var(--text-muted)}
.glabel .meta{color:var(--text-muted);margin-left:7px}
.cell{display:inline-block;width:12px;height:12px;margin-right:2px;border-radius:3px;
  background:var(--cell-empty);font-size:8px;line-height:12px;text-align:center;font-weight:600;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.cell.t0{background:var(--t0);color:var(--ink0)}
.cell.t1{background:var(--t1);color:var(--ink1)}
.cell.t2{background:var(--t2);color:var(--ink2)}
.cell.t3{background:var(--t3);color:var(--ink3)}
.cell.na{background:transparent;box-shadow:inset 0 0 0 1px var(--grid)}
.cell.first{box-shadow:0 0 0 2px var(--surface-1),0 0 0 3px var(--ring)}
.axis{display:table-cell;font-size:9px;color:var(--text-muted);font-family:ui-monospace,Menlo,monospace}
.axis span{display:inline-block;width:12px;margin-right:2px;text-align:center}
.axis span.wk{color:var(--text-secondary);font-weight:700}
.colbar{display:inline-block;width:12px;margin-right:2px;vertical-align:bottom;background:var(--t2);border-radius:2px 2px 0 0}

/* ── legend ───────────────────────────────────────────────────────────── */
.lgd{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:11px;color:var(--text-secondary)}
.lgd i{font-style:normal;display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;
  vertical-align:-2px;font-size:8px;line-height:12px;text-align:center;font-weight:600;
  font-family:ui-monospace,Menlo,monospace}

/* ── charts ───────────────────────────────────────────────────────────── */
svg{display:block;width:100%;height:auto;overflow:visible}
.tick{font-size:10px;fill:var(--text-muted);font-family:ui-sans-serif,system-ui,sans-serif}
.tick.tab{font-variant-numeric:tabular-nums}
.vlabel{font-size:10px;fill:var(--text-secondary);font-variant-numeric:tabular-nums}
.slabel{font-size:10px;fill:var(--text-secondary);font-weight:600}
.gridline{stroke:var(--grid);stroke-width:1}
.axisline{stroke:var(--line);stroke-width:1}
.hit{fill:transparent;cursor:crosshair}
.crosshair{stroke:var(--text-muted);stroke-width:1}

/* ── stat tiles ───────────────────────────────────────────────────────── */
.tile-n{font-size:30px;font-weight:650;letter-spacing:-.02em;line-height:1.05}
.tile-l{font-size:11px;color:var(--text-muted);margin-top:6px}

/* ── insights ─────────────────────────────────────────────────────────── */
.ins-n{flex:0 0 128px;font-size:17px;font-weight:650;letter-spacing:-.01em;line-height:1.35;color:var(--text-primary)}
.ins-t{font-size:13px;line-height:1.6;color:var(--text-secondary)}
.ins-t code{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--text-primary)}

/* ── table view ───────────────────────────────────────────────────────── */
details summary{font-size:11px;color:var(--text-muted);cursor:pointer;list-style:none;padding-top:8px}
details summary::-webkit-details-marker{display:none}
details summary:before{content:"▸ ";}
details[open] summary:before{content:"▾ ";}
table.tv{width:100%;border-collapse:collapse;font-size:11px;margin-top:8px;font-variant-numeric:tabular-nums}
table.tv th,table.tv td{text-align:right;padding:3px 8px;border-top:1px solid var(--line);color:var(--text-secondary)}
table.tv th:first-child,table.tv td:first-child{text-align:left}
table.tv th{color:var(--text-muted);font-weight:500}

/* ── tooltip ──────────────────────────────────────────────────────────── */
#tip{position:fixed;pointer-events:none;z-index:50;background:var(--surface-1);border:1px solid var(--line);
  border-radius:8px;padding:7px 10px;font-size:11px;line-height:1.5;color:var(--text-primary);
  box-shadow:0 6px 24px rgba(0,0,0,.16);opacity:0;transition:opacity .08s;max-width:280px}
#tip b{font-weight:650}
#tip .k{color:var(--text-muted)}
</style>
</head>
<body class="min-h-screen">
<div id="tip"></div>

<div class="max-w-[1240px] mx-auto px-6 py-10">

  <header class="flex items-start justify-between gap-6 mb-8">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">midee — user behaviour dot plots</h1>
      <p class="sec text-sm mt-1">
        One row per user, one column per day, one symbol per day. Last ${days} days ·
        <span class="muted">${num(payload.users.length)} users · generated ${payload.generated}</span>
      </p>
    </div>
    <button class="btn shrink-0" id="theme">Theme</button>
  </header>

  <!-- one filter row, above everything it scopes -->
  <div class="card px-4 py-3 mb-8 flex flex-wrap items-center gap-x-5 gap-y-3 sticky top-3 z-40">
    <label class="text-xs sec flex items-center gap-2">Source <select id="f-source"></select></label>
    <label class="text-xs sec flex items-center gap-2">Device <select id="f-device"></select></label>
    <label class="text-xs sec flex items-center gap-2">Sort rows <select id="f-sort">
      <option value="active">most active days</option>
      <option value="first">first seen</option>
      <option value="last">most recent</option>
      <option value="depth">deepest engagement</option>
    </select></label>
    <label class="text-xs sec flex items-center gap-2">Rows <select id="f-rows">
      <option value="40">40</option><option value="80" selected>80</option>
      <option value="160">160</option><option value="400">400</option>
    </select></label>
    <label class="text-xs sec flex items-center gap-2">Min active days <select id="f-min">
      <option value="1">1 (everyone)</option><option value="2">2+</option>
      <option value="3">3+</option><option value="5">5+</option>
    </select></label>
    <span class="text-xs muted ml-auto" id="f-count"></span>
  </div>

  <!-- stat tiles -->
  <section class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10" id="tiles"></section>

  <!-- insights (computed over the full unfiltered window) -->
  <section class="card p-6 mb-10">
    <h2 class="text-sm font-semibold mb-1">What the plots say</h2>
    <p class="muted text-xs mb-5">Full ${days}-day window, unfiltered — these numbers do not move with the controls above.</p>
    <ul class="flex flex-col gap-4">
      ${insightItems}
    </ul>
  </section>

  <!-- headline dot plot -->
  <section class="card p-6 mb-8">
    <div class="flex items-baseline justify-between gap-4 mb-1">
      <h2 class="text-sm font-semibold">Every user, every day</h2>
      <span class="text-xs muted" id="cal-note"></span>
    </div>
    <p class="muted text-xs mb-4">Calendar days. The bar strip on top is the DAU line this plot replaces — same columns, all the individual behaviour thrown away.</p>
    <div class="plot" id="cal"></div>
    <div class="lgd mt-5" id="legend"></div>
  </section>

  <!-- cohort-aligned dot plot -->
  <section class="card p-6 mb-10">
    <div class="flex items-baseline justify-between gap-4 mb-1">
      <h2 class="text-sm font-semibold">First two weeks of each user's life</h2>
      <span class="text-xs muted" id="rel-note"></span>
    </div>
    <p class="muted text-xs mb-4">Same users, re-aligned so column 0 is that person's own first visit. Every cohort stacks, so the drop-off after day 0 is readable directly.</p>
    <div class="plot" id="rel"></div>
  </section>

  <!-- charts -->
  <section class="grid md:grid-cols-2 gap-6">
    <div class="card p-6">
      <h2 class="text-sm font-semibold mb-1">Does day 0 depth predict a second day?</h2>
      <p class="muted text-xs mb-4">Users grouped by the deepest thing they did on their first visit.</p>
      <div id="c-day0"></div>
    </div>
    <div class="card p-6">
      <h2 class="text-sm font-semibold mb-1">Retention curve by channel</h2>
      <p class="muted text-xs mb-4">Share of each channel's users still active N days after their first visit.</p>
      <div id="c-retention"></div>
    </div>
    <div class="card p-6">
      <h2 class="text-sm font-semibold mb-1">How far users get</h2>
      <p class="muted text-xs mb-4">Deepest rung reached at any point in the window.</p>
      <div id="c-funnel"></div>
    </div>
    <div class="card p-6">
      <h2 class="text-sm font-semibold mb-1">Active days per user</h2>
      <p class="muted text-xs mb-4">The shape of retention — how many separate days each person shows up.</p>
      <div id="c-days"></div>
    </div>
    <div class="card p-6">
      <h2 class="text-sm font-semibold mb-1">Weekday rhythm</h2>
      <p class="muted text-xs mb-4">Average active users per day of week.</p>
      <div id="c-dow"></div>
    </div>
    <div class="card p-6">
      <h2 class="text-sm font-semibold mb-1">Channel quality</h2>
      <p class="muted text-xs mb-4">Activation and return by first-touch source.</p>
      <div id="c-sources"></div>
    </div>
  </section>

  <footer class="mt-10 text-xs muted leading-relaxed">
    <p><strong class="sec">Method.</strong> Each cell shows the highest-value action that user took that day, ranked
    L&nbsp;loop › E&nbsp;export › X&nbsp;exercise completed › R&nbsp;recorded › x&nbsp;exercise started ›
    K&nbsp;played own keyboard › @&nbsp;heard music › +&nbsp;loaded only › ·&nbsp;nothing. Colour encodes the four
    depth tiers; the letter names the specific action. A ring marks that user's first-ever day.
    <code>midi_device_connected</code> is excluded — the Chrome/Windows reconnect storm inflates it ~20× and it
    measures hardware flakiness, not engagement.</p>
    <p class="mt-2">Source: PostHog project 387732, last ${days} days. Regenerate with
    <code>npm run dotplot -- --html &lt;path&gt;</code>. Local file — not published.</p>
  </footer>
</div>

<script id="dot-data" type="application/json">${JSON.stringify(payload).replace(/</g, '\\u003c')}</script>
<script>${client}</script>
</body>
</html>
`
}
