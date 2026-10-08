'use strict';
const $ = (id) => document.getElementById(id);
const SOURCE_LABEL = { vscode: 'VS Code', 'claude-code': 'Claude Code CLI', jetbrains: 'JetBrains', 'claude-ai': 'claude.ai' };
const SOURCE_ORDER = ['vscode', 'claude-code', 'jetbrains', 'claude-ai'];
const nf = new Intl.NumberFormat();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function li(left, right, cls) {
  const item = el('li', cls);
  item.append(left instanceof Node ? left : el('span', 'k', left), el('span', 'v', right));
  return item;
}

function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  return h < 48 ? h + 'h ago' : Math.round(h / 24) + 'd ago';
}

function until(ms) {
  const m = Math.round((ms - Date.now()) / 60000);
  if (m <= 0) return 'now';
  if (m < 60) return 'in ' + m + 'm';
  const h = Math.floor(m / 60);
  return h < 24 ? 'in ' + h + 'h ' + (m % 60) + 'm' : 'in ' + Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

function usd(v) {
  if (!v) return '$0';
  if (v < 0.01) return '<$0.01';
  return v < 1000 ? '$' + v.toFixed(2) : '$' + nf.format(Math.round(v));
}

function pct(v) {
  if (!v) return '0%';
  return v < 10 ? v.toFixed(1) + '%' : Math.round(v) + '%';
}

function prettyModel(m) {
  const parts = String(m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-');
  const name = parts.filter((p) => /[a-z]/i.test(p)).map((p) => p[0].toUpperCase() + p.slice(1)).join(' ');
  const ver = parts.filter((p) => /^\d+$/.test(p)).join('.');
  return (name + (ver ? ' ' + ver : '')).trim() || m;
}

function replies(n) {
  return nf.format(n) + (n === 1 ? ' reply' : ' replies');
}

// ---- limits ----
function labelFor(key) {
  if (key === 'five_hour') return '5-hour session';
  if (key === 'seven_day') return 'Weekly · all models';
  const suffix = key.replace(/^(five_hour|seven_day)_?/, '').replace(/_/g, ' ');
  return (key.startsWith('five_hour') ? '5-hour · ' : 'Weekly · ') + suffix.replace(/\b\w/g, (c) => c.toUpperCase());
}

function windowsFromRaw(raw) {
  const out = [];
  for (const [k, v] of Object.entries(raw || {})) {
    if (!/^(five_hour|seven_day)/.test(k) || !v || typeof v !== 'object') continue;
    const p = Number(v.utilization ?? v.percent);
    if (!Number.isFinite(p)) continue;
    const resetsAt = v.resets_at ? Date.parse(v.resets_at) : null;
    out.push({ key: k, label: labelFor(k), pct: p, resetsAt, active: !resetsAt || resetsAt > Date.now() });
  }
  return out;
}

function renderLimits(windows, observedAt, member) {
  const box = $('limits');
  if (!windows.length) return;
  box.replaceChildren();
  const order = (k) => (k === 'five_hour' ? 0 : k === 'seven_day' ? 1 : 2);
  for (const w of windows.slice().sort((a, b) => order(a.key) - order(b.key) || a.key.localeCompare(b.key))) {
    const p = w.active ? w.pct : 0;
    const level = p >= 95 ? 'crit' : p >= 80 ? 'warn' : '';
    const fill = el('div', level);
    fill.style.width = Math.min(100, p) + '%';
    const meter = el('div', 'meter');
    meter.append(fill);
    const head = el('div', 'row');
    head.append(el('span', null, w.label), el('span', 'pct', Math.round(p) + '%'));
    const wrap = el('div', 'limit');
    wrap.append(head, meter);
    const notes = [];
    if (w.active && w.resetsAt) notes.push('Resets ' + until(w.resetsAt));
    const mine = w.contributions && w.contributions.members.find((c) => c.member === member);
    if (mine) notes.push('you: ' + pct(mine.pp));
    if (notes.length) wrap.append(el('p', 'muted', notes.join(' · ')));
    if (w.breakdown && w.breakdown.rows.some((r) => r.pct > 0)) {
      wrap.append(el('p', 'muted', 'By product: ' + w.breakdown.rows.filter((r) => r.pct > 0).map((r) => r.label + ' ' + pct(r.pct)).join(' · ')));
    }
    box.append(wrap);
  }
  if (observedAt) box.append(el('p', 'muted', 'Checked ' + ago(observedAt)));
}

// ---- your usage ----
function renderMine(s) {
  const totals = $('totals');
  totals.replaceChildren(
    el('div', 'stat', null), el('div', 'stat', null));
  totals.children[0].append(el('span', 'muted', 'Today'), el('strong', null, replies(s.today.messages)), el('span', 'muted', usd(s.today.cost)));
  totals.children[1].append(el('span', 'muted', 'Last 7 days'), el('strong', null, replies(s.week.messages)), el('span', 'muted', usd(s.week.cost)));

  const bySource = new Map();
  for (const r of s.week.rows) {
    const x = bySource.get(r.source) || { messages: 0, cost: 0, estimated: 0 };
    x.messages += r.messages; x.cost += r.cost; x.estimated += r.estimated;
    bySource.set(r.source, x);
  }
  const src = $('by-source');
  src.replaceChildren();
  const keys = [...bySource.keys()].sort((a, b) => (SOURCE_ORDER.indexOf(a) + 99) % 99 - (SOURCE_ORDER.indexOf(b) + 99) % 99);
  if (!keys.length) src.append(el('li', 'muted', 'No usage recorded in the last 7 days.'));
  for (const k of keys) {
    const x = bySource.get(k);
    src.append(li(SOURCE_LABEL[k] || k, replies(x.messages) + ' · ' + (x.estimated ? '≈' : '') + usd(x.cost)));
  }

  const byModel = new Map();
  for (const r of s.week.rows) {
    const x = byModel.get(r.model) || { messages: 0, cost: 0, family: r.family };
    x.messages += r.messages; x.cost += r.cost;
    byModel.set(r.model, x);
  }
  const mod = $('by-model');
  mod.replaceChildren();
  const models = [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 6);
  if (!models.length) mod.append(el('li', 'muted', '–'));
  for (const [m, x] of models) {
    const left = el('span', 'k');
    left.append(el('span', 'swatch sw-' + x.family), prettyModel(m));
    mod.append(li(left, replies(x.messages) + ' · ' + usd(x.cost)));
  }
}

function renderTeam(team, member) {
  if (!team || !team.length) return;
  $('team-wrap').hidden = false;
  const list = $('team');
  list.replaceChildren();
  for (const m of team.slice(0, 6)) {
    const share = m.limit.seven_day > 0 ? pct(m.limit.seven_day) + ' of week' : replies(m.messages);
    const item = li(m.member, share + ' · ' + usd(m.cost), m.member === member ? 'me' : null);
    item.title = replies(m.messages) + (m.topModel ? ', mostly ' + prettyModel(m.topModel) : '');
    list.append(item);
  }
}

function renderLocalToday(todayStats) {
  // Fallback when the server can't be reached: what this browser saw today.
  const day = new Date();
  const key = day.getFullYear() + '-' + String(day.getMonth() + 1).padStart(2, '0') + '-' + String(day.getDate()).padStart(2, '0');
  const entries = todayStats && todayStats.day === key ? Object.entries(todayStats.byModel) : [];
  const src = $('by-source');
  src.replaceChildren(li('claude.ai today (this browser)', replies(entries.reduce((a, [, n]) => a + n, 0))));
}

async function render() {
  const cfg = await loadConfig();
  const serverUrl = cfg.serverUrl;
  const { lastSnapshot, todayStats, status = {} } = await chrome.storage.local.get(['lastSnapshot', 'todayStats', 'status']);
  $('who').textContent = cfg.member || 'not set up';
  if (cfg.locked.member) $('who').title = 'Set from your work email by your company';
  if (lastSnapshot) renderLimits(windowsFromRaw(lastSnapshot.raw), lastSnapshot.ts, cfg.member);

  const sync = $('sync');
  if (!serverUrl || !cfg.member || !cfg.teamToken) {
    sync.textContent = cfg.locked.member && !cfg.member
      ? 'Sign in to Chrome with your work account. Your company takes your name from it.'
      : 'Not set up yet. Open Settings.';
    sync.className = 'err';
    renderLocalToday(todayStats);
  } else {
    try {
      const url = serverUrl + '/api/summary?member=' + encodeURIComponent(cfg.member) + '&tz=' + (-new Date().getTimezoneOffset());
      const res = await fetch(url, { headers: { Authorization: 'Bearer ' + cfg.teamToken } });
      if (!res.ok) throw new Error(res.status === 401 ? 'the server rejected the token' : 'HTTP ' + res.status);
      const s = await res.json();
      renderMine(s);
      renderTeam(s.team, s.member || cfg.member);
      const serverWindows = s.limits.map((l) => ({ ...l }));
      const newest = s.limits.reduce((a, l) => Math.max(a, l.observedAt || 0), 0);
      if (serverWindows.length && (!lastSnapshot || newest >= lastSnapshot.ts)) renderLimits(serverWindows, newest, s.member || cfg.member);
      sync.textContent = status.error ? status.error : (status.lastSyncAt ? 'Browser data synced ' + ago(status.lastSyncAt) : 'Connected to the server.');
      sync.className = status.error ? 'err' : 'muted';
    } catch (e) {
      sync.textContent = 'Could not load from the server: ' + e.message;
      sync.className = 'err';
      renderLocalToday(todayStats);
    }
  }

  const dash = $('dashboard');
  if (serverUrl) {
    dash.hidden = false;
    dash.onclick = () => chrome.tabs.create({ url: serverUrl + '/' });
  }
}

$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
render();
