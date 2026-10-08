'use strict';
// Rate-limit windows: normalising the raw usage JSON and attributing the account-wide
// utilisation to the people who were active when it went up.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MODEL_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];

function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v < 1e12 ? v * 1000 : v) : null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function toPct(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 1000) : null;
}

function familyFromText(s) {
  const t = String(s || '').toLowerCase();
  if (t.includes('mythos')) return 'fable';
  return MODEL_FAMILIES.find((f) => t.includes(f)) || null;
}

// Window keys look like five_hour, seven_day, seven_day_opus, seven_day_routines ...
// scope: 'all' (every model counts), a model family, or null (a product-scoped window
// such as routines/cowork that can't be mapped to events, so it gets no attribution).
function windowMeta(key) {
  const k = String(key).toLowerCase();
  const isSession = k.startsWith('five_hour');
  const suffix = k.replace(/^(five_hour|seven_day)_?/, '');
  const scope = suffix ? familyFromText(suffix) : 'all';
  const pretty = suffix.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  let label;
  if (isSession) label = suffix ? '5-hour session · ' + pretty : '5-hour session';
  else label = suffix ? 'Weekly · ' + pretty : 'Weekly · all models';
  return { key: k, lengthMs: isSession ? 5 * HOUR : 7 * DAY, scope, label };
}

// limits[].scope comes as null, a string, or e.g. { model: { id, display_name: "Fable" }, surface }.
function scopeText(scope) {
  if (scope == null) return '';
  if (typeof scope === 'string') return scope;
  if (typeof scope !== 'object') return '';
  const pick = (v) => (v == null ? '' : typeof v === 'string' ? v : (typeof v === 'object' ? (v.id || v.display_name || v.name || '') : ''));
  return pick(scope.model) || pick(scope.model_family) || pick(scope.family) ||
    pick(scope.surface) || pick(scope.product) || pick(scope.name);
}

// Accepts the claude.ai /api/organizations/{org}/usage body or the
// api.anthropic.com/api/oauth/usage body. Both use { five_hour: { utilization, resets_at }, ... };
// newer bodies may also carry limits: [{ kind, percent, resets_at, scope }].
function normalizeUsage(raw) {
  const out = new Map();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  for (const [rawKey, val] of Object.entries(raw)) {
    const key = rawKey.toLowerCase();
    if (!/^(five_hour|seven_day)(_[a-z0-9_]+)?$/.test(key)) continue;
    if (!val || typeof val !== 'object') continue;
    const pct = toPct(val.utilization ?? val.percent ?? val.percentage);
    if (pct == null) continue;
    out.set(key, { key, pct, resetsAt: toMs(val.resets_at ?? val.resetsAt) });
  }
  if (Array.isArray(raw.limits)) {
    for (const l of raw.limits) {
      if (!l || typeof l !== 'object') continue;
      const pct = toPct(l.percent ?? l.utilization ?? l.percentage);
      if (pct == null) continue;
      const kind = String(l.kind ?? l.type ?? l.window ?? '').toLowerCase();
      const base = /session|five|5h|hour/.test(kind) ? 'five_hour'
        : /week|seven|7d/.test(kind) ? 'seven_day' : null;
      if (!base) continue;
      const scopeTxt = String(scopeText(l.scope)).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      const scope = scopeTxt ? (familyFromText(scopeTxt) || scopeTxt) : '';
      const key = scope ? base + '_' + scope : base;
      if (!out.has(key)) out.set(key, { key, pct, resetsAt: toMs(l.resets_at ?? l.resetsAt) });
    }
  }
  return [...out.values()];
}

// Walk the snapshots of one window in time order. Every rise in utilisation is
// split between the members who had activity (events) since the previous snapshot,
// weighted by their API-equivalent cost in that interval. A rise with no tracked
// activity is "untracked" (desktop/mobile apps, people without the tracker). What the
// very first snapshot already shows happened before tracking began, so it is kept
// apart as "beforeTracking" instead of being pinned on whoever backfilled history.
// windowResetsAt (optional) restricts the count to one window, identified by its reset time.
// onRise (optional) is called with { ts, byMember, untracked, beforeTracking } for every
// counted rise, so callers can bucket the split by day.
function attribute(db, { windowKey, scope, lengthMs, from, to, windowResetsAt = null, onRise = null }) {
  const out = { byMember: {}, untracked: 0, beforeTracking: 0, total: 0 };
  if (scope == null) return out;
  const start0 = from - lengthMs - DAY;
  const seed = db.prepare(
    'SELECT ts, pct, resets_at AS resetsAt FROM snapshots ' +
    'WHERE window_key = ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT 1'
  ).get(windowKey, start0);
  const snaps = db.prepare(
    'SELECT ts, pct, resets_at AS resetsAt FROM snapshots ' +
    'WHERE window_key = ? AND ts >= ? AND ts <= ? ORDER BY ts, id'
  ).all(windowKey, start0, to);
  if (seed) snaps.unshift(seed);
  const evq = db.prepare(
    'SELECT member, SUM(max(cost_usd, 0.000001)) AS w FROM events ' +
    'WHERE ts > ? AND ts <= ?' + (scope === 'all' ? '' : ' AND family = ?') + ' GROUP BY member'
  );
  const SAME_RESET_TOLERANCE = 15 * 60_000;
  let prevTs = null;
  let reset = null;
  let peak = 0;
  for (const s of snaps) {
    let same = false;
    if (prevTs != null) {
      if (reset != null && s.resetsAt != null) same = Math.abs(reset - s.resetsAt) <= SAME_RESET_TOLERANCE;
      else same = s.pct >= peak - 1;
    }
    let delta;
    let start;
    if (same) {
      delta = s.pct - peak;
      start = prevTs;
      if (s.pct > peak) peak = s.pct;
      if (s.resetsAt != null) reset = s.resetsAt;
    } else {
      delta = s.pct;
      peak = s.pct;
      reset = s.resetsAt;
      const windowStart = (s.resetsAt != null ? s.resetsAt : s.ts) - lengthMs - 60_000;
      start = prevTs != null ? Math.max(prevTs, windowStart) : windowStart;
    }
    const otherWindow = windowResetsAt != null && s.resetsAt != null &&
      Math.abs(s.resetsAt - windowResetsAt) > SAME_RESET_TOLERANCE;
    if (delta > 1e-9 && s.ts >= from && !otherWindow && prevTs == null) {
      out.beforeTracking += delta;
      out.total += delta;
      if (onRise) onRise({ ts: s.ts, byMember: {}, untracked: 0, beforeTracking: delta });
    } else if (delta > 1e-9 && s.ts >= from && !otherWindow) {
      const rows = scope === 'all' ? evq.all(start, s.ts) : evq.all(start, s.ts, scope);
      const weight = rows.reduce((a, r) => a + r.w, 0);
      const byMember = {};
      if (weight > 0) {
        for (const r of rows) {
          byMember[r.member] = (delta * r.w) / weight;
          out.byMember[r.member] = (out.byMember[r.member] || 0) + byMember[r.member];
        }
      } else {
        out.untracked += delta;
      }
      out.total += delta;
      if (onRise) onRise({ ts: s.ts, byMember, untracked: weight > 0 ? 0 : delta, beforeTracking: 0 });
    }
    prevTs = s.ts;
  }
  return out;
}

// The account's own split of the weekly window by product, e.g.
// seven_day_breakdown: { rows: [{ key: "claude_code", display_name: "Claude Code", percent: 89 }, ...] }
function weeklyBreakdown(raw) {
  const b = raw && raw.seven_day_breakdown;
  if (!b || !Array.isArray(b.rows)) return null;
  const rows = b.rows
    .map((r) => ({ key: String(r && r.key || '').slice(0, 40), label: String(r && (r.display_name || r.key) || '').slice(0, 40), pct: toPct(r && r.percent) }))
    .filter((r) => r.key && r.pct != null);
  return rows.length ? { rows, windowStartedAt: toMs(b.window_started_at), asOf: toMs(b.as_of) } : null;
}

module.exports = { HOUR, DAY, toMs, normalizeUsage, windowMeta, attribute, familyFromText, weeklyBreakdown };
