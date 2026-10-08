'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/index');
const { openStore } = require('../src/db');
const { toCsv } = require('../src/csv');

const TEAM = 'team-token-123456';
const DASH = 'dash-token-123456';
const H = 3_600_000;
const BASE = Date.UTC(2026, 9, 6, 12); // noon UTC, so every reading below falls on Oct 6 in UTC
const RESET = BASE + 3 * 24 * H;

const ev = (id, ts, model = 'claude-opus-5-5', output = 50_000) => ({ event_id: id, ts, model, output_tokens: output });
const snap = (id, ts, weekly) => ({
  snapshot_id: id, ts, raw: { seven_day: { utilization: weekly, resets_at: new Date(RESET).toISOString() } },
});

// Weekly limit: 10% already used when tracking starts, +20 while only asha works,
// then +5 while nobody tracked is active.
function seeded() {
  const store = openStore(':memory:');
  store.ingest({ member: 'kiran', source: 'claude-code', events: [], snapshots: [snap('s1', BASE, 10)] });
  store.ingest({ member: 'asha', source: 'claude-code', events: [ev('a1', BASE + H)], snapshots: [snap('s2', BASE + 2 * H, 30)] });
  store.ingest({ member: 'kiran', source: 'vscode', events: [], snapshots: [snap('s3', BASE + 2.5 * H, 35)] });
  return store;
}

test('alerts flag a big share of the weekly limit in one day, and limits running high', () => {
  const store = seeded();
  const now = BASE + 3 * H;
  assert.deepEqual(store.alerts({ now }), [{ kind: 'member', level: 'warn', member: 'asha', pp: 20 }]);

  store.setSettings({ alertMemberDailyPct: 5, alertAccountPct: 30 });
  const a = store.alerts({ now });
  assert.deepEqual(a.map((x) => x.kind), ['limit', 'member', 'untracked']);
  assert.equal(a[0].key, 'seven_day');
  assert.equal(a[0].pct, 35);
  assert.equal(a[1].level, 'crit'); // 20 points is at least twice the threshold
  assert.equal(a[2].pp, 5);
  // "Before tracking" is never an alert, and a day later the rises are out of the window.
  assert.deepEqual(store.alerts({ now: BASE + 30 * H }).map((x) => x.kind), ['limit']);
  store.close();
});

test('renaming merges members and keeps routing the old name', () => {
  const store = seeded();
  store.ingest({ member: 'kirn', source: 'claude-ai', events: [ev('n1', BASE + 4 * H, 'claude-sonnet-5-5', 100)], snapshots: [] });

  assert.deepEqual(store.renameMember('kirn', 'kiran'), { member: 'kiran', merged: true, events: 1, snapshots: 0 });
  store.ingest({ member: 'kirn', source: 'claude-ai', events: [ev('n2', BASE + 5 * H, 'claude-sonnet-5-5', 100)], snapshots: [] });
  let members = store.listMembers();
  assert.deepEqual(members.map((m) => m.member), ['asha', 'kiran']);
  const kiran = members.find((m) => m.member === 'kiran');
  assert.equal(kiran.messages, 2);
  assert.deepEqual(kiran.aliases, ['kirn']);
  assert.equal(store.summary({ member: 'kirn', now: BASE + 6 * H }).member, 'kiran');

  // Renaming again moves the old aliases along; renaming back frees the name.
  assert.equal(store.renameMember('kiran', 'kiran rao').merged, false);
  assert.equal(store.resolveMember('kirn'), 'kiran rao');
  store.renameMember('kiran rao', 'kiran');
  assert.equal(store.resolveMember('kiran'), 'kiran');
  assert.equal(store.resolveMember('kirn'), 'kiran');
  assert.equal(store.resolveMember('kiran rao'), 'kiran');
  members = store.listMembers();
  assert.deepEqual(members.find((m) => m.member === 'kiran').aliases, ['kiran rao', 'kirn']);

  assert.equal(store.renameMember('nobody', 'someone'), null);
  store.close();
});

test('deleting a member removes their usage and limit readings', () => {
  const store = seeded();
  assert.deepEqual(store.deleteMember('kiran'), { member: 'kiran', events: 0, snapshots: 2 });
  assert.deepEqual(store.listMembers().map((m) => m.member), ['asha']);
  assert.equal(store.deleteMember('kiran'), null);
  store.close();
});

test('the by-member download splits the limit by day and keeps untracked usage apart', () => {
  const store = seeded();
  const range = { from: BASE - 12 * H, to: BASE + 12 * H, tzOffsetMin: 0 };
  const m = store.exportRows({ view: 'members', ...range });
  assert.deepEqual(m.header.slice(0, 4), ['Date', 'Member', 'Weekly limit used (%)', '5-hour limit used (%)']);
  assert.deepEqual(m.rows.map((r) => r.slice(0, 5)), [
    ['2026-10-06', 'Asha', 20, 0, 1],
    ['2026-10-06', 'Untracked', 5, 0, null],
    ['2026-10-06', 'Before tracking', 10, 0, null],
  ]);
  assert.ok(m.rows[0][6] > 0);
  // A member filter leaves out the account-wide rows.
  assert.deepEqual(store.exportRows({ view: 'members', ...range, member: 'asha' }).rows.map((r) => r[1]), ['Asha']);

  // Days follow the viewer's time zone: 13:00 UTC is already Oct 7 at UTC+12.
  const d = store.exportRows({ view: 'detail', ...range, tzOffsetMin: 720 });
  assert.deepEqual(d.rows.map((r) => r.slice(0, 8)), [['2026-10-07', 'Asha', 'Claude Code CLI', 'claude-opus-5-5', 'opus', 1, 0, 50000]]);
  assert.equal(d.rows[0][11], 'exact');
  store.close();
});

test('CSV opens in Excel and never runs a name as a formula', () => {
  const csv = toCsv(['Member', 'Cost'], [['=HYPERLINK("x")', 1.5], ['a,b', null], ['-dash', -2]]);
  assert.equal(csv, '﻿Member,Cost\r\n"\'=HYPERLINK(""x"")",1.5\r\n"a,b",\r\n\'-dash,-2\r\n');
});

async function startServer(dashboardToken) {
  const store = openStore(':memory:');
  const server = http.createServer(createApp({ store, teamToken: TEAM, dashboardToken, log: { error() {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  return { base, close: () => new Promise((r) => server.close(() => { store.close(); r(); })) };
}
const call = (base, path, token, body) => fetch(base + path, {
  method: body ? 'POST' : 'GET',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});

test('admin API', async (t) => {
  const srv = await startServer(DASH);
  t.after(srv.close);
  const now = Date.now();
  await call(srv.base, '/api/ingest', TEAM, {
    member: 'Kirn', source: 'claude-ai', events: [{ event_id: 'w1', ts: now - 60e3, model: '=cmd', output_tokens: 10, estimated: true }],
  });

  await t.test('only the dashboard token reaches the admin tools', async () => {
    assert.equal((await call(srv.base, '/api/admin/members')).status, 401);
    assert.equal((await call(srv.base, '/api/admin/members', TEAM)).status, 401);
    assert.equal((await call(srv.base, '/api/admin/members/delete', TEAM, { member: 'kirn' })).status, 401);
    const res = await call(srv.base, '/api/admin/members', DASH);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).members.map((m) => m.member), ['kirn']);
    assert.equal((await (await call(srv.base, '/api/ping', DASH)).json()).admin, true);
    assert.equal((await (await call(srv.base, '/api/ping', TEAM)).json()).admin, false);
  });

  await t.test('rename and delete check their input', async () => {
    assert.equal((await call(srv.base, '/api/admin/members/rename', DASH, { from: 'kirn' })).status, 400);
    assert.equal((await call(srv.base, '/api/admin/members/rename', DASH, { from: 'ghost', to: 'x' })).status, 404);
    const r = await (await call(srv.base, '/api/admin/members/rename', DASH, { from: 'KIRN', to: ' Kiran ' })).json();
    assert.deepEqual(r, { ok: true, member: 'kiran', merged: false, events: 1, snapshots: 0 });
    assert.equal((await call(srv.base, '/api/admin/members/delete', DASH, { member: 'ghost' })).status, 404);
  });

  await t.test('settings are validated and come back with the stats', async () => {
    assert.equal((await call(srv.base, '/api/admin/settings', DASH, { alertAccountPct: 0 })).status, 400);
    assert.equal((await call(srv.base, '/api/admin/settings', DASH, { alertAccountPct: 'lots' })).status, 400);
    const ok = await (await call(srv.base, '/api/admin/settings', DASH, { alertAccountPct: '70' })).json();
    assert.deepEqual(ok.settings, { alertMemberDailyPct: 15, alertAccountPct: 70 });
    const st = await (await call(srv.base, '/api/stats', DASH)).json();
    assert.deepEqual(st.settings, ok.settings);
    assert.deepEqual(st.viewer, { admin: true });
    assert.ok(Array.isArray(st.alerts));
  });

  await t.test('the spreadsheet download needs the dashboard token', async () => {
    assert.equal((await call(srv.base, '/api/export.csv', TEAM)).status, 401);
    const res = await call(srv.base, '/api/export.csv?view=detail&tz=330&from=' + (now - 86400e3) + '&to=' + now, DASH);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/csv/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="claude-usage-by-model-\d{4}-\d\d-\d\d-to-\d{4}-\d\d-\d\d\.csv"/);
    const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
    assert.ok(text.startsWith('﻿Date,Member,App,Model,'));
    assert.match(text, /,Kiran,claude\.ai,'=cmd,other,1,/);
    assert.match(text, /,estimated\r\n$/);
    const byMember = await call(srv.base, '/api/export.csv?view=members', DASH);
    assert.match(byMember.headers.get('content-disposition'), /claude-usage-by-member-/);
  });
});

test('without a separate DASHBOARD_TOKEN the admin tools are off', async (t) => {
  const srv = await startServer(undefined);
  t.after(srv.close);
  const res = await call(srv.base, '/api/admin/members', TEAM);
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /DASHBOARD_TOKEN/);
  assert.equal((await call(srv.base, '/api/admin/settings', TEAM, { alertAccountPct: 50 })).status, 403);
  assert.deepEqual((await (await call(srv.base, '/api/stats', TEAM)).json()).viewer, { admin: false });
});
