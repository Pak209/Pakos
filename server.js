#!/usr/bin/env node
'use strict';
// PakOS — local, read-only project command center.
// Zero npm dependencies: node:http + node:sqlite (Node >= 22).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { scan, PROJECTS_ROOT } = require('./lib/scanner');
const { replaceScan, getState, DB_PATH } = require('./lib/db');
const { getConfig, verifyBearer, CONFIG_PATH } = require('./lib/config');

const HOST = process.env.PAKOS_HOST || '127.0.0.1';
const PORT = Number(process.env.PAKOS_PORT || 4180);
const SCAN_INTERVAL_MS = Number(process.env.PAKOS_SCAN_INTERVAL || 300) * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const VERSION = '0.1.0';

let scanning = false;
let lastScanError = null;

function runScan() {
  if (scanning) return;
  scanning = true;
  try {
    const result = scan();
    replaceScan(result);
    lastScanError = null;
    console.log(`[pakos] scanned ${result.projects.length} projects, ` +
      `${result.tasks.length} tasks in ${result.durationMs}ms`);
  } catch (err) {
    lastScanError = String(err.message || err);
    console.error('[pakos] scan failed:', lastScanError);
  } finally {
    scanning = false;
  }
}

// Tailscale detection: a CGNAT (100.64/10) address on an interface.
function tailscaleIP() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && /^100\./.test(a.address)) {
        const second = Number(a.address.split('.')[1]);
        if (second >= 64 && second <= 127) return a.address;
      }
    }
  }
  return null;
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

// ── Auth + audit (v0.2 — pulled forward from the v0.4 roadmap slot) ─────────
// Every non-GET route requires `Authorization: Bearer <authToken>` from
// ~/.pakos/config.json. Identity at the network edge (who can reach this
// server at all) is Cloudflare Access's job — see docs/REMOTE.md.
const AUDIT_PATH = path.join(__dirname, 'data', 'audit.log');

function audit(req, action, detail) {
  // Append-only trail of every authenticated write. The Cf-Access email is
  // stamped by the edge; requests that bypass the tunnel show as "local".
  const who = req.headers['cf-access-authenticated-user-email'] || 'local';
  const line = JSON.stringify({ at: new Date().toISOString(), action, detail, who });
  try {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    fs.appendFileSync(AUDIT_PATH, line + '\n');
  } catch (err) {
    console.error('[pakos] audit write failed:', err.message);
  }
}

function requireAuth(req, res) {
  if (verifyBearer(req.headers.authorization)) return true;
  json(res, 401, { error: 'unauthorized', hint: `token lives in ${CONFIG_PATH}` });
  return false;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  // Path-traversal guard + no dotfiles.
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) ||
      path.basename(filePath).startsWith('.')) {
    res.writeHead(404); res.end('not found'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/state' && req.method === 'GET') {
    const state = getState();
    return json(res, 200, {
      version: VERSION,
      projectsRoot: PROJECTS_ROOT,
      system: {
        node: process.version,
        db: fs.existsSync(DB_PATH),
        scanning,
        lastScanError,
        tailscale: tailscaleIP(),
        host: HOST,
        uptimeSec: Math.round(process.uptime()),
        scanIntervalSec: SCAN_INTERVAL_MS / 1000,
      },
      ...state,
    });
  }

  if (url.pathname === '/api/scan' && req.method === 'POST') {
    // Read-only with respect to repositories: refreshes PakOS's own database.
    if (!requireAuth(req, res)) return;
    audit(req, 'scan', 'manual rescan');
    runScan();
    return json(res, 200, { ok: true, scannedAt: new Date().toISOString() });
  }

  if (req.method !== 'GET') { res.writeHead(405); return res.end('read-only'); }
  serveStatic(res, url.pathname);
});

getConfig(); // ensure ~/.pakos/config.json + auth token exist before first request
runScan();
setInterval(runScan, SCAN_INTERVAL_MS).unref();

server.listen(PORT, HOST, () => {
  console.log(`[pakos] v${VERSION} serving ${PROJECTS_ROOT}`);
  console.log(`[pakos] http://${HOST}:${PORT}  (db: ${DB_PATH})`);
  const ts = tailscaleIP();
  if (ts && HOST !== '127.0.0.1') console.log(`[pakos] tailscale: http://${ts}:${PORT}`);
});
