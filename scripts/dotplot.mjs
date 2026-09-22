#!/usr/bin/env node
// Dot plot: one row per user, one column per day, one symbol per day-cell.
//
// Why: aggregate charts (DAU/MAU) hide what any individual user actually does.
// A dot plot keeps every user visible so patterns (weekday-only listeners,
// one-and-done bouncers, "did feature X then stuck around") pop out visually.
//
// Gotcha: PostHog silently caps a HogQL result at 100 rows unless the query
// carries an explicit LIMIT — hence the LIMIT 200000 on both queries below.
//
// Data comes from PostHog via `posthog-cli` (see docs/POSTHOG_CLI_PLAYBOOK_2026-05-10.md
// for auth/env details). Two queries: person-day activity, and per-person meta
// (first-touch source, device). Everything else is rendering.
//
// The symbol for a day is the HIGHEST-VALUE thing the user did that day, per
// LADDER below. That is deliberate: charting "opened the app" makes the plot
// look busy and tells you nothing. Charting real value events tells you whether
// people are getting anything out of midee.
//
// Usage:
//   node scripts/dotplot.mjs                      # 30d, users with >=2 active days
//   node scripts/dotplot.mjs --days 60 --min-days 1 --limit 120
//   node scripts/dotplot.mjs --relative           # columns = days since first visit
//   node scripts/dotplot.mjs --source ChatGPT     # segment by first-touch source
//   node scripts/dotplot.mjs --device mobile --sort first
//   node scripts/dotplot.mjs --html /tmp/midee/dotplot.html   # multi-panel report
//   node scripts/dotplot.mjs --csv /tmp/midee/dotplot.csv
//
// --source/--device/--min-days/--limit shape the TERMINAL view only. The HTML
// report always embeds every user in the window and filters client-side.

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { buildReport } from './dotplot-report.mjs'

const CLI = `${process.env.HOME}/.posthog/posthog-cli`

// Highest-value first. `key` is the column name in the activity query; `tier` is
// the ordinal depth of engagement used for colour (0 = showed up, 3 = made
// something). Keep this list short — a legend nobody can hold in their head
// defeats the point.
export const LADDER = [
  { key: 'loops', sym: 'L', tier: 3, label: 'looped (layered/recorded a loop)' },
  { key: 'exports', sym: 'E', tier: 3, label: 'exported a video' },
  { key: 'done', sym: 'X', tier: 3, label: 'completed an exercise' },
  { key: 'recs', sym: 'R', tier: 3, label: 'recorded a performance' },
  { key: 'exer', sym: 'x', tier: 2, label: 'started an exercise' },
  { key: 'live', sym: 'K', tier: 2, label: 'played their own keyboard' },
  { key: 'heard', sym: '@', tier: 1, label: 'heard music play through' },
  { key: 'loaded', sym: '+', tier: 1, label: 'loaded a MIDI but never played it' },
  { key: 'events', sym: '.', tier: 0, label: 'showed up, got no value' },
]

const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? dflt : argv[i + 1]
}
const has = (name) => argv.includes(`--${name}`)

const DAYS = Number(flag('days', 30))
const MIN_DAYS = Number(flag('min-days', 2))
const LIMIT = Number(flag('limit', 80))
const SORT = flag('sort', 'active') // active | first | last
const SOURCE = flag('source', null)
const DEVICE = flag('device', null)

function query(sql) {
  const out = execFileSync(CLI, ['exp', 'query', 'run', sql], {
    stdio: ['ignore', 'pipe', process.env.DP_DEBUG ? 'inherit' : 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  }).toString()
  return out
    .split('\n')
    .filter((l) => l.startsWith('['))
    .map((l) => JSON.parse(l))
}

// ── queries ────────────────────────────────────────────────────────────────
// Note: midi_device_connected is deliberately NOT a value event — the
// Chrome/Windows reconnect storm inflates it 20x (docs/POSTHOG_ANALYSIS_2026-05-22.md).
const activitySql = `
SELECT toString(person_id) AS pid, toDate(timestamp) AS day,
  countIf(event IN ('loop_recorded','loop_saved','loop_layer_added')) AS loops,
  countIf(event = 'export_completed') AS exports,
  countIf(event = 'exercise_completed') AS done,
  countIf(event = 'session_recorded') AS recs,
  countIf(event = 'exercise_started') AS exer,
  countIf(event IN ('first_live_note','pedal_used')) AS live,
  countIf(event IN ('playback_milestone','first_play')) AS heard,
  countIf(event = 'midi_loaded') AS loaded,
  count() AS events
FROM events
WHERE timestamp > now() - INTERVAL ${DAYS} DAY AND person_id IS NOT NULL
GROUP BY pid, day
LIMIT 200000`

const metaSql = `
WITH ft AS (
  SELECT person_id,
    argMin(properties.$referring_domain, timestamp) AS dom,
    argMin(properties.utm_source, timestamp) AS utm,
    argMin(properties.$device_type, timestamp) AS device,
    argMin(properties.$geoip_country_code, timestamp) AS country,
    any(distinct_id) AS did,
    min(toDate(timestamp)) AS first_day
  FROM events
  WHERE timestamp > now() - INTERVAL ${DAYS} DAY AND person_id IS NOT NULL
  GROUP BY person_id
)
SELECT toString(person_id) AS pid, did, first_day, lower(device) AS device, country,
  multiIf(
    dom IN ('www.reddit.com','old.reddit.com','com.reddit.frontpage','reddit.com'), 'Reddit',
    dom = 'chatgpt.com' OR utm = 'chatgpt.com' OR utm = 'chatgpt', 'ChatGPT',
    dom = 'gemini.google.com', 'Gemini',
    dom = 'www.perplexity.ai', 'Perplexity',
    dom LIKE '%bing.com', 'Bing',
    dom LIKE '%google.com', 'Google',
    dom = 'github.com', 'GitHub',
    dom IN ('t.co','x.com','twitter.com'), 'Twitter',
    dom = '$direct' OR dom IS NULL OR dom = '', 'Direct',
    'Other') AS source
FROM ft
LIMIT 200000`

const activity = query(activitySql)
const meta = query(metaSql)

// ── shape ──────────────────────────────────────────────────────────────────
const people = new Map() // pid -> { pid, did, first, source, device, country, days: Map<day, sym> }
for (const [pid, did, first, device, country, source] of meta) {
  people.set(pid, {
    pid,
    did,
    first,
    source,
    device: device || '?',
    country: country || '??',
    days: new Map(),
  })
}

const idx = Object.fromEntries(LADDER.map((r, i) => [r.key, i]))
const COLS = ['pid', 'day', ...LADDER.map((r) => r.key)]
for (const row of activity) {
  const rec = Object.fromEntries(COLS.map((c, i) => [c, row[i]]))
  const p = people.get(rec.pid)
  if (!p) continue
  const hit = LADDER.find((r) => Number(rec[r.key]) > 0)
  if (hit) p.days.set(rec.day, hit.sym)
}

// Calendar columns, oldest → newest. Captured before any --relative rebasing so
// the HTML report always gets real dates.
const calendarDays = [...new Set(activity.map((r) => r[1]))].sort()

// ── HTML report (full population, filtered in-page) ────────────────────────
const htmlPath = flag('html', null)
if (htmlPath) {
  writeFileSync(
    htmlPath,
    buildReport({ people: [...people.values()], calendarDays, ladder: LADDER, days: DAYS }),
  )
  console.log(`html → ${htmlPath}`)
}

// Columns for the terminal view. Calendar mode: real dates, so weekday/weekend
// rhythms are visible. Relative mode (--relative): days since that user's OWN
// first visit, which stacks every cohort and makes the activation drop-off and
// "day 1 return" question readable in one glance.
const RELATIVE = has('relative')
const dayNum = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86400000)
let allDays = calendarDays
if (RELATIVE) {
  let maxOffset = 0
  for (const p of people.values()) {
    const rebased = new Map()
    for (const [d, sym] of p.days) {
      const off = dayNum(d) - dayNum(p.first)
      rebased.set(String(off), sym)
      if (off > maxOffset) maxOffset = off
    }
    p.days = rebased
    p.cohort = p.first // keep the real first date so --sort first still means "by cohort"
    p.first = '0'
  }
  allDays = Array.from({ length: maxOffset + 1 }, (_, i) => String(i))
}

let rows = [...people.values()].filter((p) => p.days.size >= MIN_DAYS)
if (SOURCE) rows = rows.filter((p) => p.source.toLowerCase() === SOURCE.toLowerCase())
if (DEVICE) rows = rows.filter((p) => p.device === DEVICE.toLowerCase())

const lastDay = (p) => [...p.days.keys()].sort().at(-1) ?? ''
const depth = (p) => Math.min(...[...p.days.values()].map((s) => idx[LADDER.find((r) => r.sym === s).key]))
rows.sort((a, b) => {
  if (SORT === 'first') {
    const [af, bf] = [a.cohort ?? a.first, b.cohort ?? b.first]
    return af.localeCompare(bf) || b.days.size - a.days.size
  }
  if (SORT === 'last') return lastDay(b).localeCompare(lastDay(a))
  return b.days.size - a.days.size || depth(a) - depth(b)
})
const shown = rows.slice(0, LIMIT)

// ── terminal render ────────────────────────────────────────────────────────
const DOW = 'SMTWTFS'
const dowOf = (d) => DOW[new Date(`${d}T00:00:00Z`).getUTCDay()]
const pad = (s, n) => String(s).padEnd(n).slice(0, n)

const label = (p) => `${pad(p.did.slice(0, 8), 8)} ${pad(p.source, 10)} ${pad(p.device, 7)} ${p.country}`
const gutter = 8 + 1 + 10 + 1 + 7 + 1 + 2

console.log(
  `\nmidee dot plot — ${DAYS}d · ${shown.length}/${rows.length} users (>=${MIN_DAYS} active days)` +
    `${SOURCE ? ` · source=${SOURCE}` : ''}${DEVICE ? ` · device=${DEVICE}` : ''}\n`,
)
if (RELATIVE) {
  console.log(
    `${' '.repeat(gutter)}${allDays.map((d) => (Number(d) % 7 === 0 ? '|' : ' ')).join('')}  (| = week boundary, col 0 = first visit)`,
  )
} else {
  console.log(`${' '.repeat(gutter)}${allDays.map((d) => dowOf(d)).join('')}`)
  console.log(`${' '.repeat(gutter)}${allDays.map((d) => (d.endsWith('01') ? '|' : ' ')).join('')}  (| = 1st of month)`)
}
for (const p of shown) {
  const cells = allDays.map((d) => {
    const s = p.days.get(d)
    if (!s) return p.first === d ? 'o' : ' '
    return p.first === d ? `\x1b[7m${s}\x1b[0m` : s
  })
  console.log(`${label(p)}  ${cells.join('')}`)
}
console.log(`\nlegend (highest-value action that day wins):`)
for (const r of LADDER) console.log(`  ${r.sym}  ${r.label}`)
console.log(`  inverse video = that user's first-ever day (their onboarding day)\n`)

// per-column totals: the DAU line the dot plot replaces
const dau = allDays.map((d) => shown.filter((p) => p.days.has(d)).length)
console.log(
  RELATIVE
    ? `users still active on day 0,1,2…: ${dau.join(' ')}\n`
    : `DAU across these users: ${dau.join(' ')}\n`,
)

// ── csv ────────────────────────────────────────────────────────────────────
const csvPath = flag('csv', null)
if (csvPath) {
  const lines = [['distinct_id', 'source', 'device', 'country', 'first_day', ...allDays].join(',')]
  for (const p of shown) {
    lines.push(
      [p.did, p.source, p.device, p.country, p.cohort ?? p.first, ...allDays.map((d) => p.days.get(d) ?? '')].join(','),
    )
  }
  writeFileSync(csvPath, `${lines.join('\n')}\n`)
  console.log(`csv → ${csvPath}`)
}
