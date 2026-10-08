'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUsage, windowMeta, weeklyBreakdown } = require('../src/limits');
const { openStore } = require('../src/db');

const H = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();

test('normalizeUsage reads the classic shape', () => {
  const w = normalizeUsage({
    five_hour: { utilization: 42.5, resets_at: '2026-10-08T15:00:00Z' },
    seven_day: { utilization: 10, resets_at: null },
    seven_day_opus: null,
    extra_usage: { used: 3 },
  });
  assert.deepEqual(w.map((x) => x.key).sort(), ['five_hour', 'seven_day']);
  const five = w.find((x) => x.key === 'five_hour');
  assert.equal(five.pct, 42.5);
  assert.equal(five.resetsAt, Date.parse('2026-10-08T15:00:00Z'));
});

test('normalizeUsage reads the limits array with model scopes', () => {
  const w = normalizeUsage({
    limits: [
      { kind: 'session', percent: 30, resets_at: 1791500000 },
      { kind: 'weekly', percent: 12, resets_at: '2026-10-12T00:00:00Z' },
      { kind: 'weekly_scoped', percent: 55, scope: { model: 'Opus' } },
      { kind: 'weekly_scoped', percent: 5, scope: 'routines' },
      { kind: 'mystery', percent: 99 },
    ],
  });
  const byKey = Object.fromEntries(w.map((x) => [x.key, x]));
  assert.equal(byKey.five_hour.pct, 30);
  assert.equal(byKey.five_hour.resetsAt, 1791500000 * 1000);
  assert.equal(byKey.seven_day.pct, 12);
  assert.equal(byKey.seven_day_opus.pct, 55);
  assert.equal(byKey.seven_day_routines.pct, 5);
  assert.equal(Object.keys(byKey).length, 4);
});

test('windowMeta labels and scopes', () => {
  assert.equal(windowMeta('five_hour').scope, 'all');
  assert.equal(windowMeta('five_hour').lengthMs, 5 * H);
  assert.equal(windowMeta('seven_day_sonnet').scope, 'sonnet');
  assert.equal(windowMeta('seven_day_sonnet').label, 'Weekly · Sonnet');
  assert.equal(windowMeta('seven_day_cowork').scope, null);
});

function setup() {
  const store = openStore(':memory:');
  const now = Date.now();
  const reset = now + 2 * H;
  const snap = (id, ts, pct, resetsAt = reset) => ({ snapshot_id: id, ts, raw: { five_hour: { utilization: pct, resets_at: resetsAt ? iso(resetsAt) : null } } });
  const ev = (id, ts, model, output) => ({ event_id: id, ts, model, input_tokens: 0, output_tokens: output, cache_read_tokens: 0, cache_write_tokens: 0 });
  return { store, now, reset, snap, ev };
}

test('a rise is split by API-equivalent cost between members active in the interval', () => {
  const { store, now, snap, ev } = setup();
  // Same model, so the weights are the output token counts: 3:1.
  store.ingest({ member: 'asha', source: 'claude-code', events: [ev('a', now - 50 * 60e3, 'claude-sonnet-5-5', 3000)], snapshots: [] });
  store.ingest({ member: 'ravi', source: 'claude-ai', events: [ev('r', now - 40 * 60e3, 'claude-sonnet-5-5', 1000)], snapshots: [] });
  store.ingest({ member: 'asha', source: 'claude-code', events: [], snapshots: [snap('s1', now - 2 * H, 0), snap('s2', now - 30 * 60e3, 20)] });
  const l = store.stats({ from: now - 3 * H, to: now }).limits[0];
  assert.equal(l.key, 'five_hour');
  assert.equal(l.pct, 20);
  const pp = Object.fromEntries(l.contributions.members.map((m) => [m.member, m.pp]));
  assert.equal(pp.asha, 15);
  assert.equal(pp.ravi, 5);
  assert.equal(l.contributions.untracked, 0);
});

test('a rise with no tracked activity is untracked, and noise is not double counted', () => {
  const { store, now, snap, ev } = setup();
  store.ingest({ member: 'asha', source: 'claude-code', events: [ev('a', now - 80 * 60e3, 'claude-opus-5-5', 500)], snapshots: [] });
  store.ingest({
    member: 'asha', source: 'claude-code', events: [],
    snapshots: [
      snap('s1', now - 90 * 60e3, 5),
      snap('s2', now - 70 * 60e3, 15), // +10 asha
      snap('s3', now - 50 * 60e3, 14), // dips (noise)
      snap('s4', now - 30 * 60e3, 16), // +1 over the peak, nobody active
    ],
  });
  const st = store.stats({ from: now - 3 * H, to: now });
  const l = st.limits[0];
  assert.equal(l.contributions.members[0].member, 'asha');
  assert.equal(l.contributions.members[0].pp, 10);
  assert.equal(l.contributions.untracked, 1);
  assert.equal(l.contributions.beforeTracking, 5); // already used at the very first reading
  assert.equal(st.members[0].limit.five_hour, 10);
  assert.equal(st.untracked.five_hour, 1);
  assert.equal(st.beforeTracking.five_hour, 5);
});

test('a reading older than the range still counts as the previous observation', () => {
  const { store, now, snap, ev } = setup();
  store.ingest({ member: 'asha', source: 'claude-code', events: [ev('a', now - 20 * 60e3, 'claude-opus-5-5', 500)], snapshots: [] });
  // Weekly window that started 6 days ago; the only earlier reading is 10 days old,
  // outside the lookback the attribution loads, so it must come in as the seed.
  const weekly = (id, ts, pct, resetsAt) => ({ snapshot_id: id, ts, raw: { seven_day: { utilization: pct, resets_at: iso(resetsAt) } } });
  store.ingest({
    member: 'asha', source: 'claude-code', events: [],
    snapshots: [weekly('old', now - 10 * 24 * H, 70, now - 6 * 24 * H), weekly('new', now - 10 * 60e3, 3, now + 24 * H)],
  });
  const st = store.stats({ from: now - 24 * H, to: now });
  assert.equal(st.members[0].limit.seven_day, 3);
  assert.equal(st.beforeTracking.seven_day, 0);
});

test('reads the real oauth/usage response shape', () => {
  const raw = {
    five_hour: { utilization: 4, resets_at: '2026-10-08T10:50:00.450235+00:00', limit_dollars: null },
    seven_day: { utilization: 92, resets_at: '2026-10-08T07:00:00.450263+00:00' },
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    limits: [
      { kind: 'session', group: 'session', percent: 4, resets_at: '2026-10-08T10:50:00.450235+00:00', scope: null },
      { kind: 'weekly_all', group: 'weekly', percent: 92, resets_at: '2026-10-08T07:00:00.450263+00:00', scope: null },
      { kind: 'weekly_scoped', group: 'weekly', percent: 49, resets_at: '2026-10-08T07:00:00.450488+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
    ],
    seven_day_breakdown: {
      as_of: '2026-10-08T06:00:11.476759+00:00',
      window_started_at: '2026-10-01T07:00:00.450263+00:00',
      rows: [
        { key: 'claude_code', display_name: 'Claude Code', percent: 89 },
        { key: 'chat', display_name: 'Chats', percent: 11 },
      ],
    },
  };
  const byKey = Object.fromEntries(normalizeUsage(raw).map((w) => [w.key, w.pct]));
  assert.deepEqual(byKey, { five_hour: 4, seven_day: 92, seven_day_fable: 49 });
  assert.equal(windowMeta('seven_day_fable').label, 'Weekly · Fable');
  assert.equal(windowMeta('seven_day_fable').scope, 'fable');
  const b = weeklyBreakdown(raw);
  assert.deepEqual(b.rows.map((r) => r.label + ' ' + r.pct), ['Claude Code 89', 'Chats 11']);

  const store = openStore(':memory:');
  const now = Date.parse('2026-10-08T06:00:12Z');
  store.ingest({ member: 'kiran', source: 'claude-code', events: [], snapshots: [{ snapshot_id: 'r1', ts: now, raw }] }, now);
  const weekly = store.stats({ from: now - 7 * 24 * H, to: now + 1, now }).limits.find((l) => l.key === 'seven_day');
  assert.equal(weekly.breakdown.rows[1].label, 'Chats');
});

test('a new window starts counting from its own start', () => {
  const { store, now, snap, ev } = setup();
  const oldReset = now - 30 * 60e3;
  const newReset = now + 4 * H; // jittered: the new window looks like it began before the old one ended
  store.ingest({ member: 'asha', source: 'claude-code', events: [ev('a', now - 10 * 60e3, 'claude-opus-5-5', 500)], snapshots: [] });
  store.ingest({
    member: 'asha', source: 'claude-code', events: [],
    snapshots: [snap('old', now - 40 * 60e3, 90, oldReset), snap('new', now - 5 * 60e3, 8, newReset)],
  });
  const l = store.stats({ from: now - 3 * H, to: now }).limits[0];
  assert.equal(l.pct, 8);
  assert.deepEqual(l.contributions.members, [{ member: 'asha', pp: 8 }]);
});

test('an expired window shows as inactive', () => {
  const { store, now, snap } = setup();
  store.ingest({ member: 'asha', source: 'claude-code', events: [], snapshots: [snap('x', now - 6 * H, 70, now - H)] });
  const l = store.stats({ from: now - 7 * H, to: now }).limits[0];
  assert.equal(l.active, false);
  assert.equal(l.pct, 0);
  assert.equal(l.contributions, null);
});
