'use strict';
// Packs extension/ into a zip for the Chrome Web Store, without the tests.
//   node scripts/pack-extension.js        -> dist/claude-team-usage-extension-<version>.zip
// No dependencies: a small zip writer on top of node:zlib.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');

// Files under dir, with zip-style relative names. Dot files and any folder named "test"
// are left out.
function listFiles(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || (entry.isDirectory() && entry.name === 'test')) continue;
    const rel = base ? base + '/' + entry.name : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, rel));
    else if (entry.isFile()) out.push({ name: rel, full });
  }
  return out;
}

// [{ name, full }] -> zip entries with their content and modification time.
function readEntries(files) {
  return files.map((f) => ({ name: f.name, data: fs.readFileSync(f.full), mtime: fs.statSync(f.full).mtime }));
}

function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const deflated = zlib.deflateRawSync(f.data, { level: 9 });
    const deflate = deflated.length < f.data.length;
    const body = deflate ? deflated : f.data;
    const method = deflate ? 8 : 0;
    const crc = zlib.crc32(f.data) >>> 0;
    const { time, date } = dosDateTime(f.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(f.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += local.length + name.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

function packExtension(srcDir = path.join(ROOT, 'extension'), outDir = path.join(ROOT, 'dist')) {
  const manifest = JSON.parse(fs.readFileSync(path.join(srcDir, 'manifest.json'), 'utf8'));
  const files = readEntries(listFiles(srcDir));
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'claude-team-usage-extension-' + manifest.version + '.zip');
  fs.writeFileSync(out, zip(files));
  return { out, version: manifest.version, files: files.map((f) => f.name) };
}

if (require.main === module) {
  const r = packExtension();
  console.log('Packed ' + r.files.length + ' files (version ' + r.version + ') into ' + r.out);
}

module.exports = { packExtension, listFiles, readEntries, zip };
