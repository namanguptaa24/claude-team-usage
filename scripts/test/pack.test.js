'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { packExtension } = require('../pack-extension');
const { packTeammates } = require('../pack-teammates');

const ROOT = path.join(__dirname, '..', '..');
const EXT = path.join(ROOT, 'extension');

// Reads a zip back through its central directory, the way the Chrome Web Store does.
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + size);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    assert.equal(zlib.crc32(data) >>> 0, crc, name);
    out[name] = data;
    p += 46 + nameLen;
  }
  return out;
}

test('the Web Store zip has the extension files, unchanged, and no tests', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctu-pack-'));
  const r = packExtension(EXT, dir);
  const version = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).version;
  assert.equal(path.basename(r.out), 'claude-team-usage-extension-' + version + '.zip');
  const files = unzip(fs.readFileSync(r.out));
  assert.ok(files['manifest.json']);
  assert.ok(files['managed_schema.json']);
  assert.ok(files['icons/icon128.png']);
  assert.ok(!Object.keys(files).some((n) => n.startsWith('test/')));
  for (const [name, data] of Object.entries(files)) {
    assert.ok(data.equals(fs.readFileSync(path.join(EXT, ...name.split('/')))), name);
  }
  // Every file the manifest points at is in the zip.
  const m = JSON.parse(files['manifest.json']);
  const referenced = [m.background.service_worker, m.action.default_popup, m.options_page, m.storage.managed_schema,
    ...m.content_scripts.flatMap((c) => c.js), ...Object.values(m.icons), 'config.js'];
  for (const f of referenced) assert.ok(files[f], f);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the teammates zip has the installer and the extension, and never the server, tokens or data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctu-team-'));
  const r = packTeammates({ server: 'http://192.168.1.10:8787', outDir: dir });
  assert.equal(path.basename(r.out), 'claude-team-usage.zip');
  const files = unzip(fs.readFileSync(r.out));
  const names = Object.keys(files);
  for (const f of ['install-claude-code-hook.cmd', 'README.md', 'claude-code-hook/install.js', 'claude-code-hook/report.js',
    'claude-code-hook/lib/common.js', 'claude-code-hook/lib/transcript.js', 'claude-code-hook/lib/limits.js',
    'extension/manifest.json', 'extension/config.js', 'TEAMMATE-SETUP.txt']) {
    assert.ok(files[f], f);
  }
  assert.deepEqual(names.filter((n) => /(^|\/)(server|test|dist|\.git|node_modules)\/|\.env$|\.db$/.test(n)), []);
  // No token from a real server/.env can be inside, whatever it is.
  const envFile = path.join(ROOT, 'server', '.env');
  if (fs.existsSync(envFile)) {
    for (const m of fs.readFileSync(envFile, 'utf8').matchAll(/^[A-Z_]*TOKEN=(.+)$/gm)) {
      const secret = m[1].trim();
      for (const [n, data] of Object.entries(files)) assert.ok(!data.includes(secret), 'a token from server/.env is in ' + n);
    }
  }
  const setup = files['TEAMMATE-SETUP.txt'].toString('utf8');
  assert.match(setup, /Server address:\s+http:\/\/192\.168\.1\.10:8787\r\n/);
  assert.match(setup, /Server URL:\s+http:\/\/192\.168\.1\.10:8787/);
  assert.doesNotMatch(setup, /[^\r]\n/); // CRLF throughout, for Notepad
  fs.rmSync(dir, { recursive: true, force: true });
});
