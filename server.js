#!/usr/bin/env node
'use strict';
// PakOS — local, read-only project command center.
// Zero npm dependencies: node:http + node:sqlite (Node >= 22).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { scan, PROJECTS_ROOT } = require('./lib/scanner');
const { replaceScan, getState, getProject, getHistory, DB_PATH } = require('./lib/db');
const { getConfig, verifyBearer, CONFIG_PATH } = require('./lib/config');
const { createMission, moveMission, BoardError } = require('./lib/board');
const { verifyAccessJwt } = require('./lib/access');
const { getUsage } = require('./lib/usage');
const crew = require('./lib/crew');
const recommend = require('./lib/recommend');
const { computeAll, computeHealth } = require('./lib/health');
const { appendRejected } = require('./lib/memory');

const HOST = process.env.PAKOS_HOST || '127.0.0.1';
const PORT = Number(process.env.PAKOS_PORT || 4180);
const SCAN_INTERVAL_MS = Number(process.env.PAKOS_SCAN_INTERVAL || 300) * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const VERSION = '0.2.0';

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
    try {
      const det = recommend.runDetectors(getState(), PROJECTS_ROOT);
      if (det.created) console.log(`[pakos] detectors: ${det.created} new recommendation(s)`);
    } catch (err) {
      console.error('[pakos] detectors failed:', err.message);
    }
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

// ── Auth + audit ─────────────────────────────────────────────────────────────
// Two ways to authorize a write, tried in order:
//   1. bearer token from ~/.pakos/config.json — bootstrap/admin fallback for
//      loopback, Tailscale, and scripts;
//   2. verified Cloudflare Access identity (lib/access.js) — the normal
//      browser path once `access` is configured: the edge's Google login IS
//      the credential, so the UI never needs the token.
const AUDIT_PATH = path.join(__dirname, 'data', 'audit.log');

function audit(who, action, detail) {
  // Append-only trail of every authenticated write. `who` is the VERIFIED
  // identity from authenticate() — never a raw header.
  const line = JSON.stringify({ at: new Date().toISOString(), action, detail, who });
  try {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    fs.appendFileSync(AUDIT_PATH, line + '\n');
  } catch (err) {
    console.error('[pakos] audit write failed:', err.message);
  }
}

// Resolves to { who } on success, null on failure (response already sent).
async function authenticate(req, res) {
  if (verifyBearer(req.headers.authorization)) return { who: 'token' };

  const jwt = req.headers['cf-access-jwt-assertion'];
  const { access } = getConfig();
  if (jwt && access?.teamDomain && access?.audTag && access?.allowedEmails?.length) {
    // CSRF guard: this path is cookie-derived (the edge turned the Access
    // cookie into this header), so a cross-site POST would carry it too.
    // Browsers always send Origin on POST — require it to match our host.
    const origin = req.headers.origin;
    if (origin) {
      let originHost = null;
      try { originHost = new URL(origin).host; } catch { /* fall through */ }
      if (originHost !== req.headers.host) {
        json(res, 403, { error: 'cross-origin write rejected' });
        return null;
      }
    }
    try {
      const { email } = await verifyAccessJwt(jwt, access);
      return { who: email };
    } catch (err) {
      json(res, 401, { error: `access identity rejected: ${err.message}` });
      return null;
    }
  }

  json(res, 401, { error: 'unauthorized', hint: `token lives in ${CONFIG_PATH}` });
  return null;
}

const MAX_BODY_BYTES = 16 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new BoardError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); }
      catch { reject(new BoardError(400, 'invalid JSON body')); }
    });
    req.on('error', reject);
  });
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
    const { access, health } = getConfig();
    const grades = computeAll(state, PROJECTS_ROOT, health.weights);
    state.projects = state.projects.map((p) => ({ ...p, health: grades[p.name] || null }));
    const accessOn = !!(access?.teamDomain && access?.audTag && access?.allowedEmails?.length);
    return json(res, 200, {
      version: VERSION,
      projectsRoot: PROJECTS_ROOT,
      system: {
        // teamDomain only — never the aud tag or allowlist
        access: accessOn ? { enabled: true, teamDomain: access.teamDomain } : { enabled: false },
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

  if (url.pathname === '/api/usage' && req.method === 'GET') {
    // Local file parsing only — see lib/usage.js. Cached ~60s.
    getUsage(getConfig())
      .then((usage) => json(res, 200, usage))
      .catch((err) => json(res, 500, { error: String(err.message || err) }));
    return;
  }

  // Per-project detail: full commit history, branch list, missions.
  if (url.pathname.startsWith('/api/projects/') && req.method === 'GET') {
    let name;
    try { name = decodeURIComponent(url.pathname.slice('/api/projects/'.length)); }
    catch { return json(res, 400, { error: 'bad project name' }); }
    const detail = getProject(name);
    if (!detail) return json(res, 404, { error: 'unknown project' });
    detail.health = computeHealth(detail.project, detail.tasks, PROJECTS_ROOT,
      getConfig().health.weights);
    detail.history = getHistory(name);
    return json(res, 200, detail);
  }

  // Mission writes — the only routes that modify anything outside PakOS's
  // own data/, and they can only touch a project's .pakos/*.md board files
  // (lib/board.js). Bearer-auth'd and audited like every other write.
  if ((url.pathname === '/api/missions' || url.pathname === '/api/missions/move') &&
      req.method === 'POST') {
    authenticate(req, res).then((id) => {
      if (!id) return;
      return readBody(req)
        .then((body) => {
          const result = url.pathname === '/api/missions'
            ? createMission(PROJECTS_ROOT, body)
            : moveMission(PROJECTS_ROOT, body);
          audit(id.who, url.pathname === '/api/missions' ? 'mission_create' : 'mission_move',
            `${result.project}: ${result.title} → ${result.status}`);
          runScan();
          return json(res, 200, { ok: true, mission: result });
        })
        .catch((err) => {
          const code = err instanceof BoardError ? err.code : 500;
          if (code === 500) console.error('[pakos] mission write failed:', err);
          return json(res, code, { error: err.message });
        });
    });
    return;
  }

  // ── Recommendations (docs/INTELLIGENCE.md §3 — propose only; the human
  // accept below is the only path from suggestion to board change)
  if (url.pathname === '/api/recommendations' && req.method === 'GET') {
    return json(res, 200, { recommendations: recommend.listOpen() });
  }

  const recMatch = url.pathname.match(/^\/api\/recommendations\/([\w-]+)\/(accept|reject|snooze)$/);
  if (recMatch && req.method === 'POST') {
    authenticate(req, res).then((id) => {
      if (!id) return;
      return readBody(req).then((body) => {
        const [, recId, action] = recMatch;
        const rec = recommend.get(recId);
        if (!rec) return json(res, 404, { error: 'unknown recommendation' });
        if (rec.state !== 'suggested' && rec.state !== 'snoozed') {
          return json(res, 409, { error: `recommendation is already ${rec.state}` });
        }

        if (action === 'accept') {
          // Your tap = your move: applied under the caller's verified
          // identity, any target column, recommendation as provenance.
          const result = rec.kind === 'reconciliation'
            ? moveMission(PROJECTS_ROOT, { project: rec.project, sourceFile: rec.source_file,
                title: rec.title, toStatus: rec.suggested_status })
            : createMission(PROJECTS_ROOT, { project: rec.project, title: rec.title, status: 'backlog' });
          recommend.setState(recId, 'accepted');
          audit(id.who, 'rec_accept',
            `${rec.project}: [${rec.kind}] ${rec.title} → ${result.status} (rec ${recId})`);
          runScan();
          return json(res, 200, { ok: true, applied: result });
        }
        if (action === 'reject') {
          appendRejected(PROJECTS_ROOT, rec.project,
            { title: rec.title, kind: rec.kind, reason: body.reason, by: id.who });
          recommend.setState(recId, 'rejected');
          audit(id.who, 'rec_reject',
            `${rec.project}: [${rec.kind}] ${rec.title}${body.reason ? ` — ${body.reason}` : ''}`);
          return json(res, 200, { ok: true });
        }
        recommend.setState(recId, 'snoozed', { snoozeDays: Number(body.days) || undefined });
        audit(id.who, 'rec_snooze', `${rec.project}: [${rec.kind}] ${rec.title}`);
        return json(res, 200, { ok: true });
      });
    }).catch((err) => {
      const code = err instanceof BoardError ? err.code : 500;
      if (code === 500) console.error('[pakos] recommendation action failed:', err);
      return json(res, code, { error: err.message });
    });
    return;
  }

  // Board reconciliation: one human click → one fixed-template, read-only
  // analyze run; its validated JSON output becomes recommendations.
  const reconMatch = url.pathname.match(/^\/api\/recon\/([^/]+)$/);
  if (reconMatch && req.method === 'POST') {
    authenticate(req, res).then((id) => {
      if (!id) return;
      let project;
      try { project = decodeURIComponent(reconMatch[1]); }
      catch { return json(res, 400, { error: 'bad project name' }); }
      const result = crew.dispatchTemplate({
        project,
        mission: 'Board reconciliation audit',
        prompt: recommend.reconPrompt(project),
      }, getConfig(), PROJECTS_ROOT, {
        onEvent: (event, info, detail) => audit(`crew:${info.agent}`, event, detail ||
          `${info.agent}/${info.model} ${info.mode} on ${info.project}: ${info.mission}`),
        onComplete: (run, stdout) => {
          if (run.status !== 'complete') return;
          const parsed = recommend.parseReconOutput(stdout);
          if (parsed.error) {
            audit(`crew:${run.agent}`, 'recon_parse_failed', `${project}: ${parsed.error}`);
            return;
          }
          const { tasks } = getState();
          const outcome = recommend.applyReconResults(project, parsed.entries, tasks,
            { runId: run.id, projectsRoot: PROJECTS_ROOT });
          audit(`crew:${run.agent}`, 'recon_complete',
            `${project}: ${outcome.created.length} recommendation(s), ${outcome.dropped.length} dropped`);
          runScan();
        },
      });
      if (result.error) return json(res, result.code || 400, { error: result.error });
      audit(id.who, 'recon_dispatch', `${project}: board reconciliation audit`);
      return json(res, 200, result.run);
    });
    return;
  }

  // ── Crew (docs/ROADMAP.md v0.2 slice; all writes behind auth + 2-step gate)
  if (url.pathname === '/api/crew' && req.method === 'GET') {
    const { crew: crewCfg } = getConfig(); // models + defaultAgent only — no secrets live here
    return json(res, 200, { agents: crewCfg, runs: crew.listRuns() });
  }

  const runMatch = url.pathname.match(/^\/api\/crew\/runs\/([\w-]+)$/);
  if (runMatch && req.method === 'GET') {
    const run = crew.getRun(runMatch[1]);
    return run ? json(res, 200, run) : json(res, 404, { error: 'unknown run' });
  }

  if (url.pathname === '/api/crew/dispatch' && req.method === 'POST') {
    authenticate(req, res).then((id) => {
      if (!id) return;
      return readBody(req).then((body) => {
        if (body.confirm && body.dispatchId) {
          // Step 2: the human confirmed the exact preview — spawn. Board-
          // bound missions move → In Progress here and → Review when the
          // agent finishes; Done is never automated (docs/ROADMAP.md).
          const result = crew.confirmDispatch(String(body.dispatchId), {
            onEvent: (event, info, detail) => {
              audit(`crew:${info.agent}`, event, detail ||
                `${info.agent}/${info.model} ${info.mode} on ${info.project}: ${info.mission}`);
              runScan(); // board/handoff changed — refresh the snapshot
            },
          });
          if (result.error) return json(res, result.code || 400, { error: result.error });
          audit(id.who, 'crew_dispatch', `${result.run.agent}/${result.run.model} ${result.run.mode} ` +
            `on ${result.run.project}: ${result.run.mission}`);
          runScan();
          return json(res, 200, result.run);
        }
        // Step 1: preview only — nothing spawns, nothing is written.
        const preview = crew.previewDispatch(body, getConfig(), PROJECTS_ROOT);
        if (preview.error) return json(res, 400, { error: preview.error });
        return json(res, 200, preview);
      });
    }).catch((err) => json(res, 400, { error: String(err.message || err) }));
    return;
  }

  const cancelMatch = url.pathname.match(/^\/api\/crew\/runs\/([\w-]+)\/cancel$/);
  if (cancelMatch && req.method === 'POST') {
    authenticate(req, res).then((id) => {
      if (!id) return;
      const result = crew.cancelRun(cancelMatch[1]);
      if (result.error) return json(res, result.code || 400, { error: result.error });
      audit(id.who, 'crew_cancel', `run ${cancelMatch[1]}`);
      return json(res, 200, result.run);
    });
    return;
  }

  if (url.pathname === '/api/scan' && req.method === 'POST') {
    // Read-only with respect to repositories: refreshes PakOS's own database.
    authenticate(req, res).then((id) => {
      if (!id) return;
      audit(id.who, 'scan', 'manual rescan');
      runScan();
      return json(res, 200, { ok: true, scannedAt: new Date().toISOString() });
    });
    return;
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
