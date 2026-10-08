'use strict';
const { DAY } = require('./limits');

const MAX_EVENTS = 5000;
const MAX_SNAPSHOTS = 200;
const MAX_RAW_BYTES = 64 * 1024;
const EARLIEST = Date.UTC(2023, 0, 1);

function cleanMember(v) {
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  return s && s.length <= 64 ? s : null;
}

function str(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function tokens(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 1e10) : 0;
}

function tsMs(v, now) {
  let t = typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(t)) return null;
  if (t < 1e12) t *= 1000;
  if (t < EARLIEST || t > now + DAY) return null;
  return Math.round(t);
}

function validateIngest(body, now = Date.now()) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: ['body must be a JSON object'] };
  }
  const member = cleanMember(body.member);
  if (!member) errors.push('member is required (1-64 characters)');
  const source = (str(body.source, 32) || '').toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(source)) errors.push('source is required (e.g. claude-code, claude-ai)');
  const rawEvents = body.events == null ? [] : body.events;
  const rawSnaps = body.snapshots == null ? [] : body.snapshots;
  if (!Array.isArray(rawEvents)) errors.push('events must be an array');
  if (!Array.isArray(rawSnaps)) errors.push('snapshots must be an array');
  if (Array.isArray(rawEvents) && rawEvents.length > MAX_EVENTS) errors.push('at most ' + MAX_EVENTS + ' events per request');
  if (Array.isArray(rawSnaps) && rawSnaps.length > MAX_SNAPSHOTS) errors.push('at most ' + MAX_SNAPSHOTS + ' snapshots per request');
  if (errors.length) return { errors };

  let rejected = 0;
  const events = [];
  for (const e of rawEvents) {
    const eventId = e && str(e.event_id, 200);
    const ts = e && tsMs(e.ts, now);
    const model = e && str(e.model, 120);
    if (!eventId || ts == null || !model) { rejected++; continue; }
    // Optional per-event source (e.g. "vscode" vs "claude-code" from the same hook).
    const evSource = (str(e.source, 32) || '').toLowerCase();
    events.push({
      event_id: eventId,
      source: /^[a-z0-9._-]+$/.test(evSource) ? evSource : null,
      ts,
      model,
      input_tokens: tokens(e.input_tokens),
      output_tokens: tokens(e.output_tokens),
      cache_read_tokens: tokens(e.cache_read_tokens),
      cache_write_tokens: tokens(e.cache_write_tokens),
      estimated: e.estimated ? 1 : 0,
      session_id: str(e.session_id, 120),
      project: str(e.project, 120),
    });
  }
  const snapshots = [];
  for (const s of rawSnaps) {
    const id = s && str(s.snapshot_id, 100);
    const ts = s && tsMs(s.ts, now);
    const raw = s && s.raw;
    if (!id || ts == null || !raw || typeof raw !== 'object') { rejected++; continue; }
    if (JSON.stringify(raw).length > MAX_RAW_BYTES) { rejected++; continue; }
    snapshots.push({ snapshot_id: id, ts, raw });
  }
  return {
    errors: [],
    rejected,
    value: { member, source, machine: str(body.machine, 120), events, snapshots },
  };
}

const SETTING_KEYS = ['alertMemberDailyPct', 'alertAccountPct'];

function validateSettings(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { errors: ['body must be a JSON object'] };
  const errors = [];
  const value = {};
  for (const k of SETTING_KEYS) {
    if (body[k] == null || body[k] === '') continue;
    const n = Number(body[k]);
    if (!Number.isFinite(n) || n < 1 || n > 100) { errors.push(k + ' must be a number from 1 to 100'); continue; }
    value[k] = Math.round(n * 10) / 10;
  }
  return { errors, value };
}

module.exports = { validateIngest, cleanMember, validateSettings };
