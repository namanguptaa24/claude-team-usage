'use strict';
// Reads the plan's rate-limit utilisation (5-hour session, weekly, per-model weekly).
// Uses the Claude Code login on this machine. The token is sent only to
// api.anthropic.com and never to the team server.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

function pickUsage(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    if (/^(five_hour|seven_day)/i.test(k) || k === 'limits') out[k] = v;
  }
  return out;
}

function tokenFromCredentials(obj, now) {
  const o = obj && obj.claudeAiOauth;
  if (!o || typeof o.accessToken !== 'string' || !o.accessToken) return null;
  if (o.expiresAt && Number(o.expiresAt) < now + 60_000) return null;
  return o.accessToken;
}

function readOauthToken(dir, now = Date.now()) {
  try {
    const t = tokenFromCredentials(JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8')), now);
    if (t) return t;
  } catch { /* not logged in with a subscription on this machine, or stored elsewhere */ }
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      const t = tokenFromCredentials(JSON.parse(out), now);
      if (t) return t;
    } catch { /* keychain item missing or access denied */ }
  }
  return null;
}

async function fetchLimitSnapshot(dir, log) {
  const token = readOauthToken(dir);
  if (!token) {
    log('limit snapshot skipped: no current Claude subscription login found on this machine');
    return null;
  }
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: 'Bearer ' + token,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
        'User-Agent': 'claude-team-usage/1.0',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      log('limit snapshot skipped: usage endpoint returned HTTP ' + res.status);
      return null;
    }
    const raw = pickUsage(await res.json());
    if (!Object.keys(raw).length) return null;
    return { snapshot_id: crypto.randomUUID(), ts: Date.now(), raw };
  } catch (e) {
    log('limit snapshot failed: ' + (e && e.message));
    return null;
  }
}

module.exports = { pickUsage, readOauthToken, fetchLimitSnapshot, tokenFromCredentials };
