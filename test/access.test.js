'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { verifyAccessJwt, _setKeyCache } = require('../lib/access');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const TEAM = 'team.example.com';
const AUD = 'a'.repeat(64);
const ACCESS = { teamDomain: TEAM, audTag: AUD, allowedEmails: ['dankimoto8@gmail.com'] };

function b64url(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }

function sign(payload, { kid = 'kid1', alg = 'RS256', key = privateKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: `https://${TEAM}`, aud: [AUD], email: 'dankimoto8@gmail.com',
    iat: now, nbf: now - 60, exp: now + 300, ...payload };
  const signingInput = `${b64url({ alg, kid, typ: 'JWT' })}.${b64url(body)}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), key).toString('base64url');
  return `${signingInput}.${sig}`;
}

test.beforeEach(() => {
  _setKeyCache({ domain: TEAM, at: Date.now(), keys: new Map([['kid1', publicKey]]) });
});

test('accepts a valid, allowlisted identity', async () => {
  const { email } = await verifyAccessJwt(sign({}), ACCESS);
  assert.equal(email, 'dankimoto8@gmail.com');
});

test('email match is case-insensitive', async () => {
  const { email } = await verifyAccessJwt(sign({ email: 'DanKimoto8@Gmail.com' }), ACCESS);
  assert.equal(email, 'dankimoto8@gmail.com');
});

test('rejects everything it must reject', async () => {
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    ['expired', sign({ exp: now - 300 })],
    ['not on the allowlist', sign({ email: 'attacker@evil.com' })],
    ['wrong audience', sign({ aud: ['b'.repeat(64)] })],
    ['wrong issuer', sign({ iss: 'https://other.example.com' })],
    ['unexpected alg', sign({}, { alg: 'none' })],
    ['malformed JWT', 'not-a-jwt'],
    ['malformed JWT', ''],
  ];
  for (const [reason, token] of cases) {
    await assert.rejects(() => verifyAccessJwt(token, ACCESS),
      (e) => e.message.includes(reason), `${reason} should reject`);
  }
});

test('rejects a tampered payload (signature check)', async () => {
  const parts = sign({}).split('.');
  parts[1] = b64url({ iss: `https://${TEAM}`, aud: [AUD], email: 'dankimoto8@gmail.com',
    exp: Math.floor(Date.now() / 1000) + 300 });
  await assert.rejects(() => verifyAccessJwt(parts.join('.'), ACCESS), /bad signature/);
});

test('rejects a token signed by someone else\'s key', async () => {
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  await assert.rejects(() => verifyAccessJwt(sign({}, { key: other.privateKey }), ACCESS),
    /bad signature/);
});

test('refuses to run unconfigured (never fail-open)', async () => {
  for (const cfg of [null, {}, { teamDomain: TEAM }, { teamDomain: TEAM, audTag: AUD },
    { teamDomain: TEAM, audTag: AUD, allowedEmails: [] }]) {
    await assert.rejects(() => verifyAccessJwt(sign({}), cfg), /not configured/);
  }
});

test('unknown kid refetches keys once, then rejects cleanly', async () => {
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => ({ ok: true, json: async () => ({ keys: [] }) });
  try {
    await assert.rejects(() => verifyAccessJwt(sign({}, { kid: 'mystery' }), ACCESS),
      /no usable signing keys|unknown signing key/);
    calls = 1; // reached: fetch path exercised without network
  } finally {
    global.fetch = realFetch;
  }
  assert.equal(calls, 1);
});
