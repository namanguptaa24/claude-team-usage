'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/index');
const { openStore } = require('../src/db');

const TEAM = 'team-token-123456';
const DASH = 'dash-token-123456';

async function startServer() {
  const store = openStore(':memory:');
  const server = http.createServer(createApp({ store, teamToken: TEAM, dashboardToken: DASH, log: { error() {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  return { base, close: () => new Promise((r) => server.close(() => { store.close(); r(); })) };
}

const post = (base, path, body, token) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const get = (base, path, token) => fetch(base + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} });

test('HTTP API', async (t) => {
  const srv = await startServer();
  t.after(srv.close);
  const now = Date.now();

  await t.test('health is public, ping needs a token', async () => {
    assert.equal((await get(srv.base, '/api/health')).status, 200);
    assert.equal((await get(srv.base, '/api/ping')).status, 401);
    assert.equal((await (await get(srv.base, '/api/ping', TEAM)).json()).role, 'team');
    assert.equal((await (await get(srv.base, '/api/ping', DASH)).json()).role, 'dashboard');
  });

  await t.test('ingest requires the team token and a valid body', async () => {
    assert.equal((await post(srv.base, '/api/ingest', { member: 'x', source: 'claude-code' })).status, 401);
    assert.equal((await post(srv.base, '/api/ingest', { member: 'x', source: 'claude-code' }, DASH)).status, 401);
    assert.equal((await post(srv.base, '/api/ingest', '{nope', TEAM)).status, 400);
    assert.equal((await post(srv.base, '/api/ingest', { source: 'claude-code' }, TEAM)).status, 400);
  });

  await t.test('ingest stores events idempotently and keeps the largest counts', async () => {
    const body = (output) => ({
      member: '  Asha  Verma ', source: 'claude-code', machine: 'pc-1',
      events: [
        { event_id: 'cc:1', ts: new Date(now - 60e3).toISOString(), model: 'claude-opus-5-5', input_tokens: 10, output_tokens: output, cache_read_tokens: 1000, cache_write_tokens: 100 },
        { event_id: 'bad' }, // rejected: no ts/model
      ],
      snapshots: [{ snapshot_id: 'snap-' + output, ts: now - 30e3, raw: { five_hour: { utilization: 12, resets_at: new Date(now + 3600e3).toISOString() } } }],
    });
    const r1 = await (await post(srv.base, '/api/ingest', body(100), TEAM)).json();
    assert.equal(r1.ok, true);
    assert.equal(r1.events, 1);
    assert.equal(r1.rejected, 1);
    assert.equal(r1.windows, 1);
    await post(srv.base, '/api/ingest', body(500), TEAM);
    await post(srv.base, '/api/ingest', body(200), TEAM);

    const res = await get(srv.base, '/api/stats?from=' + (now - 86400e3) + '&to=' + (now + 1000) + '&tz=330', DASH);
    assert.equal(res.status, 200);
    const st = await res.json();
    assert.equal(st.members.length, 1);
    assert.equal(st.members[0].member, 'asha verma');
    assert.equal(st.members[0].messages, 1);
    assert.equal(st.members[0].output, 500);
    assert.equal(st.byMemberModel[0].family, 'opus');
    assert.equal(st.limits[0].key, 'five_hour');
    assert.equal(st.limits[0].pct, 12);
    assert.equal(st.limits[0].contributions.beforeTracking, 12); // first reading ever
  });

  await t.test('per-event source and the popup summary', async () => {
    await post(srv.base, '/api/ingest', {
      member: 'asha verma', source: 'claude-code',
      events: [
        { event_id: 'cc:vs1', ts: now - 120e3, model: 'claude-fable-5-1', output_tokens: 1000, source: 'vscode' },
        { event_id: 'cc:cli1', ts: now - 110e3, model: 'claude-sonnet-5-5', output_tokens: 1000, source: 'BAD SOURCE!' },
      ],
    }, TEAM);
    const res = await get(srv.base, '/api/summary?member=Asha%20Verma&tz=330', TEAM);
    assert.equal(res.status, 200);
    const s = await res.json();
    assert.equal(s.member, 'asha verma');
    const sources = Object.fromEntries(s.week.rows.map((r) => [r.model, r.source]));
    assert.equal(sources['claude-fable-5-1'], 'vscode');
    assert.equal(sources['claude-sonnet-5-5'], 'claude-code'); // invalid per-event source falls back to the batch
    assert.equal(s.week.messages, 3);
    assert.equal(s.team, null); // a separate DASHBOARD_TOKEN hides the team list from the team token
    const asDash = await (await get(srv.base, '/api/summary?member=asha%20verma', DASH)).json();
    assert.equal(asDash.team[0].member, 'asha verma');
    assert.equal((await get(srv.base, '/api/summary?member=x')).status, 401);
    assert.equal((await get(srv.base, '/api/summary', TEAM)).status, 400);
  });

  await t.test('a short custom range, e.g. 10 minutes, can use minute bars', async () => {
    const base = Math.floor(now / 60e3) * 60e3 - 30 * 60e3; // a whole minute, half an hour ago
    const ev = (id, ts) => ({ event_id: id, ts, model: 'claude-sonnet-5-5', output_tokens: 100 });
    await post(srv.base, '/api/ingest', {
      member: 'ravi', source: 'claude-code',
      events: [ev('m1', base + 10e3), ev('m2', base + 3 * 60e3 + 5e3), ev('m3', base + 11 * 60e3)], // m3 is after the 10 minutes
    }, TEAM);
    const range = '&from=' + base + '&to=' + (base + 10 * 60e3);
    const st = await (await get(srv.base, '/api/stats?member=ravi&bucket=minute&tz=330' + range, DASH)).json();
    assert.equal(st.range.bucket, 'minute');
    assert.equal(st.range.bucketMs, 60e3);
    assert.deepEqual(st.series.map((r) => r.t), [base, base + 3 * 60e3]);
    assert.equal(st.members[0].messages, 2);
    assert.equal((await (await get(srv.base, '/api/stats?bucket=week', DASH)).json()).range.bucket, 'day');
  });

  await t.test('stats needs the dashboard token', async () => {
    assert.equal((await get(srv.base, '/api/stats')).status, 401);
    assert.equal((await get(srv.base, '/api/stats', TEAM)).status, 401);
  });

  await t.test('CORS preflight is answered for the browser extension', async () => {
    const res = await fetch(srv.base + '/api/ingest', { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('access-control-allow-headers'), /Authorization/);
  });

  await t.test('serves the dashboard with a CSP and blocks path traversal', async () => {
    const res = await fetch(srv.base + '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(await res.text(), /Claude Team Usage/);
    assert.equal((await fetch(srv.base + '/app.js')).status, 200);
    assert.equal((await fetch(srv.base + '/..%2fsrc%2fdb.js')).status, 404);
    assert.equal((await fetch(srv.base + '/../package.json')).status, 404);
  });
});
