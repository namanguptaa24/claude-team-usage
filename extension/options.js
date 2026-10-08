'use strict';
const $ = (id) => document.getElementById(id);
const fields = ['serverUrl', 'teamToken', 'member'];
const LABEL = { serverUrl: 'server address', teamToken: 'team token', member: 'your name (from your work email)' };
let current = null; // loadConfig() result: what is in effect, and which parts the company set

// Settings the company set by policy come from the policy, the rest from the form.
function readForm() {
  return {
    serverUrl: current.locked.serverUrl ? current.serverUrl : $('serverUrl').value.trim().replace(/\/+$/, ''),
    teamToken: current.locked.teamToken ? current.teamToken : $('teamToken').value.trim(),
    member: current.locked.member ? current.member : cleanName($('member').value),
  };
}

function show(text, ok) {
  const el = $('result');
  el.textContent = text;
  el.className = ok ? 'ok' : 'err';
}

// After Save the message starts with "Saved.", so it reads differently from a plain test.
async function test(cfg, saved = false) {
  const prefix = saved ? 'Saved. ' : '';
  if (!cfg.member && current.locked.member) {
    return show('Your company takes your name from your work email, but this Chrome profile is not signed in. Sign in to Chrome with your work account.', false);
  }
  try {
    const res = await fetch(cfg.serverUrl + '/api/ping', { headers: { Authorization: 'Bearer ' + cfg.teamToken } });
    if (res.status === 401) return show(prefix + 'The server rejected the token.', false);
    if (!res.ok) return show(prefix + 'The server answered HTTP ' + res.status + '.', false);
    show(prefix + 'Connected. Usage from claude.ai will now be reported as "' + cfg.member + '".' +
      (saved ? ' You can close this tab.' : ''), true);
  } catch (e) {
    show(prefix + 'Could not reach the server: ' + e.message, false);
  }
}

async function init() {
  current = await loadConfig();
  const typed = await chrome.storage.sync.get({ serverUrl: '', teamToken: '', member: '' });
  const lockedFields = fields.filter((f) => current.locked[f]);
  for (const f of fields) {
    const input = $(f);
    if (!current.locked[f]) { input.value = typed[f] || ''; continue; }
    input.disabled = true;
    input.title = 'Set by your company';
    if (f === 'teamToken') input.placeholder = 'Set by your company';
    else input.value = current[f] || '';
  }
  if (lockedFields.length) {
    const note = $('managed-note');
    note.textContent = 'Set by your company: ' + lockedFields.map((f) => LABEL[f]).join(', ') + '. These cannot be changed here.';
    note.hidden = false;
  }
  $('save').hidden = lockedFields.length === fields.length;
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cfg = readForm();
  try { new URL(cfg.serverUrl); } catch { return show('Enter a full address such as http://192.168.1.10:8787', false); }
  if (!cfg.teamToken || !cfg.member) return show('All three fields are required.', false);
  const typed = {};
  for (const f of fields) if (!current.locked[f]) typed[f] = cfg[f];
  await chrome.storage.sync.set(typed);
  if (!current.locked.member) $('member').value = cfg.member;
  show('Saved. Testing...', true);
  await test(cfg, true);
});

$('test').addEventListener('click', () => test(readForm()));
init();
