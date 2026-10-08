'use strict';
// Service worker: queues usage events and limit snapshots from claude.ai tabs and
// uploads them to the team server. The queue survives restarts and offline periods.

importScripts('config.js');

const MAX_QUEUE = 3000;
const BATCH = 500;

let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function setStatus(patch) {
  const { status = {} } = await chrome.storage.local.get('status');
  await chrome.storage.local.set({ status: { ...status, ...patch } });
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

function localDay(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function toEvent(p) {
  if (!p || !p.event_id || !p.model) return null;
  return {
    event_id: String(p.event_id).slice(0, 200),
    ts: Number(p.ts) || Date.now(),
    model: String(p.model).slice(0, 120),
    // claude.ai does not expose token counts; estimate ~4 characters per token.
    input_tokens: Math.ceil((Number(p.prompt_chars) || 0) / 4),
    output_tokens: Math.ceil((Number(p.output_chars) || 0) / 4),
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    estimated: true,
    session_id: p.conversation_id || null,
  };
}

function enqueue(items) {
  return serial(async () => {
    const { queue = [] } = await chrome.storage.local.get('queue');
    queue.push(...items);
    await chrome.storage.local.set({ queue: queue.length > MAX_QUEUE ? queue.slice(-MAX_QUEUE) : queue });
  });
}

function bumpToday(model) {
  return serial(async () => {
    const today = localDay(Date.now());
    let { todayStats } = await chrome.storage.local.get('todayStats');
    if (!todayStats || todayStats.day !== today) todayStats = { day: today, byModel: {} };
    todayStats.byModel[model] = (todayStats.byModel[model] || 0) + 1;
    await chrome.storage.local.set({ todayStats });
  });
}

function flush() {
  return serial(async () => {
    for (let round = 0; round < 10; round++) {
      const { queue = [] } = await chrome.storage.local.get('queue');
      if (!queue.length) {
        await setStatus({ queued: 0 });
        setBadge('');
        return;
      }
      const cfg = await loadConfig();
      if (!cfg.serverUrl || !cfg.teamToken || !cfg.member) {
        await setStatus({
          queued: queue.length,
          error: cfg.locked.member && !cfg.member
            ? 'Your company set the name to come from your work email, but this Chrome profile is not signed in. Sign in to Chrome with your work account.'
            : 'Open Settings and fill in the server address, team token and your name.',
        });
        setBadge('!', '#d03b3b');
        return;
      }
      const batch = queue.slice(0, BATCH);
      const body = {
        member: cfg.member,
        source: 'claude-ai',
        machine: 'chrome',
        events: batch.filter((i) => i.kind === 'event').map((i) => i.data),
        snapshots: batch.filter((i) => i.kind === 'snapshot').map((i) => i.data),
      };
      try {
        const res = await fetch(cfg.serverUrl + '/api/ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.teamToken },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(res.status === 401 ? 'the server rejected the team token' : 'server returned HTTP ' + res.status);
      } catch (e) {
        await setStatus({ queued: queue.length, error: 'Sync failed: ' + e.message, lastErrorAt: Date.now() });
        setBadge('!', '#b77700');
        return;
      }
      const { queue: current = [] } = await chrome.storage.local.get('queue');
      const rest = current.slice(batch.length);
      await chrome.storage.local.set({ queue: rest });
      await setStatus({ queued: rest.length, error: null, lastSyncAt: Date.now() });
      setBadge('');
    }
  });
}

async function handle(msg) {
  const p = msg.payload || {};
  if (msg.type === 'message') {
    const ev = toEvent(p);
    if (!ev) return;
    await enqueue([{ kind: 'event', data: ev }]);
    await bumpToday(ev.model);
  } else if (msg.type === 'snapshot') {
    if (!p.raw || typeof p.raw !== 'object') return;
    const ts = Number(p.ts) || Date.now();
    await enqueue([{ kind: 'snapshot', data: { snapshot_id: String(p.snapshot_id || crypto.randomUUID()), ts, raw: p.raw } }]);
    await chrome.storage.local.set({ lastSnapshot: { ts, raw: p.raw } });
  } else {
    return;
  }
  await flush();
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.kind !== 'ctu') return;
  if (!sender.url || !/^https:\/\/claude\.ai\//.test(sender.url)) return;
  handle(msg).catch(() => {});
});

function ensureAlarm() {
  chrome.alarms.create('flush', { periodInMinutes: 5 });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  ensureAlarm();
  if (details.reason !== 'install') return;
  // A company install with every setting in the policy needs no setup page.
  const cfg = await loadConfig();
  if (!(cfg.serverUrl && cfg.teamToken && cfg.member)) chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'flush') flush(); });
chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'sync' || area === 'managed') flush(); });
