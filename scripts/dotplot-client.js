/* Browser half of the dot-plot report. Inlined verbatim by dotplot-report.mjs.
 *
 * Everything is derived in-page from one embedded payload, so the filter row
 * rescopes every panel without another PostHog query.
 *
 * Conventions kept from the data-viz method: ordinal ramp (t0..t3) for depth of
 * engagement, categorical slots s1..s4 in fixed order for channels, thin marks,
 * 2px gaps between fills, hairline grid, selective direct labels, a tooltip on
 * every mark, and a table view under every chart.
 */
;(() => {
  const D = JSON.parse(document.getElementById('dot-data').textContent)
  const DAYS = D.days
  const LAST = DAYS.length - 1
  const TIER = {}
  const LABEL = {}
  for (const l of D.ladder) {
    TIER[l.sym] = l.tier
    LABEL[l.sym] = l.label
  }
  const TIER_NAME = ['showed up, no value', 'listened', 'played / practised', 'made something']

  const USERS = D.users.map(([did, source, device, country, firstIdx, syms]) => {
    let active = 0
    let maxTier = -1
    let lastIdx = -1
    for (let i = 0; i < syms.length; i++) {
      const c = syms[i]
      if (c === ' ') continue
      active++
      lastIdx = i
      if (TIER[c] > maxTier) maxTier = TIER[c]
    }
    return {
      did,
      source,
      device,
      country,
      firstIdx,
      syms,
      active,
      maxTier,
      lastIdx,
      day0: firstIdx >= 0 && syms[firstIdx] !== ' ' ? TIER[syms[firstIdx]] : -1,
    }
  })

  const state = { source: 'all', device: 'all', sort: 'active', rows: 80, min: 1 }

  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0)
  const fmt = (n) => n.toLocaleString('en-US')
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const dowOf = (d) => new Date(d + 'T00:00:00Z').getUTCDay()
  const dateLabel = (d) => DOW[dowOf(d)] + ' ' + d.slice(5)

  // ── filters ───────────────────────────────────────────────────────────────
  const sourcesByVolume = [...new Set(USERS.map((u) => u.source))].sort(
    (a, b) => USERS.filter((u) => u.source === b).length - USERS.filter((u) => u.source === a).length,
  )
  const devices = [...new Set(USERS.map((u) => u.device))].filter((d) => d && d !== '?')

  function fill(sel, values, allLabel) {
    sel.innerHTML =
      `<option value="all">${allLabel}</option>` +
      values
        .map((v) => `<option value="${esc(v)}">${esc(v)} (${fmt(USERS.filter((u) => u[sel.dataset.key] === v).length)})</option>`)
        .join('')
  }
  const elSource = document.getElementById('f-source')
  const elDevice = document.getElementById('f-device')
  elSource.dataset.key = 'source'
  elDevice.dataset.key = 'device'
  fill(elSource, sourcesByVolume, 'all channels')
  fill(elDevice, devices, 'all devices')

  function selected() {
    let out = USERS
    if (state.source !== 'all') out = out.filter((u) => u.source === state.source)
    if (state.device !== 'all') out = out.filter((u) => u.device === state.device)
    if (state.min > 1) out = out.filter((u) => u.active >= state.min)
    return out
  }

  const sorters = {
    active: (a, b) => b.active - a.active || b.maxTier - a.maxTier,
    first: (a, b) => a.firstIdx - b.firstIdx || b.active - a.active,
    last: (a, b) => b.lastIdx - a.lastIdx || b.active - a.active,
    depth: (a, b) => b.maxTier - a.maxTier || b.active - a.active,
  }

  // ── svg helpers ───────────────────────────────────────────────────────────
  const R = 4
  const barH = (x, y, w, h, r = R) => {
    r = Math.max(0, Math.min(r, w, h / 2))
    return `M${x},${y} H${x + w - r} A${r},${r} 0 0 1 ${x + w},${y + r} V${y + h - r} A${r},${r} 0 0 1 ${x + w - r},${y + h} H${x} Z`
  }
  const barV = (x, yTop, w, h, r = R) => {
    r = Math.max(0, Math.min(r, h, w / 2))
    return `M${x},${yTop + h} V${yTop + r} A${r},${r} 0 0 1 ${x + r},${yTop} H${x + w - r} A${r},${r} 0 0 1 ${x + w},${yTop + r} V${yTop + h} Z`
  }
  const tip = (s) => `data-tip="${esc(s)}"`

  // Round an axis max up to a 1/2/2.5/5 × 10^n step so ticks are readable
  // numbers rather than quarters of whatever the data happened to peak at.
  function niceMax(v) {
    if (v <= 4) return 4
    const mag = 10 ** Math.floor(Math.log10(v))
    for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (v <= m * mag) return m * mag
    return 10 * mag
  }

  // Tick values that a person would actually write down: pick the divisor that
  // makes every gridline land on a whole number.
  function ticksFor(max) {
    const n = [4, 3, 5, 2].find((d) => Number.isInteger(max / d)) ?? 4
    return Array.from({ length: n + 1 }, (_, i) => (max / n) * i)
  }

  function tableView(cols, rows) {
    return (
      '<details><summary>Table view</summary><table class="tv"><thead><tr>' +
      cols.map((c) => `<th>${esc(c)}</th>`).join('') +
      '</tr></thead><tbody>' +
      rows.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') +
      '</tbody></table></details>'
    )
  }

  // ── dot plots ─────────────────────────────────────────────────────────────
  function cellHtml(u, i, opts) {
    const c = u.syms[i]
    const first = i === u.firstIdx ? ' first' : ''
    if (opts && opts.na) return '<i class="cell na"></i>'
    if (c === ' ') {
      return `<i class="cell${first}" ${tip(`${esc(u.did.slice(0, 8))} · ${opts.label} · not active`)}></i>`
    }
    return `<i class="cell t${TIER[c]}${first}" ${tip(`${esc(u.did.slice(0, 8))} · ${opts.label} · ${LABEL[c]}`)}>${c === '.' ? '' : esc(c)}</i>`
  }

  function rowLabel(u) {
    return (
      `<a href="https://us.posthog.com/project/387732/person/${esc(u.did)}" target="_blank" rel="noreferrer">${esc(u.did.slice(0, 8))}</a>` +
      `<span class="meta">${esc(u.source)} · ${esc(u.device)} · ${esc(u.country)}</span>`
    )
  }

  function renderCalendar(all, shown) {
    const perDay = DAYS.map((_, i) => all.filter((u) => u.syms[i] !== ' ').length)
    const peak = Math.max(1, ...perDay)
    const strip = DAYS.map((d, i) => {
      const h = Math.max(1, Math.round((perDay[i] / peak) * 26))
      return `<i class="colbar" style="height:${h}px" ${tip(`${dateLabel(d)} · ${fmt(perDay[i])} active users`)}></i>`
    }).join('')

    const axis = DAYS.map((d) => {
      const w = dowOf(d)
      return `<span class="${w === 1 ? 'wk' : ''}">${'SMTWTFS'[w]}</span>`
    }).join('')

    const rows = shown
      .map(
        (u) =>
          `<div class="grow"><div class="glabel">${rowLabel(u)}</div><div class="gcells">` +
          DAYS.map((d, i) => cellHtml(u, i, { label: dateLabel(d) })).join('') +
          '</div></div>',
      )
      .join('')

    document.getElementById('cal').innerHTML =
      '<div class="grid-rows">' +
      `<div class="grow"><div class="glabel muted" style="font-size:10px">peak ${fmt(peak)} users</div>` +
      `<div class="gcells" style="height:30px;vertical-align:bottom">${strip}</div></div>` +
      `<div class="grow"><div class="glabel"></div><div class="axis">${axis}</div></div>` +
      rows +
      '</div>'

    document.getElementById('cal-note').textContent =
      `${fmt(shown.length)} of ${fmt(all.length)} rows · bars cover all ${fmt(all.length)}`
  }

  const REL_LEN = 14
  function renderRelative(all) {
    // Only users whose full first 14 days fall inside the window: everyone on
    // this panel had the same chance to come back, so the rows are comparable
    // and there are no "not reached yet" gaps to misread as absence.
    const observable = all.filter((u) => u.firstIdx + REL_LEN - 1 <= LAST)
    const pool = observable.length >= 10 ? observable : all
    const shown = [...pool].sort(sorters[state.sort]).slice(0, state.rows)

    const rows = shown
      .map((u) => {
        const cells = []
        for (let k = 0; k < REL_LEN; k++) {
          const i = u.firstIdx + k
          if (i > LAST) cells.push('<i class="cell na" ' + tip('day ' + k + ' · not reached yet') + '></i>')
          else cells.push(cellHtml(u, i, { label: 'day ' + k + ' (' + dateLabel(DAYS[i]) + ')' }))
        }
        return `<div class="grow"><div class="glabel">${rowLabel(u)}</div><div class="gcells">${cells.join('')}</div></div>`
      })
      .join('')

    const axis = Array.from(
      { length: REL_LEN },
      (_, k) => `<span class="${k === 0 || k === 7 ? 'wk' : ''}">${k % 7 === 0 ? k : '·'}</span>`,
    ).join('')

    document.getElementById('rel').innerHTML =
      '<div class="grid-rows">' +
      `<div class="grow"><div class="glabel muted" style="font-size:10px">day since first visit</div><div class="axis">${axis}</div></div>` +
      rows +
      '</div>'

    document.getElementById('rel-note').textContent =
      pool === observable
        ? `${fmt(shown.length)} of ${fmt(observable.length)} users with a full 14 days observed`
        : `${fmt(shown.length)} rows · too few users have 14 full days, showing everyone`
  }

  function renderLegend() {
    const groups = [3, 2, 1, 0].map((t) => {
      const syms = D.ladder.filter((l) => l.tier === t)
      return (
        `<div style="display:flex;align-items:baseline;gap:8px">` +
        `<span style="color:var(--text-muted);min-width:104px;display:inline-block">${TIER_NAME[t]}</span>` +
        syms
          .map(
            (l) =>
              `<span style="margin-right:12px"><i class="t${t}" style="background:var(--t${t});color:var(--ink${t})">${l.sym === '.' ? '' : esc(l.sym)}</i>${esc(l.label.replace(/ \(.*\)/, ''))}</span>`,
          )
          .join('') +
        '</div>'
      )
    })
    document.getElementById('legend').innerHTML =
      groups.join('') +
      '<div style="display:flex;align-items:baseline;gap:8px"><span style="color:var(--text-muted);min-width:104px;display:inline-block">first-ever day</span>' +
      '<span><i class="t2" style="background:var(--t2);box-shadow:0 0 0 2px var(--surface-1),0 0 0 3px var(--ring);margin-left:2px"></i> ringed cell</span></div>'
  }

  // ── charts ────────────────────────────────────────────────────────────────
  function renderDay0(us) {
    const eligible = us.filter((u) => u.firstIdx < LAST)
    const data = [0, 1, 2, 3].map((t) => {
      const g = eligible.filter((u) => u.day0 === t)
      return { t, n: g.length, ret: g.filter((u) => u.active >= 2).length }
    })
    const W = 560
    const rowH = 44
    const H = data.length * rowH + 26
    const x0 = 108
    const maxPct = niceMax(Math.max(10, ...data.map((d) => pct(d.ret, d.n))))
    const scale = (p) => ((W - x0 - 62) * p) / maxPct

    let s = `<svg viewBox="0 0 ${W} ${H}">`
    for (const p of ticksFor(maxPct)) {
      const x = x0 + scale(p)
      s += `<line class="gridline" x1="${x}" y1="6" x2="${x}" y2="${H - 22}"/>`
      s += `<text class="tick tab" x="${x}" y="${H - 8}" text-anchor="middle">${Math.round(p)}%</text>`
    }
    data.forEach((d, i) => {
      const y = 10 + i * rowH
      const p = pct(d.ret, d.n)
      const w = Math.max(2, scale(p))
      s += `<text class="vlabel" x="${x0 - 10}" y="${y + 16}" text-anchor="end">${TIER_NAME[d.t]}</text>`
      s += `<path d="${barH(x0, y, w, 20)}" fill="var(--t${d.t})" ${tip(`${TIER_NAME[d.t]} on day 0 · ${fmt(d.ret)} of ${fmt(d.n)} came back (${p}%)`)}/>`
      s += `<text class="vlabel" x="${x0 + w + 8}" y="${y + 15}">${p}%<tspan class="tick"> · n=${fmt(d.n)}</tspan></text>`
    })
    s += '</svg>'
    document.getElementById('c-day0').innerHTML =
      s +
      tableView(
        ['deepest action on day 0', 'users', 'returned', 'rate'],
        data.map((d) => [TIER_NAME[d.t], fmt(d.n), fmt(d.ret), pct(d.ret, d.n) + '%']),
      )
  }

  function renderRetention(us) {
    const counts = {}
    for (const u of us) counts[u.source] = (counts[u.source] || 0) + 1
    let names = Object.keys(counts).sort((a, b) => counts[b] - counts[a])
    const top = names.slice(0, 3)
    const rest = names.slice(3)
    const series = top.map((n) => ({ name: n, users: us.filter((u) => u.source === n) }))
    if (rest.length) series.push({ name: 'Other', users: us.filter((u) => rest.includes(u.source)) })
    const active = series.filter((s) => s.users.length >= 20)
    if (!active.length) {
      document.getElementById('c-retention').innerHTML =
        '<p class="muted text-xs py-8">Not enough users in this slice to draw a retention curve.</p>'
      return
    }

    // Day 0 is 100% by construction, so plotting it would spend the whole
    // y-range on a constant. The curve starts at day 1 — the first real number.
    const K0 = 1
    const KN = 13
    for (const s of active) {
      s.pts = []
      for (let k = K0; k <= KN; k++) {
        const elig = s.users.filter((u) => u.firstIdx + k <= LAST)
        const on = elig.filter((u) => u.syms[u.firstIdx + k] !== ' ').length
        s.pts.push({ k, n: elig.length, on, p: pct(on, elig.length) })
      }
    }

    const W = 560
    const H = 240
    const L = 34
    const Rr = 14
    const T = 10
    const B = 34
    const maxP = niceMax(Math.max(4, ...active.flatMap((s) => s.pts.map((p) => p.p))))
    const X = (k) => L + ((W - L - Rr) * (k - K0)) / (KN - K0)
    const Y = (p) => T + (H - T - B) * (1 - p / maxP)

    let s = `<svg viewBox="0 0 ${W} ${H}">`
    for (const p of ticksFor(maxP)) {
      s += `<line class="gridline" x1="${L}" y1="${Y(p)}" x2="${W - Rr}" y2="${Y(p)}"/>`
      s += `<text class="tick tab" x="${L - 6}" y="${Y(p) + 3}" text-anchor="end">${Math.round(p)}%</text>`
    }
    s += `<line class="axisline" x1="${L}" y1="${Y(0)}" x2="${W - Rr}" y2="${Y(0)}"/>`
    for (let k = K0; k <= KN; k += 2)
      s += `<text class="tick tab" x="${X(k)}" y="${H - 16}" text-anchor="middle">${k}</text>`
    s += `<text class="tick" x="${(L + W - Rr) / 2}" y="${H - 2}" text-anchor="middle">days after first visit</text>`

    // The curves converge to 1–3% by day 13, so end-of-line labels would sit on
    // top of each other. Identity moves to a legend above the plot instead; the
    // one direct label goes on the series that peaks highest on day 1.
    const leader = active.reduce((a, b) => (b.pts[0].p > a.pts[0].p ? b : a))
    active.forEach((se, i) => {
      const col = `var(--s${i + 1})`
      const d = se.pts.map((p, k) => `${k ? 'L' : 'M'}${X(p.k)},${Y(p.p)}`).join(' ')
      s += `<path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
      const end = se.pts[se.pts.length - 1]
      s += `<circle cx="${X(end.k)}" cy="${Y(end.p)}" r="3.5" fill="${col}" stroke="var(--surface-1)" stroke-width="2"/>`
      if (se === leader)
        s += `<text class="slabel" x="${X(se.pts[0].k) + 8}" y="${Y(se.pts[0].p) - 6}" fill="${col}">${esc(se.name)} ${se.pts[0].p}%</text>`
    })

    // hover bands (hit targets wider than the marks)
    const bw = (W - L - Rr) / (KN - K0)
    for (let k = K0; k <= KN; k++) {
      const rows = active
        .map((se) => `<span class="k">${esc(se.name)}</span> ${se.pts[k - K0].p}%`)
        .join(' · ')
      s += `<rect class="hit" x="${X(k) - bw / 2}" y="${T}" width="${bw}" height="${H - T - B}" data-x="${k}" ${tip(`Day ${k} after first visit — ${rows}`)}/>`
    }
    s += `<line class="crosshair" id="xh" x1="0" y1="${T}" x2="0" y2="${H - B}" opacity="0"/>`
    s += '</svg>'

    const legend = active
      .map(
        (se, i) =>
          `<span style="display:inline-flex;align-items:center;gap:6px;margin-right:16px">` +
          `<span style="width:10px;height:2px;background:var(--s${i + 1});border-radius:1px"></span>` +
          `${esc(se.name)} <span class="muted">n=${fmt(se.users.length)}</span></span>`,
      )
      .join('')

    document.getElementById('c-retention').innerHTML =
      `<div class="text-xs sec mb-2" style="display:flex;flex-wrap:wrap">${legend}</div>` +
      s +
      `<p class="muted text-xs mt-2">Day 0 is 100% for everyone by construction and is left off. Denominators only count users old enough to have reached that day.</p>` +
      tableView(
        ['day', ...active.map((se) => se.name)],
        Array.from({ length: KN - K0 + 1 }, (_, i) => [i + K0, ...active.map((se) => se.pts[i].p + '%')]),
      )

    const svg = document.querySelector('#c-retention svg')
    const xh = svg.querySelector('#xh')
    svg.addEventListener('pointerover', (e) => {
      const b = e.target.closest('[data-x]')
      if (!b) return
      const k = +b.dataset.x
      xh.setAttribute('x1', X(k))
      xh.setAttribute('x2', X(k))
      xh.setAttribute('opacity', '.5')
    })
    svg.addEventListener('pointerleave', () => xh.setAttribute('opacity', '0'))
  }

  function renderFunnel(us) {
    const stages = [
      { t: 0, name: 'showed up', n: us.length },
      { t: 1, name: 'heard music', n: us.filter((u) => u.maxTier >= 1).length },
      { t: 2, name: 'played / practised', n: us.filter((u) => u.maxTier >= 2).length },
      { t: 3, name: 'made something', n: us.filter((u) => u.maxTier >= 3).length },
    ]
    const W = 560
    const rowH = 44
    const H = stages.length * rowH + 26
    const x0 = 108
    const scale = (n) => ((W - x0 - 78) * n) / Math.max(1, us.length)

    let s = `<svg viewBox="0 0 ${W} ${H}">`
    for (let g = 0; g <= 4; g++) {
      const x = x0 + scale((us.length / 4) * g)
      s += `<line class="gridline" x1="${x}" y1="6" x2="${x}" y2="${H - 22}"/>`
      s += `<text class="tick tab" x="${x}" y="${H - 8}" text-anchor="middle">${g * 25}%</text>`
    }
    stages.forEach((st, i) => {
      const y = 10 + i * rowH
      const w = Math.max(2, scale(st.n))
      const p = pct(st.n, us.length)
      const drop = i ? pct(stages[i - 1].n - st.n, stages[i - 1].n) : 0
      s += `<text class="vlabel" x="${x0 - 10}" y="${y + 16}" text-anchor="end">${st.name}</text>`
      s += `<path d="${barH(x0, y, w, 20)}" fill="var(--t${st.t})" ${tip(`${st.name} · ${fmt(st.n)} users (${p}%)${i ? ` · ${drop}% lost from the previous rung` : ''}`)}/>`
      s += `<text class="vlabel" x="${x0 + w + 8}" y="${y + 15}">${fmt(st.n)}<tspan class="tick"> · ${p}%</tspan></text>`
      if (i)
        s += `<text class="tick" x="${x0 + w + 8}" y="${y + 27}" fill="var(--text-muted)">−${drop}%</text>`
    })
    s += '</svg>'
    document.getElementById('c-funnel').innerHTML =
      s +
      tableView(
        ['rung', 'users', 'share'],
        stages.map((st) => [st.name, fmt(st.n), pct(st.n, us.length) + '%']),
      )
  }

  function renderDaysHist(us) {
    // One-and-done users outnumber everyone else ~8:1; leaving them in gives a
    // single bar and seven slivers. They get a caption instead, and the chart
    // shows the shape of the people who actually came back.
    const once = us.filter((u) => u.active === 1).length
    const returners = us.filter((u) => u.active >= 2)
    const buckets = [
      { label: '2', test: (a) => a === 2 },
      { label: '3', test: (a) => a === 3 },
      { label: '4', test: (a) => a === 4 },
      { label: '5', test: (a) => a === 5 },
      { label: '6–7', test: (a) => a >= 6 && a <= 7 },
      { label: '8–14', test: (a) => a >= 8 && a <= 14 },
      { label: '15+', test: (a) => a >= 15 },
    ].map((b) => ({ ...b, n: returners.filter((u) => b.test(u.active)).length }))

    const W = 560
    const H = 220
    const L = 42
    const T = 12
    const B = 34
    const max = niceMax(Math.max(1, ...buckets.map((b) => b.n)))
    const bw = (W - L - 12) / buckets.length
    const Y = (n) => T + (H - T - B) * (1 - n / max)

    let s = `<svg viewBox="0 0 ${W} ${H}">`
    for (const v of ticksFor(max)) {
      s += `<line class="gridline" x1="${L}" y1="${Y(v)}" x2="${W - 12}" y2="${Y(v)}"/>`
      s += `<text class="tick tab" x="${L - 6}" y="${Y(v) + 3}" text-anchor="end">${fmt(Math.round(v))}</text>`
    }
    buckets.forEach((b, i) => {
      const x = L + i * bw + 1
      const w = bw - 2 // 2px surface gap between adjacent bars
      const h = Math.max(1, Y(0) - Y(b.n))
      s += `<path d="${barV(x, Y(b.n), w, h)}" fill="var(--s1)" ${tip(`${b.label} active days · ${fmt(b.n)} users · ${pct(b.n, us.length)}% of everyone, ${pct(b.n, returners.length)}% of returners`)}/>`
      s += `<text class="tick" x="${x + w / 2}" y="${H - 16}" text-anchor="middle">${b.label}</text>`
      if (b.n && (i === 0 || b.n === Math.max(...buckets.map((z) => z.n))))
        s += `<text class="vlabel" x="${x + w / 2}" y="${Y(b.n) - 6}" text-anchor="middle">${fmt(b.n)}</text>`
    })
    s += `<text class="tick" x="${(L + W) / 2}" y="${H - 2}" text-anchor="middle">active days in window</text>`
    s += '</svg>'
    document.getElementById('c-days').innerHTML =
      `<p class="muted text-xs mb-2"><strong>${fmt(once)} users (${pct(once, us.length)}%) came for exactly one day</strong> and are left off — below is the shape of the ${fmt(returners.length)} who came back.</p>` +
      s +
      tableView(
        ['active days', 'users', 'share of returners'],
        [['1 (excluded)', fmt(once), '—']].concat(
          buckets.map((b) => [b.label, fmt(b.n), pct(b.n, returners.length) + '%']),
        ),
      )
  }

  function renderDow(us) {
    const acc = Array.from({ length: 7 }, () => ({ users: 0, days: 0 }))
    DAYS.forEach((d, i) => {
      const w = dowOf(d)
      acc[w].days++
      acc[w].users += us.filter((u) => u.syms[i] !== ' ').length
    })
    const order = [1, 2, 3, 4, 5, 6, 0]
    const data = order.map((w) => ({
      label: DOW[w],
      weekend: w === 0 || w === 6,
      v: acc[w].days ? acc[w].users / acc[w].days : 0,
    }))

    const W = 560
    const H = 220
    const L = 42
    const T = 12
    const B = 34
    const max = niceMax(Math.max(1, ...data.map((d) => d.v)))
    const bw = (W - L - 12) / 7
    const Y = (v) => T + (H - T - B) * (1 - v / max)

    let s = `<svg viewBox="0 0 ${W} ${H}">`
    for (const v of ticksFor(max)) {
      s += `<line class="gridline" x1="${L}" y1="${Y(v)}" x2="${W - 12}" y2="${Y(v)}"/>`
      s += `<text class="tick tab" x="${L - 6}" y="${Y(v) + 3}" text-anchor="end">${Math.round(v)}</text>`
    }
    data.forEach((d, i) => {
      const x = L + i * bw + 1
      const w = bw - 2
      const h = Math.max(1, Y(0) - Y(d.v))
      s += `<path d="${barV(x, Y(d.v), w, h)}" fill="var(--s1)" opacity="${d.weekend ? 0.45 : 1}" ${tip(`${d.label} · ${d.v.toFixed(1)} active users on an average ${d.label}`)}/>`
      s += `<text class="tick" x="${x + w / 2}" y="${H - 16}" text-anchor="middle">${d.label[0]}</text>`
    })
    s += `<text class="tick" x="${(L + W) / 2}" y="${H - 2}" text-anchor="middle">weekends faded</text>`
    s += '</svg>'
    document.getElementById('c-dow').innerHTML =
      s + tableView(['day', 'avg active users'], data.map((d) => [d.label, d.v.toFixed(1)]))
  }

  function renderSources(us) {
    const map = {}
    for (const u of us) {
      const m = (map[u.source] ??= { name: u.source, n: 0, act: 0, ret: 0, made: 0 })
      m.n++
      if (u.maxTier >= 1) m.act++
      if (u.active >= 2) m.ret++
      if (u.maxTier >= 3) m.made++
    }
    // 40-user floor: below that a single lucky returner swings the rate by
    // several points and small channels leapfrog real ones.
    const MIN_N = 40
    const rows = Object.values(map)
      .filter((m) => m.n >= MIN_N)
      .sort((a, b) => b.ret / b.n - a.ret / a.n)
      .slice(0, 8)
    const dropped = Object.values(map).filter((m) => m.n < MIN_N)
    if (!rows.length) {
      document.getElementById('c-sources').innerHTML =
        `<p class="muted text-xs py-8">No channel in this slice has ${MIN_N}+ users.</p>`
      return
    }

    const W = 560
    const rowH = 30
    const H = rows.length * rowH + 26
    const x0 = 92
    const max = niceMax(Math.max(10, ...rows.map((m) => pct(m.ret, m.n))))
    const scale = (p) => ((W - x0 - 96) * p) / max

    let s = `<svg viewBox="0 0 ${W} ${H}">`
    for (const p of ticksFor(max)) {
      const x = x0 + scale(p)
      s += `<line class="gridline" x1="${x}" y1="4" x2="${x}" y2="${H - 22}"/>`
      s += `<text class="tick tab" x="${x}" y="${H - 8}" text-anchor="middle">${Math.round(p)}%</text>`
    }
    rows.forEach((m, i) => {
      const y = 8 + i * rowH
      const p = pct(m.ret, m.n)
      const w = Math.max(2, scale(p))
      s += `<text class="vlabel" x="${x0 - 10}" y="${y + 13}" text-anchor="end">${esc(m.name)}</text>`
      s += `<path d="${barH(x0, y, w, 16)}" fill="var(--s1)" ${tip(`${m.name} · ${fmt(m.n)} users · ${p}% return · ${pct(m.act, m.n)}% hear music · ${pct(m.made, m.n)}% make something`)}/>`
      s += `<text class="vlabel" x="${x0 + w + 8}" y="${y + 12}">${p}%<tspan class="tick"> · n=${fmt(m.n)}</tspan></text>`
    })
    s += '</svg>'
    document.getElementById('c-sources').innerHTML =
      `<p class="muted text-xs mb-2">Bars: share returning on a second day. Channels with ${MIN_N}+ users${dropped.length ? `; ${dropped.length} smaller channel${dropped.length > 1 ? 's' : ''} left off as noise` : ''}.</p>` +
      s +
      tableView(
        ['channel', 'users', 'heard music', 'returned', 'made something'],
        rows.map((m) => [
          esc(m.name),
          fmt(m.n),
          pct(m.act, m.n) + '%',
          pct(m.ret, m.n) + '%',
          pct(m.made, m.n) + '%',
        ]),
      )
  }

  function renderTiles(us) {
    const act = us.filter((u) => u.maxTier >= 1).length
    const ret = us.filter((u) => u.active >= 2).length
    const made = us.filter((u) => u.maxTier >= 3).length
    const tiles = [
      { n: fmt(us.length), l: 'users in window' },
      { n: pct(act, us.length) + '%', l: `heard music at all · ${fmt(act)} users` },
      { n: pct(ret, us.length) + '%', l: `came back a second day · ${fmt(ret)} users` },
      { n: pct(made, us.length) + '%', l: `recorded, exported or looped · ${fmt(made)} users` },
    ]
    document.getElementById('tiles').innerHTML = tiles
      .map((t) => `<div class="card p-5"><div class="tile-n">${t.n}</div><div class="tile-l">${t.l}</div></div>`)
      .join('')
  }

  // ── orchestration ─────────────────────────────────────────────────────────
  function render() {
    const us = selected()
    const shown = [...us].sort(sorters[state.sort]).slice(0, state.rows)
    document.getElementById('f-count').textContent =
      `${fmt(us.length)} of ${fmt(USERS.length)} users in scope`
    renderTiles(us)
    renderCalendar(us, shown)
    renderRelative(us)
    renderDay0(us)
    renderRetention(us)
    renderFunnel(us)
    renderDaysHist(us)
    renderDow(us)
    renderSources(us)
  }

  const bind = (id, key, cast = (v) => v) =>
    document.getElementById(id).addEventListener('change', (e) => {
      state[key] = cast(e.target.value)
      render()
    })
  bind('f-source', 'source')
  bind('f-device', 'device')
  bind('f-sort', 'sort')
  bind('f-rows', 'rows', Number)
  bind('f-min', 'min', Number)

  document.getElementById('theme').addEventListener('click', () => {
    const cur =
      document.documentElement.dataset.theme ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    document.documentElement.dataset.theme = cur === 'dark' ? 'light' : 'dark'
  })

  // ── tooltip ───────────────────────────────────────────────────────────────
  const tipEl = document.getElementById('tip')
  document.addEventListener('pointermove', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]')
    if (!t) {
      tipEl.style.opacity = '0'
      return
    }
    tipEl.innerHTML = t.getAttribute('data-tip').replace(/·/g, '<span class="k">·</span>')
    tipEl.style.opacity = '1'
    const r = tipEl.getBoundingClientRect()
    const x = Math.min(e.clientX + 14, innerWidth - r.width - 10)
    const y = e.clientY > innerHeight - r.height - 20 ? e.clientY - r.height - 12 : e.clientY + 16
    tipEl.style.left = x + 'px'
    tipEl.style.top = y + 'px'
  })

  renderLegend()
  render()
})()
