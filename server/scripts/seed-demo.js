'use strict';
// Fills a database with two weeks of made-up usage so you can try the dashboard.
//   node server/scripts/seed-demo.js data/demo.db
//   DB_PATH=data/demo.db TEAM_TOKEN=demo-token-123 node server/src/index.js
const path = require('node:path');
const { openStore } = require('../src/db');

const file = process.argv[2] || path.join(__dirname, '..', 'data', 'demo.db');
const store = openStore(file);
const H = 3_600_000;
const now = Date.now();
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const people = [
  { member: 'asha', source: 'claude-code', models: ['claude-opus-5-5', 'claude-opus-5-5', 'claude-fable-5-1'], perDay: 220 },
  { member: 'ravi', source: 'claude-code', models: ['claude-sonnet-5-5', 'claude-opus-5-5'], perDay: 140 },
  { member: 'neha', source: 'claude-ai', models: ['claude-sonnet-5-5', 'claude-haiku-4-5'], perDay: 45 },
  { member: 'vikram', source: 'claude-ai', models: ['claude-fable-5-1', 'claude-sonnet-5-5'], perDay: 25 },
];

let n = 0;
for (const p of people) {
  const events = [];
  for (let d = 13; d >= 0; d--) {
    const count = Math.round(p.perDay * (0.4 + rand()) * (d % 7 >= 5 ? 0.3 : 1));
    for (let i = 0; i < count; i++) {
      const ts = now - d * 24 * H - Math.floor(rand() * 10 * H);
      if (ts > now) continue;
      const model = p.models[Math.floor(rand() * p.models.length)];
      const web = p.source === 'claude-ai';
      events.push({
        event_id: 'demo:' + p.member + ':' + n++,
        ts,
        model,
        input_tokens: web ? 400 + Math.floor(rand() * 3000) : Math.floor(rand() * 20),
        output_tokens: 200 + Math.floor(rand() * (web ? 1500 : 2500)),
        cache_read_tokens: web ? 0 : 20_000 + Math.floor(rand() * 150_000),
        cache_write_tokens: web ? 0 : Math.floor(rand() * 12_000),
        estimated: web ? 1 : 0,
        session_id: p.member + '-' + d,
        project: web ? null : ['shop-app', 'crm', 'landing'][Math.floor(rand() * 3)],
      });
    }
  }
  store.ingest({ member: p.member, source: p.source, machine: 'demo', events, snapshots: [] });
}

// Limit snapshots: the 5-hour window started 3h ago, the week resets in 3 days.
const reset5 = now + 2 * H;
const reset7 = now + 3 * 24 * H;
let p5 = 0;
let p7 = 38;
const snaps = [];
for (let t = now - 3 * H; t <= now - 60_000; t += 6 * 60_000) {
  p5 = Math.min(100, p5 + rand() * 2.4);
  p7 = Math.min(100, p7 + rand() * 0.25);
  snaps.push({
    snapshot_id: 'demo-snap-' + t,
    ts: t,
    raw: {
      five_hour: { utilization: Math.round(p5), resets_at: new Date(reset5).toISOString() },
      seven_day: { utilization: Math.round(p7), resets_at: new Date(reset7).toISOString() },
      seven_day_opus: { utilization: Math.round(p7 * 1.4), resets_at: new Date(reset7).toISOString() },
    },
  });
}
store.ingest({ member: 'asha', source: 'claude-code', machine: 'demo', events: [], snapshots: snaps });
store.close();
console.log('Seeded ' + n + ' events and ' + snaps.length + ' limit snapshots into ' + path.resolve(file));
