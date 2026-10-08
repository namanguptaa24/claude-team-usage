'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK_MARKER = 'team-usage/report.js';

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, data, mode) {
  const text = JSON.stringify(data, null, 2) + '\n';
  const tmp = file + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, text, mode ? { mode } : undefined);
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    fs.writeFileSync(file, text, mode ? { mode } : undefined);
  }
}

function makeLogger(dir, verbose) {
  const file = path.join(dir, 'report.log');
  return (msg) => {
    if (verbose) console.log(msg);
    try {
      if (fs.statSync(file).size > 1_000_000) fs.renameSync(file, file + '.1');
    } catch { /* no log yet */ }
    try { fs.appendFileSync(file, new Date().toISOString() + ' ' + msg + '\n'); } catch { /* ignore */ }
  };
}

function joinUrl(base, p) {
  return String(base).trim().replace(/\/+$/, '') + p;
}

function isOurHook(h) {
  return !!h && typeof h.command === 'string' && h.command.replace(/\\/g, '/').includes(HOOK_MARKER);
}

// Remove our hook from a Claude Code hook-group list, keeping everything else intact.
function removeOurHooks(groups) {
  if (!Array.isArray(groups)) return [];
  const out = [];
  for (const g of groups) {
    if (isOurHook(g)) continue;
    if (g && Array.isArray(g.hooks)) {
      const hooks = g.hooks.filter((h) => !isOurHook(h));
      if (hooks.length === 0) continue;
      out.push({ ...g, hooks });
    } else {
      out.push(g);
    }
  }
  return out;
}

module.exports = { HOOK_MARKER, claudeDir, readJson, writeJsonAtomic, makeLogger, joinUrl, removeOurHooks };
