'use strict';
// Reads Claude Code session transcripts (~/.claude/projects/**/*.jsonl) incrementally.
// Each assistant record carries message.model and message.usage. One API response can
// be written as several lines (one per content block) sharing message.id, so events are
// keyed by message.id and the largest counts win.

const fs = require('node:fs');
const path = require('node:path');

const CHUNK = 4 * 1024 * 1024;
const TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'];

function int(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function projectName(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

// Which app the session ran in, from the record's "entrypoint" (e.g. "claude-vscode", "cli").
function sourceFor(entrypoint) {
  const e = String(entrypoint || '').toLowerCase();
  if (e.includes('vscode')) return 'vscode';
  if (e.includes('jetbrains')) return 'jetbrains';
  return 'claude-code';
}

function extractEvent(rec) {
  if (!rec || rec.type !== 'assistant') return null;
  const msg = rec.message;
  if (!msg || typeof msg !== 'object' || !msg.usage) return null;
  const model = typeof msg.model === 'string' ? msg.model : '';
  if (!model || model.startsWith('<')) return null; // "<synthetic>" = locally generated, no API call
  const u = msg.usage;
  const counts = {
    input_tokens: int(u.input_tokens),
    output_tokens: int(u.output_tokens),
    cache_read_tokens: int(u.cache_read_input_tokens),
    cache_write_tokens: int(u.cache_creation_input_tokens),
  };
  if (!TOKEN_FIELDS.some((k) => counts[k] > 0)) return null;
  const ts = Date.parse(rec.timestamp);
  if (!Number.isFinite(ts)) return null;
  const id = msg.id || rec.requestId || rec.uuid;
  if (!id) return null;
  return {
    event_id: 'cc:' + id,
    ts,
    model,
    ...counts,
    source: sourceFor(rec.entrypoint),
    session_id: rec.sessionId || null,
    project: projectName(rec.cwd),
  };
}

function mergeEvent(map, ev) {
  const prev = map.get(ev.event_id);
  if (!prev) { map.set(ev.event_id, { ...ev }); return; }
  for (const k of TOKEN_FIELDS) if ((ev[k] || 0) > (prev[k] || 0)) prev[k] = ev[k];
  if (ev.ts > prev.ts) prev.ts = ev.ts;
}

function parseText(text, out) {
  for (const line of text.split('\n')) {
    if (!line || line.indexOf('"usage"') < 0 || line.indexOf('"assistant"') < 0) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const ev = extractEvent(rec);
    if (ev) out.push(ev);
  }
}

// Read complete lines between start and end. The returned offset stops after the last
// newline, so a line that is still being written is picked up on the next run.
function readNewLines(file, start, end) {
  const events = [];
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return { events, newOffset: start }; }
  let pos = start;
  let consumed = start;
  let carry = Buffer.alloc(0);
  try {
    while (pos < end) {
      const len = Math.min(CHUNK, end - pos);
      const buf = Buffer.allocUnsafe(len);
      const n = fs.readSync(fd, buf, 0, len, pos);
      if (n <= 0) break;
      pos += n;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      const lastNl = data.lastIndexOf(0x0a);
      if (lastNl < 0) { carry = Buffer.from(data); continue; }
      parseText(data.subarray(0, lastNl).toString('utf8'), events);
      carry = Buffer.from(data.subarray(lastNl + 1));
      consumed = pos - carry.length;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { events, newOffset: consumed };
}

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

// mode.initOnly: remember current file sizes, send nothing (tracking starts now).
// mode.cutoff:   ignore events older than this timestamp (backfill window).
function scanTranscripts(projectsDir, state, mode = {}) {
  state.files = state.files || {};
  const byId = new Map();
  let filesRead = 0;
  let bytesRead = 0;
  if (!fs.existsSync(projectsDir)) return { events: [], filesRead, bytesRead };
  const seen = new Set();
  for (const file of walk(projectsDir)) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    seen.add(file);
    const entry = state.files[file];
    if (mode.initOnly) { state.files[file] = { offset: st.size }; continue; }
    if (!entry && mode.cutoff && st.mtimeMs < mode.cutoff) { state.files[file] = { offset: st.size }; continue; }
    let offset = entry ? entry.offset : 0;
    if (st.size < offset) offset = 0; // file was rewritten
    if (st.size === offset) continue;
    const r = readNewLines(file, offset, st.size);
    filesRead++;
    bytesRead += r.newOffset - offset;
    for (const ev of r.events) if (!mode.cutoff || ev.ts >= mode.cutoff) mergeEvent(byId, ev);
    state.files[file] = { offset: r.newOffset };
  }
  for (const k of Object.keys(state.files)) if (!seen.has(k)) delete state.files[k];
  return { events: [...byId.values()].sort((a, b) => a.ts - b.ts), filesRead, bytesRead };
}

module.exports = { extractEvent, mergeEvent, readNewLines, scanTranscripts, projectName, sourceFor };
