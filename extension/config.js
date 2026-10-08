'use strict';
// Settings shared by the service worker, the popup and the settings page.
//
// A company can push the settings with a Chrome policy (chrome.storage.managed, see
// managed_schema.json). Policy values win over what the person typed on the settings
// page, and the settings page shows them read-only. With memberFromEmail in the policy,
// the name is the part of the Chrome profile's email before the @, so nobody can report
// under someone else's name.

function cleanName(v) {
  return String(v || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

async function readManaged() {
  try {
    return (await chrome.storage.managed.get(null)) || {};
  } catch {
    return {}; // no policy
  }
}

async function memberFromEmail() {
  try {
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });
    return cleanName(String((info && info.email) || '').split('@')[0]);
  } catch {
    return '';
  }
}

async function loadConfig() {
  const typed = await chrome.storage.sync.get({ serverUrl: '', teamToken: '', member: '' });
  const managed = await readManaged();
  const has = (k) => typeof managed[k] === 'string' && managed[k].trim() !== '';
  const fromEmail = managed.memberFromEmail === true;
  return {
    serverUrl: String(has('serverUrl') ? managed.serverUrl : typed.serverUrl || '').trim().replace(/\/+$/, ''),
    teamToken: String(has('teamToken') ? managed.teamToken : typed.teamToken || '').trim(),
    member: fromEmail ? await memberFromEmail() : cleanName(typed.member),
    locked: { serverUrl: has('serverUrl'), teamToken: has('teamToken'), member: fromEmail },
  };
}
