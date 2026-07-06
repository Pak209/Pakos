'use strict';
// User config: ~/.pakos/config.json, created on first run with mode 0600.
// This file is the only place secrets may live. It is never served, never
// logged, and no API response ever echoes it back (see docs/SECURITY.md).
//
// Shape (all keys optional except authToken, which is generated):
//   {
//     "authToken": "<hex>",            // required by every non-GET route
//     "crew": {
//       "defaultAgent": "codex",       // "codex" | "claude"
//       "models": {
//         "codex":  ["gpt-5.5"],
//         "claude": ["opus", "sonnet", "haiku"]
//       }
//     },
//     "usage": {}                      // { anthropicAdminKey?, openaiAdminKey?, xaiKey? }
//   }
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const CONFIG_DIR = process.env.PAKOS_CONFIG_DIR || path.join(os.homedir(), '.pakos');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = Object.freeze({
  crew: {
    defaultAgent: 'codex',
    models: {
      codex: ['gpt-5.5'],
      claude: ['opus', 'sonnet', 'haiku'],
    },
  },
  usage: {},
  // Cloudflare Access sign-in (docs/REMOTE.md §Sign in with Google).
  // Verification stays off until all three fields are filled in.
  access: {
    teamDomain: null,      // e.g. "pak209.cloudflareaccess.com"
    audTag: null,          // the Access app's Application Audience (AUD) tag
    allowedEmails: [],     // e.g. ["dankimoto8@gmail.com"]
  },
});

let cached = null;

function createConfig() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const config = { authToken: crypto.randomBytes(32).toString('hex'), ...structuredClone(DEFAULTS) };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  console.log(`[pakos] created ${CONFIG_PATH} (0600). ` +
    'Auth token inside — view with: cat ' + CONFIG_PATH);
  return config;
}

function getConfig() {
  if (cached) return cached;
  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`bad config ${CONFIG_PATH}: ${err.message}`);
    config = createConfig();
  }
  // Fill gaps without overwriting user edits.
  config.crew = { ...structuredClone(DEFAULTS.crew), ...config.crew };
  config.crew.models = { ...structuredClone(DEFAULTS.crew.models), ...config.crew.models };
  config.usage = { ...config.usage };
  config.access = { ...structuredClone(DEFAULTS.access), ...config.access };
  if (!config.authToken) {
    config.authToken = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    console.log('[pakos] added missing authToken to config — view with: cat ' + CONFIG_PATH);
  }
  cached = config;
  return config;
}

// Constant-time bearer check. `header` is the raw Authorization header value.
function verifyBearer(header) {
  const token = String(header || '').replace(/^Bearer\s+/i, '').trim();
  const expected = getConfig().authToken;
  if (!token || !expected) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Test hook: forget the cached config (used with PAKOS_CONFIG_DIR).
function resetConfigCache() { cached = null; }

module.exports = { getConfig, verifyBearer, resetConfigCache, CONFIG_PATH, CONFIG_DIR };
