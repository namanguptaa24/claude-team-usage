'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { canonicalModel, estimateCost, modelFamily } = require('./pricing');
const { HOUR, DAY, normalizeUsage, windowMeta, attribute, weeklyBreakdown } = require('./limits');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  member TEXT NOT NULL,
  source TEXT NOT NULL,
  machine TEXT,
  model TEXT NOT NULL,
  family TEXT NOT NULL,
  ts INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  estimated INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  project TEXT,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_member_ts ON events(member, ts);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  window_key TEXT NOT NULL,
  ts INTEGER NOT NULL,
  member TEXT NOT NULL,
  source TEXT NOT NULL,
  pct REAL NOT NULL,
  resets_at INTEGER,
  UNIQUE (snapshot_id, window_key)
);
CREATE INDEX IF NOT EXISTS snapshots_key_ts ON snapshots(window_key, ts);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- A renamed or merged member keeps the old name here, so trackers that still
-- send the old name land on the new one.
CREATE TABLE IF NOT EXISTS member_aliases (
  alias TEXT PRIMARY KEY,
  member TEXT NOT NULL
);
`;

const SESSION_KEYS = ['five_hour', 'seven_day'];
// Trend chart bars. Short custom ranges (say 10 minutes) use minute bars.
const BUCKET_MS = { minute: 60_000, '5min': 5 * 60_000, hour: HOUR, day: DAY };
const DEFAULT_SETTINGS = {
  // A member who used this many points of the weekly limit in the last 24 hours gets an alert.
  // At 15 a day, one person alone would use up the whole team's week in under 7 days.
  alertMemberDailyPct: 15,
  // Any account limit window at or above this percentage gets an alert.
  alertAccountPct: 80,
};
const SOURCE_LABEL = { vscode: 'VS Code', 'claude-code': 'Claude Code CLI', jetbrains: 'JetBrains', 'claude-ai': 'claude.ai' };
// Names are stored lower case; the dashboard capitalises them, and so does the download.
const displayName = (name) => name.replace(/(^|[\s._-])(\p{L})/gu,(m, sep, c) => sep + c.toUpperCase());

function round(v, digits = 2) {
  const f = 10 ** digits;
  return Math.round((Number(v) || 0) * f) / f;
}

function openStore(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // 1.0.0 stored object-shaped limit scopes under this broken key.
  db.exec("DELETE FROM snapshots WHERE window_key LIKE '%object_object%'");

  // Re-sends are idempotent: the same event_id keeps the largest counts seen.
  const upsertEvent = db.prepare(`
    INSERT INTO events (event_id, member, source, machine, model, family, ts,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
      estimated, session_id, project, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET
      input_tokens = max(events.input_tokens, excluded.input_tokens),
      output_tokens = max(events.output_tokens, excluded.output_tokens),
      cache_read_tokens = max(events.cache_read_tokens, excluded.cache_read_tokens),
      cache_write_tokens = max(events.cache_write_tokens, excluded.cache_write_tokens),
      cost_usd = max(events.cost_usd, excluded.cost_usd)`);
  const insertSnapshot = db.prepare(`
    INSERT OR IGNORE INTO snapshots (snapshot_id, window_key, ts, member, source, pct, resets_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const setMeta = db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const getMeta = db.prepare('SELECT value FROM meta WHERE key = ?');
  const readMeta = (key) => {
    const row = getMeta.get(key);
    try { return row ? JSON.parse(row.value) : null; } catch { return null; }
  };
  const getAlias = db.prepare('SELECT member FROM member_aliases WHERE alias = ?');
  const resolveMember = (name) => { const row = getAlias.get(name); return row ? row.member : name; };

  function inTransaction(fn) {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function ingest({ member: sentAs, source, machine, events, snapshots }, now = Date.now()) {
    const member = resolveMember(sentAs);
    let windows = 0;
    db.exec('BEGIN');
    try {
      for (const e of events) {
        const model = canonicalModel(e.model);
        upsertEvent.run(
          e.event_id, member, e.source || source, machine ?? null, model, modelFamily(model), e.ts,
          e.input_tokens || 0, e.output_tokens || 0, e.cache_read_tokens || 0, e.cache_write_tokens || 0,
          estimateCost(e, model), e.estimated ? 1 : 0, e.session_id ?? null, e.project ?? null, now);
      }
      for (const s of snapshots) {
        for (const w of normalizeUsage(s.raw)) {
          insertSnapshot.run(s.snapshot_id, w.key, s.ts, member, source, w.pct, w.resetsAt ?? null);
          windows++;
        }
        setMeta.run('last_raw_usage:' + source, JSON.stringify({ ts: s.ts, member, raw: s.raw }));
        const breakdown = weeklyBreakdown(s.raw);
        const known = breakdown && readMeta('seven_day_breakdown');
        if (breakdown && (!known || known.ts <= s.ts)) {
          setMeta.run('seven_day_breakdown', JSON.stringify({ ts: s.ts, ...breakdown }));
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { events: events.length, snapshots: snapshots.length, windows };
  }

  function currentLimits(now) {
    const rows = db.prepare(`
      SELECT s.window_key AS key, s.ts, s.pct, s.resets_at AS resetsAt, s.member, s.source
      FROM snapshots s
      JOIN (SELECT window_key, MAX(ts) AS mts FROM snapshots GROUP BY window_key) m
        ON m.window_key = s.window_key AND m.mts = s.ts
      WHERE s.ts >= ?`).all(now - 14 * DAY);
    const seen = new Map();
    for (const r of rows) if (!seen.has(r.key)) seen.set(r.key, r);
    const order = (k) => (k === 'five_hour' ? 0 : k === 'seven_day' ? 1 : 2);
    return [...seen.values()]
      .sort((a, b) => order(a.key) - order(b.key) || a.key.localeCompare(b.key))
      .map((r) => {
        const meta = windowMeta(r.key);
        const active = r.resetsAt != null ? r.resetsAt > now : r.pct > 0;
        let contributions = null;
        if (active && meta.scope != null) {
          const windowStart = (r.resetsAt != null ? r.resetsAt : now) - meta.lengthMs;
          const a = attribute(db, {
            windowKey: r.key, scope: meta.scope, lengthMs: meta.lengthMs, from: windowStart, to: now, windowResetsAt: r.resetsAt,
          });
          contributions = {
            members: Object.entries(a.byMember)
              .map(([member, pp]) => ({ member, pp: round(pp) }))
              .sort((x, y) => y.pp - x.pp),
            untracked: round(a.untracked),
            beforeTracking: round(a.beforeTracking),
          };
        }
        let breakdown = null;
        if (r.key === 'seven_day' && active) {
          const b = readMeta('seven_day_breakdown');
          if (b && b.ts >= now - 7 * DAY) breakdown = { rows: b.rows, asOf: b.asOf || b.ts };
        }
        return {
          key: r.key,
          label: meta.label,
          scope: meta.scope,
          pct: active ? round(r.pct) : 0,
          resetsAt: r.resetsAt,
          active,
          observedAt: r.ts,
          observedBy: r.member,
          contributions,
          breakdown,
        };
      });
  }

  function stats({ from, to, tzOffsetMin = 0, source = '', member = '', bucket = 'day', now = Date.now() }) {
    const cond = ['ts >= ?', 'ts < ?'];
    const args = [from, to];
    if (source) { cond.push('source = ?'); args.push(source); }
    if (member) { cond.push('member = ?'); args.push(member); }
    const where = cond.join(' AND ');

    const byMemberModel = db.prepare(`
      SELECT member, source, model, family, COUNT(*) AS messages,
        SUM(input_tokens) AS input, SUM(output_tokens) AS output,
        SUM(cache_read_tokens) AS cacheRead, SUM(cache_write_tokens) AS cacheWrite,
        SUM(cost_usd) AS cost, SUM(estimated) AS estimated, MAX(ts) AS lastTs
      FROM events WHERE ${where}
      GROUP BY member, source, model ORDER BY cost DESC`).all(...args);

    if (!BUCKET_MS[bucket]) bucket = 'day';
    const bucketMs = BUCKET_MS[bucket];
    const tzMs = Math.round(Number(tzOffsetMin) || 0) * 60_000;
    const series = db.prepare(`
      SELECT CAST((ts + ?) / ? AS INTEGER) AS b, member, family,
        SUM(cost_usd) AS cost, COUNT(*) AS messages,
        SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens
      FROM events WHERE ${where}
      GROUP BY b, member, family ORDER BY b`).all(tzMs, bucketMs, ...args)
      .map((r) => ({ t: r.b * bucketMs - tzMs, member: r.member, family: r.family, cost: r.cost, messages: r.messages, tokens: r.tokens }));

    const members = new Map();
    const blank = (name) => ({
      member: name, cost: 0, messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      tokens: 0, estimatedMessages: 0, byFamily: {}, byModel: {}, sources: [], lastTs: null,
      limit: { five_hour: 0, seven_day: 0 },
    });
    for (const r of byMemberModel) {
      const m = members.get(r.member) || blank(r.member);
      m.cost += r.cost; m.messages += r.messages;
      m.input += r.input; m.output += r.output; m.cacheRead += r.cacheRead; m.cacheWrite += r.cacheWrite;
      m.tokens += r.input + r.output + r.cacheRead + r.cacheWrite;
      m.estimatedMessages += r.estimated;
      m.byFamily[r.family] = (m.byFamily[r.family] || 0) + r.cost;
      m.byModel[r.model] = (m.byModel[r.model] || 0) + r.cost;
      if (!m.sources.includes(r.source)) m.sources.push(r.source);
      m.lastTs = Math.max(m.lastTs || 0, r.lastTs);
      members.set(r.member, m);
    }

    // Limit attribution always looks at everyone, because the limit is shared.
    const untracked = {};
    const beforeTracking = {};
    for (const key of SESSION_KEYS) {
      const meta = windowMeta(key);
      const a = attribute(db, { windowKey: key, scope: 'all', lengthMs: meta.lengthMs, from, to });
      untracked[key] = round(a.untracked);
      beforeTracking[key] = round(a.beforeTracking);
      for (const [name, pp] of Object.entries(a.byMember)) {
        if (member && name !== member) continue;
        const m = members.get(name) || blank(name);
        m.limit[key] = round(pp);
        members.set(name, m);
      }
    }

    const list = [...members.values()].map((m) => {
      const top = Object.entries(m.byModel).sort((a, b) => b[1] - a[1])[0];
      return { ...m, cost: round(m.cost, 4), topModel: top ? top[0] : null };
    }).sort((a, b) => b.limit.seven_day - a.limit.seven_day || b.cost - a.cost);

    const allMembers = db.prepare(
      'SELECT member FROM events UNION SELECT member FROM snapshots ORDER BY member').all().map((r) => r.member);

    return {
      range: { from, to, bucket, bucketMs, tzOffsetMin: tzMs / 60_000 },
      generatedAt: now,
      members: list,
      untracked,
      beforeTracking,
      byMemberModel,
      series,
      limits: currentLimits(now),
      allMembers,
    };
  }

  // Compact view for the browser extension popup: one member's usage today and over
  // the last 7 days, by source and model, plus the account limits and (optionally) the team.
  function summary({ member: askedFor, tzOffsetMin = 0, includeTeam = false, now = Date.now() }) {
    const member = resolveMember(askedFor);
    const tzMs = Math.round(Number(tzOffsetMin) || 0) * 60_000;
    const dayStart = Math.floor((now + tzMs) / DAY) * DAY - tzMs;
    const weekFrom = now - 7 * DAY;
    const q = db.prepare(`
      SELECT source, model, family, COUNT(*) AS messages,
        SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens,
        SUM(cost_usd) AS cost, SUM(estimated) AS estimated
      FROM events WHERE member = ? AND ts >= ? AND ts <= ?
      GROUP BY source, model ORDER BY cost DESC`);
    const shape = (rows) => ({
      messages: rows.reduce((a, r) => a + r.messages, 0),
      cost: round(rows.reduce((a, r) => a + r.cost, 0), 4),
      rows: rows.map((r) => ({ ...r, cost: round(r.cost, 4) })),
    });
    let team = null;
    if (includeTeam) {
      team = stats({ from: weekFrom, to: now + 1, now }).members.slice(0, 10)
        .map((m) => ({ member: m.member, cost: m.cost, messages: m.messages, limit: m.limit, topModel: m.topModel }));
    }
    return {
      member,
      generatedAt: now,
      today: shape(q.all(member, dayStart, now)),
      week: shape(q.all(member, weekFrom, now)),
      limits: currentLimits(now),
      team,
    };
  }

  // ---------- admin ----------

  function getSettings() {
    return { ...DEFAULT_SETTINGS, ...(readMeta('settings') || {}) };
  }

  function setSettings(patch) {
    const next = getSettings();
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (patch[k] != null) next[k] = patch[k];
    setMeta.run('settings', JSON.stringify(next));
    return next;
  }

  // Things the manager should look at now: a limit window running high, or one person
  // (or untracked usage) taking a big share of the weekly limit in the last 24 hours.
  function alerts({ now = Date.now(), limits = currentLimits(now) } = {}) {
    const s = getSettings();
    const out = [];
    for (const l of limits) {
      if (!l.active || l.pct < s.alertAccountPct) continue;
      out.push({ kind: 'limit', level: l.pct >= 95 ? 'crit' : 'warn', key: l.key, label: l.label, pct: l.pct, resetsAt: l.resetsAt });
    }
    const meta = windowMeta('seven_day');
    const a = attribute(db, { windowKey: 'seven_day', scope: 'all', lengthMs: meta.lengthMs, from: now - DAY, to: now });
    const level = (pp) => (pp >= 2 * s.alertMemberDailyPct ? 'crit' : 'warn');
    for (const [member, pp] of Object.entries(a.byMember).sort((x, y) => y[1] - x[1])) {
      if (pp >= s.alertMemberDailyPct) out.push({ kind: 'member', level: level(pp), member, pp: round(pp) });
    }
    if (a.untracked >= s.alertMemberDailyPct) out.push({ kind: 'untracked', level: level(a.untracked), pp: round(a.untracked) });
    return out;
  }

  function listMembers() {
    const rows = db.prepare(`
      SELECT member, COUNT(*) AS messages, SUM(cost_usd) AS cost, MIN(ts) AS firstTs, MAX(ts) AS lastTs,
        group_concat(DISTINCT source) AS sources
      FROM events GROUP BY member`).all();
    const readingsOnly = db.prepare(`
      SELECT member, MIN(ts) AS firstTs, MAX(ts) AS lastTs, group_concat(DISTINCT source) AS sources
      FROM snapshots WHERE member NOT IN (SELECT DISTINCT member FROM events) GROUP BY member`).all();
    const aliases = db.prepare('SELECT alias, member FROM member_aliases ORDER BY alias').all();
    return [...rows, ...readingsOnly.map((r) => ({ ...r, messages: 0, cost: 0 }))]
      .map((r) => ({
        member: r.member,
        messages: r.messages,
        cost: round(r.cost, 4),
        firstTs: r.firstTs,
        lastTs: r.lastTs,
        sources: String(r.sources || '').split(',').filter(Boolean),
        aliases: aliases.filter((x) => x.member === r.member).map((x) => x.alias),
      }))
      .sort((a, b) => a.member.localeCompare(b.member));
  }

  const hasMember = db.prepare(
    'SELECT 1 FROM events WHERE member = ? UNION ALL SELECT 1 FROM snapshots WHERE member = ? LIMIT 1');

  // Renaming onto an existing name merges the two. The old name becomes an alias, so a
  // teammate's hook or extension that still sends it keeps working.
  // Returns null when there is no member with the old name.
  function renameMember(from, to) {
    if (from === to) return { member: to, merged: false, events: 0, snapshots: 0 };
    return inTransaction(() => {
      const merged = !!hasMember.get(to, to);
      const events = Number(db.prepare('UPDATE events SET member = ? WHERE member = ?').run(to, from).changes);
      const snapshots = Number(db.prepare('UPDATE snapshots SET member = ? WHERE member = ?').run(to, from).changes);
      if (!events && !snapshots) return null;
      db.prepare('UPDATE member_aliases SET member = ? WHERE member = ?').run(to, from);
      db.prepare('DELETE FROM member_aliases WHERE alias = ?').run(to);
      db.prepare('INSERT INTO member_aliases (alias, member) VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET member = excluded.member')
        .run(from, to);
      return { member: to, merged, events, snapshots };
    });
  }

  // Deletes everything this member sent, their limit readings included, and their aliases.
  // Returns null when there is no such member.
  function deleteMember(member) {
    return inTransaction(() => {
      const events = Number(db.prepare('DELETE FROM events WHERE member = ?').run(member).changes);
      const snapshots = Number(db.prepare('DELETE FROM snapshots WHERE member = ?').run(member).changes);
      if (!events && !snapshots) return null;
      db.prepare('DELETE FROM member_aliases WHERE member = ?').run(member);
      return { member, events, snapshots };
    });
  }

  // Rows for the spreadsheet download, one per local day.
  //   detail:  day x member x source x model, with tokens and cost
  //   members: day x member, with the share of the shared limit, messages, tokens and cost
  function exportRows({ view = 'detail', from, to, tzOffsetMin = 0, source = '', member = '' }) {
    const tzMs = Math.round(Number(tzOffsetMin) || 0) * 60_000;
    const dayOf = (ts) => Math.floor((ts + tzMs) / DAY);
    const dateOf = (b) => new Date(b * DAY).toISOString().slice(0, 10);
    const cond = ['ts >= ?', 'ts < ?'];
    const args = [from, to];
    if (source) { cond.push('source = ?'); args.push(source); }
    if (member) { cond.push('member = ?'); args.push(member); }
    const where = cond.join(' AND ');

    if (view === 'detail') {
      const rows = db.prepare(`
        SELECT CAST((ts + ?) / ? AS INTEGER) AS b, member, source, model, family, COUNT(*) AS messages,
          SUM(input_tokens) AS input, SUM(output_tokens) AS output,
          SUM(cache_read_tokens) AS cacheRead, SUM(cache_write_tokens) AS cacheWrite,
          SUM(cost_usd) AS cost, SUM(estimated) AS estimated
        FROM events WHERE ${where}
        GROUP BY b, member, source, model ORDER BY b, member, source, model`).all(tzMs, DAY, ...args);
      return {
        header: ['Date', 'Member', 'App', 'Model', 'Model family', 'Messages', 'Input tokens', 'Output tokens',
          'Cache read tokens', 'Cache write tokens', 'API-equivalent cost (USD)', 'Token counts'],
        rows: rows.map((r) => [
          dateOf(r.b), displayName(r.member), SOURCE_LABEL[r.source] || r.source, r.model, r.family, r.messages,
          r.input, r.output, r.cacheRead, r.cacheWrite, round(r.cost, 4), r.estimated > 0 ? 'estimated' : 'exact',
        ]),
      };
    }

    const UNTRACKED = 'Untracked';
    const BEFORE = 'Before tracking';
    const days = new Map();
    const cellFor = (b, name) => {
      if (!days.has(b)) days.set(b, new Map());
      const d = days.get(b);
      if (!d.has(name)) d.set(name, { seven_day: 0, five_hour: 0, messages: 0, tokens: 0, cost: 0 });
      return d.get(name);
    };
    const usage = db.prepare(`
      SELECT CAST((ts + ?) / ? AS INTEGER) AS b, member, COUNT(*) AS messages,
        SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens, SUM(cost_usd) AS cost
      FROM events WHERE ${where} GROUP BY b, member`).all(tzMs, DAY, ...args);
    for (const r of usage) Object.assign(cellFor(r.b, r.member), { messages: r.messages, tokens: r.tokens, cost: r.cost });
    // The limit is shared, so its split always looks at everyone, as on the dashboard.
    for (const key of SESSION_KEYS) {
      attribute(db, {
        windowKey: key, scope: 'all', lengthMs: windowMeta(key).lengthMs, from, to: to - 1,
        onRise: ({ ts, byMember, untracked, beforeTracking }) => {
          const b = dayOf(ts);
          for (const [name, pp] of Object.entries(byMember)) if (!member || name === member) cellFor(b, name)[key] += pp;
          if (!member && untracked) cellFor(b, UNTRACKED)[key] += untracked;
          if (!member && beforeTracking) cellFor(b, BEFORE)[key] += beforeTracking;
        },
      });
    }
    const rank = (name) => (name === UNTRACKED ? 1 : name === BEFORE ? 2 : 0);
    const rows = [];
    for (const b of [...days.keys()].sort((x, y) => x - y)) {
      const names = [...days.get(b).keys()].sort((x, y) => rank(x) - rank(y) || x.localeCompare(y));
      for (const name of names) {
        const c = days.get(b).get(name);
        const tracked = !rank(name);
        rows.push([dateOf(b), tracked ? displayName(name) : name, round(c.seven_day), round(c.five_hour),
          tracked ? c.messages : null, tracked ? c.tokens : null, tracked ? round(c.cost, 4) : null]);
      }
    }
    return {
      header: ['Date', 'Member', 'Weekly limit used (%)', '5-hour limit used (%)', 'Messages', 'Tokens', 'API-equivalent cost (USD)'],
      rows,
    };
  }

  return {
    db, ingest, stats, summary, close: () => db.close(),
    resolveMember, getSettings, setSettings, alerts, listMembers, renameMember, deleteMember, exportRows,
  };
}

module.exports = { openStore };
