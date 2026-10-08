'use strict';
// End to end: real server process + installer + reporter against a throwaway Claude config dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const TEAM = 'e2e-team-token-xyz';

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function startServer(dbPath) {
  // ENV_FILE points nowhere, so the server never picks up the developer's own server/.env.
  const env = { ...process.env, TEAM_TOKEN: TEAM, PORT: '0', HOST: '127.0.0.1', DB_PATH: dbPath, ENV_FILE: dbPath + '.env' };
  delete env.DASHBOARD_TOKEN;
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'index.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /listening on http:\/\/[^:]+:(\d+)/.exec(buf);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', (code) => reject(new Error('server exited ' + code)));
  });
  // Wait for the process to exit: on Windows the database file stays locked until then.
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
  });
  return { base: 'http://127.0.0.1:' + port, stop };
}

function line(id, output, ts) {
  return JSON.stringify({
    type: 'assistant', timestamp: ts, sessionId: 's1', cwd: '/work/demo',
    message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 5, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } },
  }) + '\n';
}

test('install, sync, re-sync and uninstall', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctu-e2e-'));
  const claudeDir = path.join(tmp, 'claude');
  const transcript = path.join(claudeDir, 'projects', '-work-demo', 's1.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
    model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] },
  }, null, 2));
  const recent = new Date(Date.now() - 3600e3).toISOString();
  fs.writeFileSync(transcript, line('m1', 100, recent) + line('m2', 200, recent));

  const srv = await startServer(path.join(tmp, 'usage.db'));
  t.after(async () => {
    await srv.stop();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const env = { CLAUDE_CONFIG_DIR: claudeDir };
  const stats = async () => (await fetch(srv.base + '/api/stats?from=' + (Date.now() - 2 * 86400e3), { headers: { Authorization: 'Bearer ' + TEAM } })).json();

  const install = await run(process.execPath, [path.join(ROOT, 'claude-code-hook', 'install.js'),
    '--server', srv.base, '--token', TEAM, '--name', 'Test User', '--backfill-days', '7', '--no-limits'], env);
  assert.equal(install.code, 0, install.out);
  assert.match(install.out, /sent 2 usage event/);

  const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
  assert.equal(settings.model, 'opus');
  const stopCmds = settings.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(stopCmds.includes('echo existing'));
  assert.equal(stopCmds.filter((c) => c.includes('team-usage/report.js')).length, 1);
  assert.equal(settings.hooks.SessionEnd.length, 1);

  let st = await stats();
  assert.equal(st.members[0].member, 'test user');
  assert.equal(st.members[0].messages, 2);

  fs.appendFileSync(transcript, line('m3', 300, new Date().toISOString()));
  const sync = await run(process.execPath, [path.join(claudeDir, 'team-usage', 'report.js'), '--now'], env);
  assert.equal(sync.code, 0, sync.out);
  assert.match(sync.out, /sent 1 usage event/);
  st = await stats();
  assert.equal(st.members[0].messages, 3);
  assert.equal(st.members[0].output, 600);

  const again = await run(process.execPath, [path.join(ROOT, 'claude-code-hook', 'install.js'),
    '--server', srv.base, '--token', TEAM, '--name', 'Test User', '--no-limits'], env);
  assert.equal(again.code, 0, again.out);
  const settings2 = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
  assert.equal(settings2.hooks.Stop.flatMap((g) => g.hooks).filter((h) => h.command.includes('team-usage/report.js')).length, 1);

  const status = await run(process.execPath, [path.join(claudeDir, 'team-usage', 'report.js'), '--status'], env);
  assert.match(status.out, /Member\s+: test user/);
  assert.doesNotMatch(status.out, new RegExp(TEAM));

  const un = await run(process.execPath, [path.join(ROOT, 'claude-code-hook', 'uninstall.js')], env);
  assert.equal(un.code, 0, un.out);
  const settings3 = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
  assert.deepEqual(settings3.hooks, { Stop: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] });
});
