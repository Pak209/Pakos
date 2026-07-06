'use strict';
// Cloudflare Access JWT verification — stdlib only, no npm deps.
//
// When PakOS sits behind an Access-gated tunnel, every request that passed
// the edge login carries `Cf-Access-Jwt-Assertion`: an RS256 JWT signed by
// the team's published keys. Verifying it here lets the edge identity
// (Google sign-in) authorize writes directly — no pasted token — while the
// bearer token stays as the bootstrap/admin fallback (docs/REMOTE.md).
//
// Config (~/.pakos/config.json → "access"):
//   teamDomain    "pak209.cloudflareaccess.com"
//   audTag        the app's Application Audience tag (Zero Trust → app → Overview)
//   allowedEmails ["dankimoto8@gmail.com"]
// Verification is OFF until all three are set — behavior then matches v0.2.
const crypto = require('node:crypto');

const KEY_TTL_MS = 6 * 3600 * 1000;
const CLOCK_SKEW_S = 30;

let keyCache = { domain: null, at: 0, keys: new Map() }; // kid -> KeyObject

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

async function fetchKeys(teamDomain) {
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`,
    { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`key fetch failed: HTTP ${res.status}`);
  const { keys } = await res.json();
  const map = new Map();
  for (const jwk of keys || []) {
    try { map.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' })); }
    catch { /* skip malformed key */ }
  }
  if (!map.size) throw new Error('no usable signing keys published');
  return map;
}

async function keyFor(teamDomain, kid) {
  const fresh = keyCache.domain === teamDomain && Date.now() - keyCache.at < KEY_TTL_MS;
  if (!fresh || !keyCache.keys.has(kid)) {
    keyCache = { domain: teamDomain, at: Date.now(), keys: await fetchKeys(teamDomain) };
  }
  return keyCache.keys.get(kid) || null;
}

// Returns { email } for a valid, allowlisted identity; throws otherwise.
// Callers must treat any throw as 401 — never fall through to "allowed".
async function verifyAccessJwt(token, access) {
  const { teamDomain, audTag, allowedEmails } = access || {};
  if (!teamDomain || !audTag || !Array.isArray(allowedEmails) || !allowedEmails.length) {
    throw new Error('access verification not configured');
  }
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed JWT');

  let header, payload;
  try { header = b64urlJson(parts[0]); payload = b64urlJson(parts[1]); }
  catch { throw new Error('undecodable JWT'); }

  if (header.alg !== 'RS256') throw new Error(`unexpected alg: ${header.alg}`); // pin the alg
  const key = await keyFor(teamDomain, header.kid);
  if (!key) throw new Error('unknown signing key');

  const ok = crypto.verify('RSA-SHA256',
    Buffer.from(parts[0] + '.' + parts[1]),
    key, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('bad signature');

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && now > payload.exp + CLOCK_SKEW_S) throw new Error('expired');
  if (typeof payload.nbf === 'number' && now < payload.nbf - CLOCK_SKEW_S) throw new Error('not yet valid');
  if (payload.iss !== `https://${teamDomain}`) throw new Error('wrong issuer');

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(audTag)) throw new Error('wrong audience');

  const email = String(payload.email || '').trim().toLowerCase();
  if (!email || !allowedEmails.some((e) => String(e).trim().toLowerCase() === email)) {
    throw new Error('email not on the allowlist');
  }
  return { email };
}

// Test hook: preload the key cache so tests never touch the network.
function _setKeyCache(cache) { keyCache = cache; }

module.exports = { verifyAccessJwt, _setKeyCache };
