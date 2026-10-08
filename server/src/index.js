'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const util = require('node:util');
const { openStore } = require('./db');
const { validateIngest, cleanMember, validateSettings } = require('./validate');
const { DAY } = require('./limits');
const { toCsv } = require('./csv');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 5 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
  "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
].join('; ');
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Max-Age': '600',
};

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function bearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return m ? m[1].trim() : '';
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(httpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(httpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Range and filters shared by the dashboard stats and the spreadsheet download.
function readFilters(q, now) {
  const to = Number(q.get('to')) || now;
  let from = Number(q.get('from')) || to - 7 * DAY;
  if (to - from > 400 * DAY) from = to - 400 * DAY;
  if (from >= to) throw httpError(400, 'from must be before to');
  return {
    from,
    to,
    source: (q.get('source') || '').toLowerCase().slice(0, 32),
    member: q.get('member') ? cleanMember(q.get('member')) || '' : '',
    tzOffsetMin: Math.max(-840, Math.min(840, Number(q.get('tz')) || 0)),
  };
}

function localDate(ms, tzOffsetMin) {
  return new Date(ms + tzOffsetMin * 60_000).toISOString().slice(0, 10);
}

function createApp({ store, teamToken, dashboardToken, log = console }) {
  const dashToken = dashboardToken || teamToken;
  // Renaming, deleting and alert settings need a dashboard token of their own, so that
  // the team token every teammate has can never change or delete data.
  const adminOn = dashToken !== teamToken;

  function send(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS });
    res.end(JSON.stringify(obj));
  }

  function isTeam(req) { const t = bearer(req); return !!t && safeEqual(t, teamToken); }
  function isDashboard(req) { const t = bearer(req); return !!t && safeEqual(t, dashToken); }

  function requireAdmin(req) {
    if (!isDashboard(req)) throw httpError(401, 'Invalid or missing dashboard token');
    if (!adminOn) throw httpError(403, 'Admin tools need a separate DASHBOARD_TOKEN in server/.env');
  }

  function memberArg(v, label) {
    const m = cleanMember(v);
    if (!m) throw httpError(400, label + ' must be a name of 1-64 characters');
    return m;
  }

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !MIME[path.extname(file)]) return false;
    let data;
    try { data = fs.readFileSync(file); } catch { return false; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)],
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
    return true;
  }

  return async function handler(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, { error: 'Bad URL' }); }
    const p = url.pathname;
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        return res.end();
      }
      if (p === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true });

      if (p === '/api/ping' && req.method === 'GET') {
        if (!isTeam(req) && !isDashboard(req)) return send(res, 401, { error: 'Invalid or missing token' });
        const dash = isDashboard(req);
        return send(res, 200, { ok: true, role: dash ? 'dashboard' : 'team', admin: dash && adminOn });
      }

      if (p === '/api/ingest' && req.method === 'POST') {
        if (!isTeam(req)) return send(res, 401, { error: 'Invalid or missing team token' });
        const body = await readJson(req);
        const v = validateIngest(body);
        if (v.errors.length) return send(res, 400, { error: v.errors.join('; ') });
        const result = store.ingest(v.value);
        return send(res, 200, { ok: true, ...result, rejected: v.rejected });
      }

      if (p === '/api/stats' && req.method === 'GET') {
        if (!isDashboard(req)) return send(res, 401, { error: 'Invalid or missing dashboard token' });
        const now = Date.now();
        const f = readFilters(url.searchParams, now);
        const st = store.stats({ ...f, bucket: url.searchParams.get('bucket') || 'day', now });
        return send(res, 200, {
          ...st,
          alerts: store.alerts({ now, limits: st.limits }),
          settings: store.getSettings(),
          viewer: { admin: adminOn },
        });
      }

      if (p === '/api/export.csv' && req.method === 'GET') {
        if (!isDashboard(req)) return send(res, 401, { error: 'Invalid or missing dashboard token' });
        const f = readFilters(url.searchParams, Date.now());
        const view = url.searchParams.get('view') === 'members' ? 'members' : 'detail';
        const { header, rows } = store.exportRows({ ...f, view });
        const name = 'claude-usage-' + (view === 'members' ? 'by-member' : 'by-model') + '-' +
          localDate(f.from, f.tzOffsetMin) + '-to-' + localDate(f.to - 1, f.tzOffsetMin) + '.csv';
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="' + name + '"',
          'Cache-Control': 'no-store',
          ...CORS,
          'Access-Control-Expose-Headers': 'Content-Disposition',
        });
        return res.end(toCsv(header, rows));
      }

      if (p === '/api/admin/members' && req.method === 'GET') {
        requireAdmin(req);
        return send(res, 200, { members: store.listMembers() });
      }

      if (p === '/api/admin/members/rename' && req.method === 'POST') {
        requireAdmin(req);
        const body = (await readJson(req)) || {};
        const from = memberArg(body.from, 'from');
        const to = memberArg(body.to, 'to');
        const result = store.renameMember(from, to);
        if (!result) return send(res, 404, { error: 'No member called ' + from });
        return send(res, 200, { ok: true, ...result });
      }

      if (p === '/api/admin/members/delete' && req.method === 'POST') {
        requireAdmin(req);
        const body = (await readJson(req)) || {};
        const result = store.deleteMember(memberArg(body.member, 'member'));
        if (!result) return send(res, 404, { error: 'No member called ' + cleanMember(body.member) });
        return send(res, 200, { ok: true, ...result });
      }

      if (p === '/api/admin/settings' && req.method === 'POST') {
        requireAdmin(req);
        const v = validateSettings(await readJson(req));
        if (v.errors.length) return send(res, 400, { error: v.errors.join('; ') });
        return send(res, 200, { ok: true, settings: store.setSettings(v.value) });
      }

      if (p === '/api/summary' && req.method === 'GET') {
        // Team token: your own numbers. The team list is included for the dashboard token,
        // or for everyone when no separate DASHBOARD_TOKEN is set.
        const dash = isDashboard(req);
        if (!dash && !isTeam(req)) return send(res, 401, { error: 'Invalid or missing token' });
        const member = cleanMember(url.searchParams.get('member') || '');
        if (!member) return send(res, 400, { error: 'member is required' });
        const tz = Math.max(-840, Math.min(840, Number(url.searchParams.get('tz')) || 0));
        return send(res, 200, store.summary({ member, tzOffsetMin: tz, includeTeam: dash || dashToken === teamToken }));
      }

      if (p.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
      if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, p)) return undefined;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) log.error('[error]', req.method, p, err);
      if (!res.headersSent) return send(res, status, { error: status >= 500 ? 'Internal error' : err.message });
      return res.end();
    }
  };
}

// Reads a .env file written by any editor or shell. Windows PowerShell 5.1 writes UTF-16
// for ">" redirection and UTF-8 with a BOM for -Encoding utf8; process.loadEnvFile reads
// neither. Variables already set in the environment win. Returns false when there is no file.
function loadEnvFile(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return false; }
  let text;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.subarray(2).toString('utf16le');
  else if (buf[0] === 0xfe && buf[1] === 0xff) text = Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  else text = buf.toString('utf8').replace(/^﻿/, '');
  for (const [k, v] of Object.entries(util.parseEnv(text))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return true;
}

function main() {
  const envFile = process.env.ENV_FILE || path.join(__dirname, '..', '.env');
  const hadEnvFile = loadEnvFile(envFile);
  let teamToken = process.env.TEAM_TOKEN || '';
  let dashboardToken = process.env.DASHBOARD_TOKEN || '';
  let firstRun = false;
  if (!teamToken && !hadEnvFile) {
    // First run: create both tokens so setup is a single command.
    firstRun = true;
    teamToken = crypto.randomBytes(24).toString('base64url');
    dashboardToken = dashboardToken || crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(envFile, 'TEAM_TOKEN=' + teamToken + '\nDASHBOARD_TOKEN=' + dashboardToken + '\n', { mode: 0o600 });
    console.log('First run: created ' + path.resolve(envFile) + ' with two new tokens.\n');
    console.log('  TEAM TOKEN:       ' + teamToken);
    console.log('    Give this to every teammate. The Claude Code installer and the Chrome extension ask for it.\n');
    console.log('  DASHBOARD TOKEN:  ' + dashboardToken);
    console.log('    For the manager only. It opens the dashboard and the admin tools.\n');
  }
  if (teamToken.length < 12) {
    console.error('TEAM_TOKEN must be set (12+ characters) in ' + path.resolve(envFile) + ' or the environment.');
    console.error('Delete that file and start again to have a token created for you.');
    process.exit(1);
  }
  if (dashboardToken && dashboardToken.length < 12) {
    console.error('DASHBOARD_TOKEN must be 12+ characters, or left out, in ' + path.resolve(envFile) + '.');
    process.exit(1);
  }
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '0.0.0.0';
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'usage.db');
  const store = openStore(dbPath);
  const server = http.createServer(createApp({ store, teamToken, dashboardToken }));
  server.listen(port, host, () => {
    const actualPort = server.address().port;
    const local = 'http://' + (host === '0.0.0.0' ? 'localhost' : host) + ':' + actualPort;
    console.log('Claude team usage server listening on ' + local);
    console.log('Database: ' + path.resolve(dbPath));
    if (firstRun) console.log('Manager dashboard: ' + local + '/#token=' + dashboardToken);
    if (!dashboardToken || dashboardToken === teamToken) {
      console.log('\nNote: there is no separate DASHBOARD_TOKEN, so the team token opens the dashboard and');
      console.log('the admin tools are off. Add a DASHBOARD_TOKEN line to ' + path.resolve(envFile) + ' to change that.');
    }
    console.log('\nKeep this window open. Press Ctrl+C to stop.');
  });
  const stop = () => server.close(() => { store.close(); process.exit(0); });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) main();

module.exports = { createApp, loadEnvFile };
