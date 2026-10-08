'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extractEvent, scanTranscripts, projectName, sourceFor } = require('../lib/transcript');
const { removeOurHooks } = require('../lib/common');
const { pickUsage, tokenFromCredentials } = require('../lib/limits');

function assistant(id, output, { ts = '2026-10-08T10:00:00.000Z', model = 'claude-opus-5-5', cwd = 'D:\\work\\shop-app' } = {}) {
  return JSON.stringify({
    type: 'assistant', timestamp: ts, sessionId: 'sess-1', cwd, requestId: 'req_' + id,
    message: { id, model, usage: { input_tokens: 3, output_tokens: output, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 } },
  });
}

test('extractEvent reads model and usage, skips synthetic and empty records', () => {
  const ev = extractEvent(JSON.parse(assistant('msg_1', 42)));
  assert.equal(ev.event_id, 'cc:msg_1');
  assert.equal(ev.model, 'claude-opus-5-5');
  assert.equal(ev.output_tokens, 42);
  assert.equal(ev.cache_read_tokens, 1000);
  assert.equal(ev.cache_write_tokens, 200);
  assert.equal(ev.project, 'shop-app');
  assert.equal(extractEvent(JSON.parse(assistant('msg_2', 5, { model: '<synthetic>' }))), null);
  assert.equal(extractEvent({ type: 'user', message: { content: 'hi' } }), null);
  assert.equal(extractEvent({ type: 'assistant', timestamp: 'x', message: { id: 'm', model: 'claude-opus-5', usage: {} } }), null);
});

test('the source tells VS Code apart from the terminal', () => {
  const rec = (entrypoint) => ({ ...JSON.parse(assistant('m', 1)), entrypoint });
  assert.equal(extractEvent(rec('claude-vscode')).source, 'vscode');
  assert.equal(extractEvent(rec('cli')).source, 'claude-code');
  assert.equal(extractEvent(rec(undefined)).source, 'claude-code');
  assert.equal(sourceFor('claude-jetbrains'), 'jetbrains');
});

test('projectName handles both path styles', () => {
  assert.equal(projectName('/home/a/projects/api/'), 'api');
  assert.equal(projectName('C:\\Users\\a\\my app'), 'my app');
  assert.equal(projectName(''), null);
});

test('scanTranscripts reads incrementally, merges split records and waits for partial lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctu-scan-'));
  const sub = path.join(dir, 'D--work-shop-app', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const file = path.join(dir, 'D--work-shop-app', 's1.jsonl');
  const partial = assistant('msg_c', 7);
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
    assistant('msg_a', 10), // first content block
    assistant('msg_a', 50), // same response, final count
    assistant('msg_b', 20),
  ].join('\n') + '\n' + partial.slice(0, 40));
  fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), assistant('msg_sub', 9) + '\n');

  const state = { files: {} };
  const r1 = scanTranscripts(dir, state, {});
  const ids = r1.events.map((e) => e.event_id).sort();
  assert.deepEqual(ids, ['cc:msg_a', 'cc:msg_b', 'cc:msg_sub']);
  assert.equal(r1.events.find((e) => e.event_id === 'cc:msg_a').output_tokens, 50);
  assert.ok(state.files[file].offset < fs.statSync(file).size, 'offset stops before the unfinished line');

  fs.appendFileSync(file, partial.slice(40) + '\n');
  const r2 = scanTranscripts(dir, state, {});
  assert.deepEqual(r2.events.map((e) => e.event_id), ['cc:msg_c']);
  assert.equal(scanTranscripts(dir, state, {}).events.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scanTranscripts initOnly skips history and cutoff filters old events', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctu-scan-'));
  const file = path.join(dir, 'p', 's.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, assistant('old', 5, { ts: '2020-01-01T00:00:00Z' }) + '\n' + assistant('new', 6, { ts: new Date().toISOString() }) + '\n');

  const fresh = { files: {} };
  assert.equal(scanTranscripts(dir, fresh, { initOnly: true }).events.length, 0);
  assert.equal(fresh.files[file].offset, fs.statSync(file).size);

  const backfill = { files: {} };
  const r = scanTranscripts(dir, backfill, { cutoff: Date.now() - 86_400_000 });
  assert.deepEqual(r.events.map((e) => e.event_id), ['cc:new']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('removeOurHooks keeps other hooks intact', () => {
  const groups = [
    { hooks: [{ type: 'command', command: 'echo hi' }, { type: 'command', command: 'node "C:/Users/a/.claude/team-usage/report.js"' }] },
    { hooks: [{ type: 'command', command: 'node C:\\Users\\a\\.claude\\team-usage\\report.js' }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'lint.sh' }] },
  ];
  assert.deepEqual(removeOurHooks(groups), [
    { hooks: [{ type: 'command', command: 'echo hi' }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'lint.sh' }] },
  ]);
  assert.deepEqual(removeOurHooks(undefined), []);
});

test('limit helpers keep only window data and respect token expiry', () => {
  assert.deepEqual(Object.keys(pickUsage({ five_hour: {}, seven_day_opus: {}, limits: [], email: 'x', extra_usage: {} })).sort(), ['five_hour', 'limits', 'seven_day_opus']);
  const now = Date.now();
  assert.equal(tokenFromCredentials({ claudeAiOauth: { accessToken: 'abc', expiresAt: now + 3600e3 } }, now), 'abc');
  assert.equal(tokenFromCredentials({ claudeAiOauth: { accessToken: 'abc', expiresAt: now - 1 } }, now), null);
  assert.equal(tokenFromCredentials({}, now), null);
});
