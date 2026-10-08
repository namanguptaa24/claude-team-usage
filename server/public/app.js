'use strict';
(function () {
  const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku', 'other'];
  const FAMILY_LABEL = { fable: 'Fable / Mythos', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', other: 'Other' };
  const SOURCE_LABEL = { vscode: 'VS Code', 'claude-code': 'Claude Code CLI', jetbrains: 'JetBrains', 'claude-ai': 'claude.ai' };
  const RANGES = [
    { id: '24h', label: '24h', name: 'Last 24 hours', days: 1, bucket: 'hour' },
    { id: '7d', label: '7d', name: 'Last 7 days', days: 7, bucket: 'day' },
    { id: '30d', label: '30d', name: 'Last 30 days', days: 30, bucket: 'day' },
    { id: '90d', label: '90d', name: 'Last 90 days', days: 90, bucket: 'day' },
    { id: 'custom', label: 'Custom', name: 'Pick a date, start time and length' },
  ];
  const BUCKET_WORD = { minute: 'minute', '5min': '5 minutes', hour: 'hour', day: 'day' };
  const SVGNS = 'http://www.w3.org/2000/svg';
  const HOUR = 3_600_000;
  const DAY = 86_400_000;

  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
  };

  const pad = (n) => String(n).padStart(2, '0');
  const localDate = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

  // Custom range: a local date, a start time and a length in minutes, e.g. yesterday 15:00 for 10 minutes.
  function readCustom() {
    let c = null;
    try { c = JSON.parse(storage.get('ctu.custom') || 'null'); } catch { /* ignore */ }
    if (c && /^\d{4}-\d\d-\d\d$/.test(c.date) && /^\d\d:\d\d$/.test(c.time) && c.minutes > 0 && c.minutes <= 1440) return c;
    const d = new Date(Date.now() - HOUR);
    d.setMinutes(Math.floor(d.getMinutes() / 5) * 5, 0, 0);
    return { date: localDate(d), time: pad(d.getHours()) + ':' + pad(d.getMinutes()), minutes: 60 };
  }

  const state = { range: storage.get('ctu.range') || '7d', source: '', member: '', data: null, custom: readCustom() };
  if (!RANGES.some((r) => r.id === state.range)) state.range = '7d';
  let token = storage.get('ctu.token') || '';
  let loadSeq = 0;

  // A link like https://server/#token=XYZ signs in once; the hash never reaches the server.
  const hashToken = new URLSearchParams(location.hash.slice(1)).get('token');
  if (hashToken) {
    token = hashToken;
    storage.set('ctu.token', token);
    history.replaceState(null, '', location.pathname + location.search);
  }

  const $ = (sel) => document.querySelector(sel);

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
  }

  function s(tag, attrs) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, String(v));
    return el;
  }

  function svgText(attrs, text) {
    const t = s('text', attrs);
    t.textContent = text;
    return t;
  }

  // ---------- formatting ----------
  const nf0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  function fmtUsd(v) {
    if (!v) return '$0';
    if (v < 0.01) return '<$0.01';
    if (v < 1000) return '$' + v.toFixed(2);
    return '$' + nf0.format(v);
  }
  function fmtUsdShort(v) {
    if (v === 0) return '$0';
    if (v >= 1000) return '$' + (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k';
    if (v >= 10) return '$' + Math.round(v);
    if (v >= 1) return '$' + v.toFixed(1);
    return '$' + v.toFixed(2);
  }
  function fmtTokens(n) {
    if (!n) return '0';
    for (const [d, u] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
      if (n >= d) return (n / d).toFixed(n / d >= 100 ? 0 : 1) + u;
    }
    return String(n);
  }
  function fmtPct(v) {
    if (v == null) return '–';
    if (v === 0) return '0%';
    if (v < 10) return v.toFixed(1) + '%';
    return Math.round(v) + '%';
  }
  function relFuture(ms) {
    const m = Math.round((ms - Date.now()) / 60_000);
    if (m <= 0) return 'now';
    if (m < 60) return 'in ' + m + 'm';
    const hh = Math.floor(m / 60);
    if (hh < 24) return 'in ' + hh + 'h ' + (m % 60) + 'm';
    return 'in ' + Math.floor(hh / 24) + 'd ' + (hh % 24) + 'h';
  }
  function ago(ms) {
    const m = Math.round((Date.now() - ms) / 60_000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    const hh = Math.round(m / 60);
    if (hh < 48) return hh + 'h ago';
    return Math.round(hh / 24) + 'd ago';
  }
  function fmtWhen(ms) {
    return new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function familyOf(model) {
    const t = String(model || '').toLowerCase();
    if (t.includes('fable') || t.includes('mythos')) return 'fable';
    return ['opus', 'sonnet', 'haiku'].find((f) => t.includes(f)) || 'other';
  }
  function prettyModel(m) {
    if (!m) return '–';
    const parts = m.replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-');
    const name = parts.filter((p) => /[a-z]/i.test(p)).map((p) => p[0].toUpperCase() + p.slice(1)).join(' ');
    const ver = parts.filter((p) => /^\d+$/.test(p)).join('.');
    return (name + (ver ? ' ' + ver : '')).trim() || m;
  }
  function truncate(str, n) { return str.length > n ? str.slice(0, n - 1) + '…' : str; }
  function emptyMsg(text) { return h('div', { class: 'empty' }, text); }
  function currentRange() {
    if (state.range === 'custom') {
      const [y, mo, d] = state.custom.date.split('-').map(Number);
      const [hh, mm] = state.custom.time.split(':').map(Number);
      const from = new Date(y, mo - 1, d, hh, mm).getTime();
      const len = state.custom.minutes * 60_000;
      return { from, to: from + len, bucket: len <= HOUR ? 'minute' : len <= 5 * HOUR ? '5min' : 'hour' };
    }
    const r = RANGES.find((x) => x.id === state.range) || RANGES[1];
    const to = Date.now();
    return { from: to - r.days * DAY, to, bucket: r.bucket };
  }
  function fmtClock(ms) { return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
  // "until 15:10", or "until Thu 00:00" when the range ends on another day.
  function customEnd() {
    const { from, to } = currentRange();
    const sameDay = new Date(from).toDateString() === new Date(to).toDateString();
    return sameDay ? fmtClock(to) : new Date(to).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function rangeName() {
    if (state.range !== 'custom') return (RANGES.find((r) => r.id === state.range) || RANGES[1]).name;
    const { from } = currentRange();
    const day = new Date(from).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    return day + ', ' + fmtClock(from) + ' – ' + customEnd();
  }

  // ---------- tooltip ----------
  const tipEl = $('#tooltip');
  function positionTip(ev) {
    const pad = 14;
    const r = tipEl.getBoundingClientRect();
    let x = ev.clientX + pad;
    let y = ev.clientY + pad;
    if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - pad;
    tipEl.style.left = Math.max(8, x) + 'px';
    tipEl.style.top = Math.max(8, y) + 'px';
  }
  function bindTip(el, build) {
    el.addEventListener('pointerenter', (ev) => {
      tipEl.replaceChildren(...build());
      tipEl.hidden = false;
      positionTip(ev);
    });
    el.addEventListener('pointermove', positionTip);
    el.addEventListener('pointerleave', () => { tipEl.hidden = true; });
  }
  function tipContent(title, rows) {
    const out = [h('div', { class: 't-title' }, title)];
    for (const r of rows) {
      if (r === '-') { out.push(h('div', { class: 't-sep' })); continue; }
      out.push(h('div', { class: 't-row' },
        h('span', { class: 'k' }, r.fam ? h('span', { class: 'swatch sw-' + r.fam }) : null, r.k),
        h('span', null, r.v)));
    }
    return out;
  }

  function renderLegend(host, families) {
    host.replaceChildren(...families.map((f) => h('span', null, h('span', { class: 'swatch sw-' + f }), FAMILY_LABEL[f])));
  }

  // Bar shapes: square at the baseline, 4px rounded at the data end.
  function hbarPath(x, y, w, hgt, r) {
    if (r <= 0) return 'M' + x + ' ' + y + 'H' + (x + w) + 'V' + (y + hgt) + 'H' + x + 'Z';
    return 'M' + x + ' ' + y + 'H' + (x + w - r) + 'Q' + (x + w) + ' ' + y + ' ' + (x + w) + ' ' + (y + r) +
      'V' + (y + hgt - r) + 'Q' + (x + w) + ' ' + (y + hgt) + ' ' + (x + w - r) + ' ' + (y + hgt) + 'H' + x + 'Z';
  }
  function vbarPath(x, yTop, w, hgt, r) {
    const yb = yTop + hgt;
    if (r <= 0) return 'M' + x + ' ' + yb + 'V' + yTop + 'H' + (x + w) + 'V' + yb + 'Z';
    return 'M' + x + ' ' + yb + 'V' + (yTop + r) + 'Q' + x + ' ' + yTop + ' ' + (x + r) + ' ' + yTop +
      'H' + (x + w - r) + 'Q' + (x + w) + ' ' + yTop + ' ' + (x + w) + ' ' + (yTop + r) + 'V' + yb + 'Z';
  }
  function niceTicks(max, count) {
    if (!(max > 0)) return { ticks: [0, 1], top: 1 };
    const raw = max / count;
    const pow = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((x) => x >= raw);
    const top = Math.ceil(max / step - 1e-9) * step;
    const ticks = [];
    for (let v = 0; v <= top + step / 1000; v += step) ticks.push(v);
    return { ticks, top };
  }

  // ---------- sections ----------
  function renderAlerts(d) {
    const host = $('#alerts');
    const set = d.settings || {};
    const list = d.alerts || [];
    $('#alerts-note').textContent = 'Right now, for the whole team. A warning shows when one person uses ' +
      fmtPct(set.alertMemberDailyPct) + ' or more of the weekly limit within 24 hours, or when a limit reaches ' +
      fmtPct(set.alertAccountPct) + '.' + (d.viewer && d.viewer.admin ? ' Change these levels in Manage team.' : '');
    host.replaceChildren();
    if (!list.length) {
      host.append(h('p', { class: 'alert ok' }, h('span', { class: 'icon', 'aria-hidden': 'true' }, '✓'), h('span', null, 'No alerts right now.')));
      return;
    }
    for (const a of list) {
      let text;
      if (a.kind === 'limit') {
        text = [h('b', null, a.label), ' is at ' + fmtPct(a.pct) + '.',
          a.resetsAt ? ' Resets ' + relFuture(a.resetsAt) + ' · ' + fmtWhen(a.resetsAt) + '.' : ''];
      } else if (a.kind === 'member') {
        text = [h('b', { class: 'cap' }, a.member), ' used ' + fmtPct(a.pp) + ' of the weekly limit in the last 24 hours.'];
      } else {
        text = [h('b', null, 'Untracked:'), ' ' + fmtPct(a.pp) + ' of the weekly limit in the last 24 hours was used while nobody tracked was active. ' +
          'That is usually the desktop or mobile app, or someone without the tracker.'];
      }
      host.append(h('p', { class: 'alert ' + a.level },
        h('span', { class: 'icon', 'aria-hidden': 'true' }, a.level === 'crit' ? '⛔' : '⚠'), h('span', null, text)));
    }
  }

  function renderLimits(limits, warnAt) {
    const host = $('#limits');
    host.replaceChildren();
    if (!limits.length) {
      host.append(emptyMsg('No limit data yet. It appears after the first message from a tracked browser or Claude Code session.'));
      return;
    }
    for (const l of limits) {
      const level = l.pct >= 95 ? 'crit' : l.pct >= warnAt ? 'warn' : '';
      const fill = h('div', { class: 'fill ' + level });
      fill.style.width = Math.min(100, l.pct) + '%';
      const meter = h('div', { class: 'meter', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': l.pct, 'aria-label': l.label }, fill);
      const meta = h('div', { class: 'meta' },
        level ? h('span', { class: 'badge ' + level }, level === 'crit' ? '⛔ Almost used up' : '⚠ Running high') : null,
        h('span', null, l.active ? (l.resetsAt ? 'Resets ' + relFuture(l.resetsAt) + ' · ' + fmtWhen(l.resetsAt) : 'Active') : 'No active window'),
        h('span', null, 'Checked ' + ago(l.observedAt)));
      const card = h('article', { class: 'card limit' },
        h('div', { class: 'top' }, h('span', { class: 'label' }, l.label), h('span', { class: 'pct' }, fmtPct(l.pct))),
        meter, meta);

      if (l.breakdown && l.breakdown.rows.some((r) => r.pct > 0)) {
        card.append(h('p', { class: 'breakdown', title: 'The account’s own split of this week’s usage, reported by Anthropic' },
          h('span', { class: 'dim' }, 'By product: '),
          l.breakdown.rows.filter((r) => r.pct > 0).map((r) => r.label + ' ' + fmtPct(r.pct)).join(' · ')));
      }
      if (l.contributions) {
        const rows = l.contributions.members.filter((r) => r.pp >= 0.05);
        if (l.contributions.untracked >= 0.05) rows.push({ member: 'Untracked', pp: l.contributions.untracked, untracked: true });
        if (l.contributions.beforeTracking >= 0.05) {
          rows.push({ member: 'Before tracking', pp: l.contributions.beforeTracking, untracked: true, note: 'Already used when tracking started, so it cannot be split by person' });
        }
        const who = h('div', { class: 'who' }, h('h3', null, 'Who used this window'));
        if (!rows.length) who.append(h('p', { class: 'note' }, 'No rise recorded in this window yet.'));
        const denom = Math.max(l.pct, rows.reduce((a, r) => a + r.pp, 0), 1);
        for (const r of rows.slice(0, 8)) {
          const bar = h('div', { class: 'bar' + (r.untracked ? ' untracked' : '') });
          bar.style.width = (r.pp / denom) * 100 + '%';
          who.append(h('div', { class: 'who-row' },
            h('span', { class: 'name' + (r.untracked ? ' untracked' : ''), title: r.note || (r.untracked ? 'Usage with no tracked activity: desktop or mobile app, or someone without the tracker' : r.member) }, r.member),
            h('div', { class: 'track' }, bar),
            h('span', { class: 'val' }, fmtPct(r.pp))));
        }
        card.append(who);
      } else if (l.active && l.scope == null) {
        card.append(h('p', { class: 'note who' }, 'This window covers a product area, so it is not split by person.'));
      }
      host.append(card);
    }
  }

  function renderLeaderboard(d) {
    const t = $('#leaderboard');
    const totalCost = d.members.reduce((a, m) => a + m.cost, 0);
    const cols = ['Member', 'Weekly limit used', '5-hour limit used', 'API-equiv. cost', 'Share of cost', 'Messages', 'Tokens', 'Top model', 'Sources', 'Last active'];
    const head = h('thead', null, h('tr', null, cols.map((c, i) => h('th', { scope: 'col', class: i === 0 || i >= 7 ? 'left' : null }, c))));
    const body = h('tbody');
    d.members.forEach((m, i) => {
      body.append(h('tr', null,
        h('td', { class: 'member' }, h('span', { class: 'rank' }, String(i + 1)), ' ', m.member),
        h('td', null, fmtPct(m.limit.seven_day)),
        h('td', null, fmtPct(m.limit.five_hour)),
        h('td', null, fmtUsd(m.cost)),
        h('td', null, totalCost ? Math.round((m.cost / totalCost) * 100) + '%' : '–'),
        h('td', null, nf0.format(m.messages)),
        h('td', null, fmtTokens(m.tokens)),
        h('td', { class: 'left' }, m.topModel ? [h('span', { class: 'swatch sw-' + familyOf(m.topModel) }), prettyModel(m.topModel)] : '–'),
        h('td', { class: 'left' }, m.sources.map((x) => SOURCE_LABEL[x] || x).join(', ') || '–'),
        h('td', { class: 'left dim' }, m.lastTs ? ago(m.lastTs) : '–')));
    });
    const u = d.untracked || {};
    if (!state.member && ((u.seven_day || 0) >= 0.05 || (u.five_hour || 0) >= 0.05)) {
      body.append(h('tr', null,
        h('td', { class: 'member untracked', title: 'Limit used while nobody tracked was active' }, 'Untracked'),
        h('td', null, fmtPct(u.seven_day || 0)), h('td', null, fmtPct(u.five_hour || 0)),
        h('td', { class: 'dim' }, '–'), h('td', { class: 'dim' }, '–'), h('td', { class: 'dim' }, '–'),
        h('td', { class: 'dim' }, '–'), h('td', { class: 'left dim' }, 'Desktop/mobile app or untracked device'),
        h('td', { class: 'left dim' }, '–'), h('td', { class: 'left dim' }, '–')));
    }
    const bt = d.beforeTracking || {};
    if (!state.member && ((bt.seven_day || 0) >= 0.05 || (bt.five_hour || 0) >= 0.05)) {
      body.append(h('tr', null,
        h('td', { class: 'member untracked', title: 'Already used when tracking started' }, 'Before tracking'),
        h('td', null, fmtPct(bt.seven_day || 0)), h('td', null, fmtPct(bt.five_hour || 0)),
        h('td', { class: 'dim' }, '–'), h('td', { class: 'dim' }, '–'), h('td', { class: 'dim' }, '–'),
        h('td', { class: 'dim' }, '–'), h('td', { class: 'left dim' }, 'Used before the first limit reading'),
        h('td', { class: 'left dim' }, '–'), h('td', { class: 'left dim' }, '–')));
    }
    if (!body.children.length) body.append(h('tr', null, h('td', { colspan: cols.length, class: 'left dim' }, 'No usage in this range yet.')));
    t.replaceChildren(head, body);
    $('#board-note').textContent = rangeName() + '. Limit columns add up each rise in the shared limit while this person was active. 120% on the 5-hour limit means 1.2 sessions’ worth.';
  }

  function renderMemberChart(members) {
    const host = $('#chart-members');
    host.replaceChildren();
    const legend = $('#legend-members');
    legend.replaceChildren();
    const rows = members.filter((m) => m.cost > 0).sort((a, b) => b.cost - a.cost).slice(0, 20);
    if (!rows.length) { host.append(emptyMsg('No token usage in this range.')); return; }
    const present = FAMILIES.filter((f) => rows.some((r) => (r.byFamily[f] || 0) > 0));
    if (present.length > 1) renderLegend(legend, present);

    const W = Math.max(300, host.clientWidth - 16);
    const labelW = Math.min(150, Math.round(W * 0.26));
    const valueW = 72;
    const rowH = 32;
    const barH = 18;
    const padT = 4;
    const plotW = W - labelW - valueW - 8;
    const H = padT * 2 + rows.length * rowH;
    const max = Math.max(...rows.map((r) => r.cost));
    const svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'API-equivalent cost per member, split by model family' });

    rows.forEach((r, i) => {
      const rowY = padT + i * rowH;
      const y = rowY + (rowH - barH) / 2;
      const g = s('g', { class: 'col' });
      g.append(s('rect', { x: 0, y: rowY, width: W, height: rowH, rx: 6, class: 'hover-band' }));
      g.append(svgText({ x: labelW - 8, y: y + barH / 2, 'text-anchor': 'end', 'dominant-baseline': 'central', class: 'axis-label member' }, truncate(r.member, 18)));
      const segs = present.map((f) => ({ f, v: r.byFamily[f] || 0 })).filter((x) => x.v > 0);
      const fullW = (r.cost / max) * plotW;
      let x = labelW;
      segs.forEach((sg, j) => {
        const isLast = j === segs.length - 1;
        const w = (sg.v / r.cost) * fullW;
        const drawW = isLast ? w : Math.max(0, w - 2);
        if (drawW > 0.3) {
          g.append(s('path', { d: hbarPath(x, y, drawW, barH, isLast ? Math.min(4, drawW / 2, barH / 2) : 0), class: 'seg-mark fam-' + sg.f }));
        }
        x += w;
      });
      g.append(svgText({ x: labelW + fullW + 6, y: y + barH / 2, 'dominant-baseline': 'central', class: 'value-label' }, fmtUsd(r.cost)));
      const hit = s('rect', { x: 0, y: rowY, width: W, height: rowH, class: 'hit' });
      bindTip(hit, () => tipContent(r.member, [
        ...segs.map((sg) => ({ k: FAMILY_LABEL[sg.f], v: fmtUsd(sg.v) + ' · ' + Math.round((sg.v / r.cost) * 100) + '%', fam: sg.f })),
        '-',
        { k: 'Total', v: fmtUsd(r.cost) },
        { k: 'Tokens', v: fmtTokens(r.tokens) },
        { k: 'Messages', v: nf0.format(r.messages) },
      ]));
      g.append(hit);
      svg.append(g);
    });
    svg.append(s('line', { x1: labelW, x2: labelW, y1: 0, y2: H, class: 'baseline' }));
    host.append(svg);
  }

  function renderTrend(d) {
    const host = $('#chart-trend');
    host.replaceChildren();
    const legend = $('#legend-trend');
    legend.replaceChildren();
    const { from, to, bucketMs, tzOffsetMin, bucket } = d.range;
    $('#trend-note').textContent = 'API-equivalent cost per ' + (BUCKET_WORD[bucket] || 'day') + ', stacked by model family. ' + rangeName() + (state.member ? ' · ' + state.member : '') + '.';
    const tzMs = tzOffsetMin * 60_000;
    const b0 = Math.floor((from + tzMs) / bucketMs);
    const b1 = Math.floor((to - 1 + tzMs) / bucketMs);
    const buckets = [];
    for (let b = b0; b <= b1; b++) buckets.push({ t: b * bucketMs - tzMs, fam: {}, members: {}, total: 0, messages: 0 });
    const index = new Map(buckets.map((x, i) => [x.t, i]));
    for (const r of d.series) {
      const i = index.get(r.t);
      if (i == null) continue;
      const B = buckets[i];
      B.fam[r.family] = (B.fam[r.family] || 0) + r.cost;
      B.members[r.member] = (B.members[r.member] || 0) + r.cost;
      B.total += r.cost;
      B.messages += r.messages;
    }
    if (!buckets.some((b) => b.total > 0)) { host.append(emptyMsg('No usage in this range.')); return; }
    const present = FAMILIES.filter((f) => buckets.some((b) => (b.fam[f] || 0) > 0));
    if (present.length > 1) renderLegend(legend, present);

    const W = Math.max(300, host.clientWidth - 16);
    const H = 260;
    const m = { l: 52, r: 8, t: 10, b: 26 };
    const pw = W - m.l - m.r;
    const ph = H - m.t - m.b;
    const { ticks, top } = niceTicks(Math.max(...buckets.map((b) => b.total)), 4);
    const yOf = (v) => m.t + ph - (v / top) * ph;
    const svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Usage over time stacked by model family' });
    for (const v of ticks) {
      const y = yOf(v);
      svg.append(s('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, class: v === 0 ? 'baseline' : 'gridline' }));
      svg.append(svgText({ x: m.l - 8, y, 'text-anchor': 'end', 'dominant-baseline': 'central', class: 'tick' }, fmtUsdShort(v)));
    }
    const n = buckets.length;
    const step = pw / n;
    const bw = Math.max(1.5, Math.min(44, step * 0.72));
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 64))));
    const labelOf = (t) => (bucket === 'day'
      ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : fmtClock(t));

    buckets.forEach((B, i) => {
      const x0 = m.l + i * step;
      const x = x0 + (step - bw) / 2;
      const g = s('g', { class: 'col' });
      g.append(s('rect', { x: x0, y: m.t, width: step, height: ph, class: 'hover-band' }));
      const segs = present.map((f) => ({ f, v: B.fam[f] || 0 })).filter((z) => z.v > 0);
      let acc = 0;
      segs.forEach((sg, j) => {
        const isTop = j === segs.length - 1;
        const yBottom = yOf(acc);
        const yTop = yOf(acc + sg.v);
        const gap = isTop ? 0 : 2;
        const drawH = yBottom - yTop - gap;
        if (drawH > 0.3) {
          g.append(s('path', { d: vbarPath(x, yTop + gap, bw, drawH, isTop ? Math.min(4, bw / 2, drawH) : 0), class: 'seg-mark fam-' + sg.f }));
        }
        acc += sg.v;
      });
      if (i % every === 0) {
        svg.append(svgText({ x: x0 + step / 2, y: H - 8, 'text-anchor': 'middle', class: 'tick' }, labelOf(B.t)));
      }
      const hit = s('rect', { x: x0, y: m.t, width: step, height: ph, class: 'hit' });
      bindTip(hit, () => {
        const topMembers = Object.entries(B.members).sort((a, b) => b[1] - a[1]).slice(0, 4);
        return tipContent(labelOf(B.t), [
          ...segs.slice().reverse().map((sg) => ({ k: FAMILY_LABEL[sg.f], v: fmtUsd(sg.v), fam: sg.f })),
          { k: 'Total', v: fmtUsd(B.total) },
          ...(topMembers.length ? ['-', ...topMembers.map(([name, v]) => ({ k: name, v: fmtUsd(v) }))] : []),
        ]);
      });
      g.append(hit);
      svg.append(g);
    });
    host.append(svg);
  }

  function renderDetails(rows) {
    const t = $('#details');
    const cols = ['Member', 'Source', 'Model', 'Messages', 'Input', 'Output', 'Cache read', 'Cache write', 'API-equiv. cost'];
    const head = h('thead', null, h('tr', null, cols.map((c, i) => h('th', { scope: 'col', class: i < 3 ? 'left' : null }, c))));
    const body = h('tbody');
    for (const r of rows) {
      const est = r.estimated > 0 ? '≈ ' : '';
      body.append(h('tr', null,
        h('td', { class: 'member' }, r.member),
        h('td', { class: 'left' }, SOURCE_LABEL[r.source] || r.source),
        h('td', { class: 'left' }, h('span', { class: 'swatch sw-' + r.family }), prettyModel(r.model), h('span', { class: 'dim' }, ' ' + r.model)),
        h('td', null, nf0.format(r.messages)),
        h('td', null, est + fmtTokens(r.input)),
        h('td', null, est + fmtTokens(r.output)),
        h('td', null, fmtTokens(r.cacheRead)),
        h('td', null, fmtTokens(r.cacheWrite)),
        h('td', null, est + fmtUsd(r.cost))));
    }
    if (!rows.length) body.append(h('tr', null, h('td', { colspan: cols.length, class: 'left dim' }, 'No usage in this range yet.')));
    t.replaceChildren(head, body);
  }

  function renderMemberSelect(all) {
    const sel = $('#member');
    const keep = state.member;
    sel.replaceChildren(h('option', { value: '' }, 'All members'), ...all.map((m) => h('option', { value: m }, m)));
    sel.value = all.includes(keep) ? keep : '';
  }

  function render() {
    const d = state.data;
    $('#login').hidden = true;
    $('#content').hidden = false;
    $('#manage').hidden = !(d.viewer && d.viewer.admin);
    renderMemberSelect(d.allMembers);
    renderAlerts(d);
    renderLimits(d.limits, (d.settings && d.settings.alertAccountPct) || 80);
    renderLeaderboard(d);
    renderMemberChart(d.members);
    renderTrend(d);
    renderDetails(d.byMemberModel);
    $('#subtitle').textContent = 'Updated ' + new Date(d.generatedAt).toLocaleTimeString() + ' · ' +
      d.allMembers.length + (d.allMembers.length === 1 ? ' member' : ' members') + ' tracked';
  }

  function showLogin(message) {
    $('#content').hidden = true;
    $('#login').hidden = false;
    const err = $('#login-error');
    err.hidden = !message;
    err.textContent = message || '';
    $('#token-input').focus();
  }

  function filterParams(extra) {
    const { from, to, bucket } = currentRange();
    const params = new URLSearchParams({
      from: String(from), to: String(to), tz: String(-new Date(from).getTimezoneOffset()), bucket, ...extra,
    });
    if (state.source) params.set('source', state.source);
    if (state.member) params.set('member', state.member);
    return params;
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) throw new Error((data && data.error) || 'server returned HTTP ' + res.status);
    return data;
  }

  // The same range and filters as the page, as a CSV file that Excel opens.
  async function download(view, btn) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Preparing…';
    try {
      const res = await fetch('/api/export.csv?' + filterParams({ view }), { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) throw new Error('server returned HTTP ' + res.status);
      const name = (/filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '') || [])[1] || 'claude-usage.csv';
      const url = URL.createObjectURL(await res.blob());
      const a = h('a', { href: url, download: name, hidden: true });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      alert('Could not download: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  // ---------- manage team (needs a separate DASHBOARD_TOKEN on the server) ----------
  const admin = { members: [], editing: null };

  function smallButton(label, onClick, cls) {
    const b = h('button', { type: 'button', class: 'btn small' + (cls ? ' ' + cls : '') }, label);
    b.addEventListener('click', onClick);
    return b;
  }

  function setAdminStatus(text, isError) {
    const el = $('#admin-status');
    el.textContent = text;
    el.classList.toggle('error', !!isError);
  }

  async function openAdmin() {
    const set = (state.data && state.data.settings) || {};
    $('#set-member').value = set.alertMemberDailyPct ?? 15;
    $('#set-account').value = set.alertAccountPct ?? 80;
    $('#settings-status').textContent = '';
    setAdminStatus('');
    admin.editing = null;
    $('#admin').showModal();
    await loadMembers();
  }

  async function loadMembers() {
    try {
      admin.members = (await api('/api/admin/members')).members;
      renderAdminMembers();
    } catch (e) {
      setAdminStatus('Could not load members: ' + e.message, true);
    }
  }

  function renderAdminMembers() {
    const t = $('#admin-members');
    const cols = ['Member', 'Also sent as', 'Messages', 'Last active', 'Apps', ''];
    const head = h('thead', null, h('tr', null, cols.map((c, i) => h('th', { scope: 'col', class: i === 2 ? null : 'left' }, c))));
    const body = h('tbody');
    for (const m of admin.members) {
      let nameCell;
      let actions;
      if (admin.editing === m.member) {
        const input = h('input', { type: 'text', value: m.member, maxlength: 64, required: true, 'aria-label': 'New name for ' + m.member });
        const form = h('form', { class: 'rename' }, input,
          h('button', { type: 'submit', class: 'btn small primary' }, 'Save'),
          smallButton('Cancel', () => { admin.editing = null; renderAdminMembers(); }));
        form.addEventListener('submit', (e) => { e.preventDefault(); renameMember(m.member, input.value); });
        nameCell = h('td', { class: 'left', colspan: 2 }, form);
        actions = h('td');
        setTimeout(() => { input.focus(); input.select(); });
      } else {
        nameCell = [h('td', { class: 'member' }, m.member), h('td', { class: 'left dim' }, m.aliases.join(', ') || '–')];
        actions = h('td', { class: 'left' }, h('div', { class: 'row-actions' },
          smallButton('Rename', () => { admin.editing = m.member; renderAdminMembers(); }),
          smallButton('Delete', () => deleteMember(m), 'danger')));
      }
      body.append(h('tr', null, nameCell,
        h('td', null, nf0.format(m.messages)),
        h('td', { class: 'left dim' }, m.lastTs ? ago(m.lastTs) : '–'),
        h('td', { class: 'left' }, m.sources.map((x) => SOURCE_LABEL[x] || x).join(', ') || '–'),
        actions));
    }
    if (!admin.members.length) body.append(h('tr', null, h('td', { colspan: cols.length, class: 'left dim' }, 'Nobody has sent any usage yet.')));
    t.replaceChildren(head, body);
  }

  async function renameMember(from, typed) {
    const to = typed.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
    if (!to) return;
    if (to === from) { admin.editing = null; renderAdminMembers(); return; }
    const merging = admin.members.some((m) => m.member === to);
    if (merging && !confirm('Merge "' + from + '" into "' + to + '"?\n\nAll usage of ' + from + ' will show under ' + to + '. A merge cannot be split again.')) return;
    try {
      const r = await api('/api/admin/members/rename', { from, to });
      admin.editing = null;
      if (state.member === from) state.member = '';
      setAdminStatus((r.merged ? 'Merged ' + from + ' into ' : 'Renamed ' + from + ' to ') + r.member + '.');
      await loadMembers();
      load();
    } catch (e) {
      setAdminStatus('Could not rename: ' + e.message, true);
    }
  }

  async function deleteMember(m) {
    const ok = confirm('Delete all data of "' + m.member + '"?\n\n' + nf0.format(m.messages) + ' messages and their limit readings will be removed for good. ' +
      'If ' + m.member + ' still has the tracker installed, new usage will show up again.');
    if (!ok) return;
    try {
      await api('/api/admin/members/delete', { member: m.member });
      if (state.member === m.member) state.member = '';
      setAdminStatus('Deleted ' + m.member + '.');
      await loadMembers();
      load();
    } catch (e) {
      setAdminStatus('Could not delete: ' + e.message, true);
    }
  }

  async function saveSettings(e) {
    e.preventDefault();
    const status = $('#settings-status');
    try {
      const r = await api('/api/admin/settings', { alertMemberDailyPct: $('#set-member').value, alertAccountPct: $('#set-account').value });
      if (state.data) state.data.settings = r.settings;
      status.textContent = 'Saved.';
      status.classList.remove('error');
      load();
    } catch (err) {
      status.textContent = err.message;
      status.classList.add('error');
    }
  }

  async function load() {
    if (!token) { showLogin(); return; }
    const seq = ++loadSeq;
    const params = filterParams();
    $('#refresh').disabled = true;
    try {
      const res = await fetch('/api/stats?' + params, { headers: { Authorization: 'Bearer ' + token } });
      if (seq !== loadSeq) return;
      if (res.status === 401) {
        storage.del('ctu.token');
        token = '';
        showLogin('That token was not accepted.');
        return;
      }
      if (!res.ok) throw new Error('server returned HTTP ' + res.status);
      state.data = await res.json();
      render();
    } catch (e) {
      if (seq === loadSeq) $('#subtitle').textContent = 'Could not load data: ' + e.message;
    } finally {
      if (seq === loadSeq) $('#refresh').disabled = false;
    }
  }

  function showCustom() {
    $('#custom').hidden = state.range !== 'custom';
    $('#c-until').textContent = 'until ' + customEnd();
  }

  function initCustom() {
    const date = $('#c-date');
    const time = $('#c-time');
    const dur = $('#c-dur');
    date.value = state.custom.date;
    date.max = localDate(new Date());
    time.value = state.custom.time;
    dur.value = String(state.custom.minutes);
    if (!dur.value) dur.value = '60';
    const apply = () => {
      if (!date.value || !time.value) return; // half-typed; wait for a full value
      state.custom = { date: date.value, time: time.value.slice(0, 5), minutes: Number(dur.value) };
      storage.set('ctu.custom', JSON.stringify(state.custom));
      showCustom();
      load();
    };
    for (const el of [date, time, dur]) el.addEventListener('change', apply);
  }

  function init() {
    const seg = $('#range');
    for (const r of RANGES) {
      const b = h('button', { type: 'button', 'aria-pressed': String(r.id === state.range), title: r.name }, r.label);
      b.addEventListener('click', () => {
        state.range = r.id;
        storage.set('ctu.range', r.id);
        for (const x of seg.children) x.setAttribute('aria-pressed', String(x === b));
        showCustom();
        if (r.id === 'custom') $('#c-date').focus();
        load();
      });
      seg.append(b);
    }
    initCustom();
    showCustom();
    $('#source').addEventListener('change', (e) => { state.source = e.target.value; load(); });
    $('#member').addEventListener('change', (e) => { state.member = e.target.value; load(); });
    $('#refresh').addEventListener('click', load);
    for (const b of document.querySelectorAll('[data-export]')) b.addEventListener('click', () => download(b.dataset.export, b));
    $('#manage').addEventListener('click', openAdmin);
    $('#admin-close').addEventListener('click', () => $('#admin').close());
    $('#settings-form').addEventListener('submit', saveSettings);
    $('#login-form').addEventListener('submit', (e) => {
      e.preventDefault();
      token = $('#token-input').value.trim();
      storage.set('ctu.token', token);
      load();
    });
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!state.data) return;
        renderMemberChart(state.data.members);
        renderTrend(state.data);
      }, 150);
    });
    setInterval(() => { if (!document.hidden && token) load(); }, 60_000);
    load();
  }

  init();
})();
