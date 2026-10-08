'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadEnvFile } = require('../src/index');

const INDEX = path.join(__dirname, '..', 'src', 'index.js');

test('loadEnvFile reads UTF-8, UTF-8 with BOM and UTF-16 files (Windows PowerShell)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctu-env-'));
  const cases = {
    plain: Buffer.from('CTU_A=one\n'),
    bom: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('CTU_B=two\r\n')]),
    utf16: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('CTU_C=three\r\n', 'utf16le')]),
  };
  for (const [name, buf] of Object.entries(cases)) fs.writeFileSync(path.join(dir, name), buf);
  for (const name of Object.keys(cases)) assert.equal(loadEnvFile(path.join(dir, name)), true);
  assert.equal(process.env.CTU_A, 'one');
  assert.equal(process.env.CTU_B, 'two');
  assert.equal(process.env.CTU_C, 'three');
  assert.equal(loadEnvFile(path.join(dir, 'missing')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('first start without tokens creates a team token and a separate dashboard token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctu-first-'));
  const envFile = path.join(dir, '.env');
  const env = { ...process.env, ENV_FILE: envFile, PORT: '0', HOST: '127.0.0.1', DB_PATH: path.join(dir, 'u.db') };
  delete env.TEAM_TOKEN;
  delete env.DASHBOARD_TOKEN;
  const child = spawn(process.execPath, [INDEX], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; if (/Keep this window open/.test(buf)) resolve(buf); });
    child.on('exit', (code) => reject(new Error('exited ' + code + ': ' + buf)));
  });
  const closed = new Promise((r) => child.once('close', r));
  child.kill();
  const token = /TEAM TOKEN:\s+(\S+)/.exec(out)[1];
  const dash = /DASHBOARD TOKEN:\s+(\S+)/.exec(out)[1];
  assert.ok(token.length >= 24);
  assert.ok(dash.length >= 24);
  assert.notEqual(token, dash);
  assert.equal(fs.readFileSync(envFile, 'utf8'), 'TEAM_TOKEN=' + token + '\nDASHBOARD_TOKEN=' + dash + '\n');
  assert.match(out, new RegExp('Manager dashboard: http://\\S+/#token=' + dash));
  assert.doesNotMatch(out, /no separate DASHBOARD_TOKEN/);
  await closed;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
