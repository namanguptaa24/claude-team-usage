#!/usr/bin/env node
'use strict';
// Installs the Claude Code usage reporter for one team member.
//
//   node install.js --server http://192.168.1.10:8787 --token <TEAM_TOKEN> --name asha --backfill-days 30
//
// Options:
//   --server URL          team server address
//   --token TOKEN         TEAM_TOKEN from the server
//   --name NAME           your name (use the same name in the Chrome extension)
//   --backfill-days N     also send the last N days of history (default: ask, or 0)
//   --no-limits           do not read the plan's rate-limit percentage
//   --no-project-names    do not send project folder names
//   --skip-verify         do not test the connection first
// Run again any time to change settings. Remove with: node uninstall.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { spawnSync } = require('node:child_process');
const { claudeDir, readJson, writeJsonAtomic, joinUrl, removeOurHooks } = require('./lib/common');

const FILES = ['report.js', 'lib/common.js', 'lib/transcript.js', 'lib/limits.js'];
const HOOK_EVENTS = ['Stop', 'SessionEnd'];

function parseArgs(argv) {
  const a = { limits: true, projectNames: true, verify: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--server') a.server = next();
    else if (k === '--token') a.token = next();
    else if (k === '--name') a.name = next();
    else if (k === '--backfill-days') a.backfillDays = Number(next());
    else if (k === '--no-limits') a.limits = false;
    else if (k === '--no-project-names') a.projectNames = false;
    else if (k === '--skip-verify') a.verify = false;
    else if (k === '-h' || k === '--help') a.help = true;
    else fail('Unknown option: ' + k);
  }
  return a;
}

function fail(msg) {
  console.error('\n✖ ' + msg);
  process.exit(1);
}

function nodeCommand() {
  const exe = process.execPath.replace(/\\/g, '/');
  if (process.platform === 'win32') {
    // A bare command name works in both Git Bash and PowerShell; a quoted path does not.
    const r = spawnSync('node --version', { shell: true, stdio: 'ignore' });
    if (r.status === 0) return 'node';
    return exe.includes(' ') ? fail('Node.js is not on PATH and its path contains spaces. Add Node to PATH and run again.') : exe;
  }
  return '"' + exe + '"';
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 16).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  const dest = path.join(claudeDir(), 'team-usage');
  const existing = readJson(path.join(dest, 'config.json'), {});
  const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (q, def) => {
    if (!rl) return def;
    const ans = (await rl.question(def ? q + ' [' + def + ']: ' : q + ': ')).trim();
    return ans || def;
  };

  console.log('Claude Team Usage: Claude Code reporter setup\n');
  const server = String(a.server || (await ask('Server URL (on the server PC itself: http://localhost:8787, others: http://<its IP>:8787)', existing.server || 'http://localhost:8787')) || '').trim().replace(/\/+$/, '');
  try {
    const u = new URL(server);
    if (!/^https?:$/.test(u.protocol)) throw new Error('bad protocol');
  } catch { fail('A valid server URL is required (http:// or https://).'); }

  let token = a.token;
  if (!token && rl) token = (await rl.question('Team token' + (existing.token ? ' (press Enter to keep the current one)' : '') + ': ')).trim();
  token = token || existing.token;
  if (!token) fail('The team token is required (--token).');

  const name = String(a.name || (await ask('Your name (use the same name in the Chrome extension)', existing.member || os.userInfo().username)) || '')
    .normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!name || name.length > 64) fail('A name of 1-64 characters is required (--name).');

  let backfillDays = a.backfillDays;
  if (backfillDays == null && rl) backfillDays = Number(await ask('Also send history from the last how many days? (0 = start from now)', '30'));
  backfillDays = Number.isFinite(backfillDays) && backfillDays > 0 ? Math.min(Math.round(backfillDays), 365) : 0;
  if (rl) rl.close();

  if (a.verify) {
    process.stdout.write('Checking the server... ');
    try {
      const res = await fetch(joinUrl(server, '/api/ping'), { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10_000) });
      if (res.status === 401) fail('The server rejected the token. Check TEAM_TOKEN.');
      if (!res.ok) fail('The server answered HTTP ' + res.status + '.');
      console.log('ok');
    } catch (e) {
      fail('Could not reach ' + server + ' (' + ((e.cause && e.cause.code) || e.message) + '). Use --skip-verify to install anyway.');
    }
  }

  fs.mkdirSync(path.join(dest, 'lib'), { recursive: true });
  for (const f of FILES) fs.copyFileSync(path.join(__dirname, f), path.join(dest, f));
  writeJsonAtomic(path.join(dest, 'config.json'), {
    server, token, member: name, backfillDays, limitSnapshots: a.limits, sendProjectNames: a.projectNames,
  }, 0o600);
  if (backfillDays > 0) {
    try { fs.unlinkSync(path.join(dest, 'state.json')); } catch { /* fresh install */ }
  }

  const settingsPath = path.join(claudeDir(), 'settings.json');
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    const text = fs.readFileSync(settingsPath, 'utf8');
    try { settings = text.trim() ? JSON.parse(text) : {}; } catch (e) {
      fail('Could not read ' + settingsPath + ' (' + e.message + '). Fix the JSON or add the hooks by hand (see README).');
    }
    fs.copyFileSync(settingsPath, settingsPath + '.bak-team-usage');
  }
  const command = nodeCommand() + ' "' + path.join(dest, 'report.js').replace(/\\/g, '/') + '"';
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  for (const ev of HOOK_EVENTS) {
    const groups = removeOurHooks(settings.hooks[ev]);
    groups.push({ hooks: [{ type: 'command', command, timeout: 30 }] });
    settings.hooks[ev] = groups;
  }
  writeJsonAtomic(settingsPath, settings);

  console.log('Installed to   ' + dest);
  console.log('Hooks added to ' + settingsPath + ' (backup: settings.json.bak-team-usage)');
  console.log('\nRunning the first sync' + (backfillDays ? ' (sending ' + backfillDays + ' days of history, this can take a minute)' : '') + '...');
  spawnSync(process.execPath, [path.join(dest, 'report.js'), '--now'], { stdio: 'inherit' });
  console.log('\nDone. Usage is now reported after every Claude Code reply (CLI and VS Code).');
  console.log('Check it any time with: node "' + path.join(dest, 'report.js') + '" --status');
}

main().catch((e) => fail(e.message));
