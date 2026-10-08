'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8');

// Runs config.js against a fake chrome API: what the person typed, the company policy
// (or a missing schema, which makes storage.managed throw) and the profile's email.
function load({ typed = {}, managed = {}, email = '', noSchema = false }) {
  const chrome = {
    storage: {
      sync: { get: async (defaults) => ({ ...defaults, ...typed }) },
      managed: { get: async () => { if (noSchema) throw new Error('no schema'); return managed; } },
    },
    identity: { getProfileUserInfo: async () => ({ email, id: email ? '1' : '' }) },
  };
  const ctx = vm.createContext({ chrome });
  vm.runInContext(CODE, ctx);
  return ctx.loadConfig();
}

const TYPED = { serverUrl: 'http://localhost:8787/', teamToken: ' typed-token ', member: '  Kiran  R ' };

test('without a policy the typed settings are used, cleaned up', async () => {
  for (const noSchema of [false, true]) {
    const c = await load({ typed: TYPED, noSchema });
    assert.equal(c.serverUrl, 'http://localhost:8787');
    assert.equal(c.teamToken, 'typed-token');
    assert.equal(c.member, 'kiran r');
    assert.deepEqual({ ...c.locked }, { serverUrl: false, teamToken: false, member: false });
  }
});

test('a company policy wins over the typed settings and locks them', async () => {
  const c = await load({
    typed: TYPED,
    managed: { serverUrl: 'http://192.168.1.10:8787', teamToken: 'company-token', memberFromEmail: true },
    email: 'Kiran.Rao@example.com',
  });
  assert.equal(c.serverUrl, 'http://192.168.1.10:8787');
  assert.equal(c.teamToken, 'company-token');
  assert.equal(c.member, 'kiran.rao');
  assert.deepEqual({ ...c.locked }, { serverUrl: true, teamToken: true, member: true });
});

test('an empty policy value does not lock, and a missing email leaves the name empty', async () => {
  const c = await load({ typed: TYPED, managed: { serverUrl: '  ', memberFromEmail: true }, email: '' });
  assert.equal(c.serverUrl, 'http://localhost:8787');
  assert.equal(c.locked.serverUrl, false);
  assert.equal(c.member, ''); // the popup then asks the person to sign in to Chrome
  assert.equal(c.locked.member, true);
});
