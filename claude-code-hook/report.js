#!/usr/bin/env node
'use strict';
// Claude Code hook (Stop + SessionEnd). Collects new token usage from the local session
// transcripts, takes a rate-limit snapshot, and sends both to the team server.
//
//   node report.js            hook entry: returns at once, work runs in a detached process
//   node report.js --now      run a sync in the foreground and print what happened
//   node report.js --status   show configuration, queue and recent log lines
//   node report.js --dry-run [--days N]   parse transcripts and print totals, send nothing

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { claudeDir, readJson, writeJsonAtomic, makeLogger, joinUrl } = require('./lib/common');
const { scanTranscripts, mergeEvent } = require('./lib/transcript');
const { fetchLimitSnapshot } = require('./lib/limits');

const HOME = process.env.CTU_HOME || __dirname;
const DAY = 86_400_000;
const BATCH = 1000;
const MAX_PENDING_EVENTS = 50_000;
const MAX_PENDING_SNAPSHOTS = 500;
const SNAPSHOT_MIN_GAP = 45_000;
const LOCK_STALE = 5 * 60_000;
const LOCK_WAIT = 30_000;

const args = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function numArg(name, def) {
  const i = args.indexOf(name);
  const v = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(v) ? v : def;
}

async function acquireLock(file, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return file;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE) { fs.unlinkSync(file); continue; }
      } catch { continue; }
      if (Date.now() >= deadline) return null;
      await sleep(1000);
    }
  }
}

function releaseLock(file) {
  if (file) try { fs.unlinkSync(file); } catch { /* already gone */ }
}

async function send(cfg, events, snapshots, log) {
  let ev = 0;
  let sn = 0;
  const url = joinUrl(cfg.server, '/api/ingest');
  while (ev < events.length || sn < snapshots.length) {
    const chunk = events.slice(ev, ev + BATCH);
    const snaps = snapshots.slice(sn, sn + 200);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
        body: JSON.stringify({ member: cfg.member, source: 'claude-code', machine: os.hostname(), events: chunk, snapshots: snaps }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        log('server rejected the upload: HTTP ' + res.status + ' ' + text.slice(0, 200));
        break;
      }
    } catch (e) {
      log('could not reach ' + cfg.server + ': ' + ((e.cause && e.cause.code) || e.message));
      break;
    }
    ev += chunk.length;
    sn += snaps.length;
  }
  return { events: ev, snapshots: sn };
}

async function runWorker({ verbose }) {
  const log = makeLogger(HOME, verbose);
  const cfg = readJson(path.join(HOME, 'config.json'), null);
  if (!cfg || !cfg.server || !cfg.token || !cfg.member) {
    log('not configured: run install.js first');
    return 1;
  }
  const lock = await acquireLock(path.join(HOME, 'report.lock'), LOCK_WAIT);
  if (!lock) {
    log('another sync is still running; skipped');
    return 0;
  }
  try {
    const statePath = path.join(HOME, 'state.json');
    const pendingPath = path.join(HOME, 'pending.json');
    const state = readJson(statePath, { files: {} });
    const now = Date.now();
    let mode = { cutoff: 0 };
    if (!state.initializedAt) mode = cfg.backfillDays > 0 ? { cutoff: now - cfg.backfillDays * DAY } : { initOnly: true };

    const scan = scanTranscripts(path.join(claudeDir(), 'projects'), state, mode);
    if (!state.initializedAt) {
      state.initializedAt = now;
      log(mode.initOnly ? 'first run: tracking starts now' : 'first run: collected the last ' + cfg.backfillDays + ' day(s) of history');
    }
    const fresh = scan.events.map((e) => (cfg.sendProjectNames === false ? { ...e, project: null } : e));

    let snapshot = null;
    if (cfg.limitSnapshots !== false && (fresh.length > 0 || verbose) && now - (state.lastSnapshotAt || 0) >= SNAPSHOT_MIN_GAP) {
      snapshot = await fetchLimitSnapshot(claudeDir(), log);
      if (snapshot) state.lastSnapshotAt = now;
    }

    // Persist before sending so nothing is lost if the upload fails or the process dies.
    const pending = readJson(pendingPath, { events: [], snapshots: [] });
    const byId = new Map();
    for (const e of [...(pending.events || []), ...fresh]) mergeEvent(byId, e);
    const events = [...byId.values()].sort((a, b) => a.ts - b.ts).slice(-MAX_PENDING_EVENTS);
    const snapshots = [...(pending.snapshots || []), ...(snapshot ? [snapshot] : [])].slice(-MAX_PENDING_SNAPSHOTS);
    writeJsonAtomic(pendingPath, { events, snapshots });
    writeJsonAtomic(statePath, state);

    if (!events.length && !snapshots.length) {
      if (verbose) log('nothing new to send');
      return 0;
    }
    const sent = await send(cfg, events, snapshots, log);
    const rest = { events: events.slice(sent.events), snapshots: snapshots.slice(sent.snapshots) };
    writeJsonAtomic(pendingPath, rest);
    const queued = rest.events.length + rest.snapshots.length;
    log('sent ' + sent.events + ' usage event(s) and ' + sent.snapshots + ' limit snapshot(s)' +
      (queued ? '; ' + queued + ' item(s) queued for the next run' : ''));
    return 0;
  } catch (e) {
    log('error: ' + ((e && e.stack) || e));
    return 1;
  } finally {
    releaseLock(lock);
  }
}

function dryRun(days) {
  const state = { files: {} };
  const t0 = Date.now();
  const scan = scanTranscripts(path.join(claudeDir(), 'projects'), state, { cutoff: Date.now() - days * DAY });
  const byModel = new Map();
  const sessions = new Set();
  const bySource = {};
  for (const e of scan.events) {
    bySource[e.source] = (bySource[e.source] || 0) + 1;
    const m = byModel.get(e.model) || { model: e.model, messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    m.messages++;
    m.input += e.input_tokens;
    m.output += e.output_tokens;
    m.cacheRead += e.cache_read_tokens;
    m.cacheWrite += e.cache_write_tokens;
    byModel.set(e.model, m);
    if (e.session_id) sessions.add(e.session_id);
  }
  console.log('Last ' + days + ' day(s): ' + scan.events.length + ' API responses in ' + sessions.size +
    ' session(s), ' + scan.filesRead + ' file(s), ' + (scan.bytesRead / 1e6).toFixed(1) + ' MB read in ' + (Date.now() - t0) + ' ms');
  console.log('By app: ' + Object.entries(bySource).map(([k, n]) => k + ' ' + n).join(', '));
  console.table([...byModel.values()].sort((a, b) => b.output - a.output));
  return 0;
}

function status() {
  const cfg = readJson(path.join(HOME, 'config.json'), null);
  const state = readJson(path.join(HOME, 'state.json'), null);
  const pending = readJson(path.join(HOME, 'pending.json'), { events: [], snapshots: [] });
  if (!cfg) { console.log('Not configured. Run install.js.'); return 1; }
  console.log('Install folder : ' + HOME);
  console.log('Server         : ' + cfg.server);
  console.log('Member         : ' + cfg.member);
  console.log('Team token     : ' + (cfg.token ? cfg.token.slice(0, 4) + '…' : '(missing)'));
  console.log('Limit snapshots: ' + (cfg.limitSnapshots !== false ? 'on' : 'off'));
  console.log('Project names  : ' + (cfg.sendProjectNames !== false ? 'sent' : 'not sent'));
  console.log('Tracking since : ' + (state && state.initializedAt ? new Date(state.initializedAt).toLocaleString() : 'not started yet'));
  console.log('Files watched  : ' + (state ? Object.keys(state.files || {}).length : 0));
  console.log('Queued         : ' + (pending.events || []).length + ' event(s), ' + (pending.snapshots || []).length + ' snapshot(s)');
  try {
    const lines = fs.readFileSync(path.join(HOME, 'report.log'), 'utf8').trim().split('\n').slice(-10);
    console.log('\nRecent log:\n' + lines.join('\n'));
  } catch { /* no log yet */ }
  return 0;
}

function hookEntry() {
  try {
    const child = spawn(process.execPath, [__filename, '--worker'], {
      detached: true, stdio: 'ignore', windowsHide: true, cwd: HOME, env: process.env,
    });
    child.unref();
  } catch { /* never block Claude Code */ }
  process.stdin.on('error', () => {});
  process.stdin.on('data', () => {});
  process.stdin.on('end', () => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

async function main() {
  if (args.includes('--worker')) return runWorker({ verbose: false });
  if (args.includes('--now')) return runWorker({ verbose: true });
  if (args.includes('--dry-run')) return dryRun(numArg('--days', 1));
  if (args.includes('--status')) return status();
  hookEntry();
  return null;
}

main().then((code) => { if (code != null) process.exitCode = code; }, (e) => { console.error(e); process.exitCode = 1; });
