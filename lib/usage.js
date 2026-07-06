'use strict';
// Usage sources for GET /api/usage. Subscription numbers come from LOCAL
// FILE PARSING only — no credentials read, no OAuth tokens, no cookies
// (docs/SECURITY.md). Provider API usage activates only when the user has
// put admin keys into ~/.pakos/config.json, and those keys are used
// server-side exclusively; no endpoint ever echoes them.
//
//   codex  — exact, server-reported: Codex CLI writes a `rate_limits`
//            snapshot (5h + weekly used %, reset times, plan) into every
//            session file under ~/.codex/sessions/.
//   claude — estimate: token totals summed from Claude Code transcripts
//            under ~/.claude/projects/ for the trailing 5h / 7d windows.
//            Anthropic's official utilization % needs an OAuth call we
//            deliberately don't make.
//   grok   — always null: SuperGrok has no public usage API and we don't
//            scrape cookies. The UI renders a placeholder.
//   apis   — per-provider API-key usage, [] until keys exist in config.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MAX_JSONL_BYTES = 32 * 1024 * 1024; // skip absurdly large transcript files
const CODEX_FILES_TO_CHECK = 10;          // newest session files scanned for a snapshot
const HOUR = 3600 * 1000;

function listFilesByMtime(dir, ext) {
  let names;
  try {
    names = fs.readdirSync(dir, { recursive: true });
  } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!String(name).endsWith(ext)) continue;
    const full = path.join(dir, String(name));
    try {
      const st = fs.statSync(full);
      if (st.isFile()) out.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
    } catch { /* raced away */ }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// ── Codex (exact) ────────────────────────────────────────────────────────────
function codexUsage(codexHome = path.join(os.homedir(), '.codex')) {
  const files = listFilesByMtime(path.join(codexHome, 'sessions'), '.jsonl')
    .slice(0, CODEX_FILES_TO_CHECK);

  for (const f of files) {
    if (f.size > MAX_JSONL_BYTES) continue;
    let text;
    try { text = fs.readFileSync(f.path, 'utf8'); } catch { continue; }
    // Last rate_limits event in the newest file wins.
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      let event;
      try { event = JSON.parse(lines[i]); } catch { continue; }
      const rl = event?.payload?.rate_limits;
      if (!rl?.primary) continue;
      const win = (w) => w ? {
        usedPercent: w.used_percent,
        windowMinutes: w.window_minutes,
        resetsAt: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null,
      } : null;
      return {
        plan: rl.plan_type || null,
        capturedAt: event.timestamp || null,
        primary: win(rl.primary),      // 5h window
        secondary: win(rl.secondary),  // weekly window
        source: 'codex session files (server-reported)',
      };
    }
  }
  return null; // no codex sessions on this machine yet
}

// ── Claude (estimate) ────────────────────────────────────────────────────────
function claudeUsage(claudeHome = path.join(os.homedir(), '.claude'), now = Date.now()) {
  const files = listFilesByMtime(path.join(claudeHome, 'projects'), '.jsonl')
    .filter((f) => now - f.mtimeMs < 8 * 24 * HOUR && f.size <= MAX_JSONL_BYTES);
  if (!files.length) return null;

  const mkWindow = () => ({ input: 0, cacheCreation: 0, cacheRead: 0, output: 0, messages: 0 });
  const windows = { fiveHour: mkWindow(), week: mkWindow() };
  const seen = new Set(); // dedup retried/duplicated assistant messages by id

  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f.path, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"')) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const usage = entry?.message?.usage;
      const at = Date.parse(entry?.timestamp || '');
      if (!usage || !Number.isFinite(at)) continue;
      const age = now - at;
      if (age > 7 * 24 * HOUR || age < 0) continue;
      const id = entry.message.id;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      for (const w of age <= 5 * HOUR ? [windows.fiveHour, windows.week] : [windows.week]) {
        w.input += usage.input_tokens || 0;
        w.cacheCreation += usage.cache_creation_input_tokens || 0;
        w.cacheRead += usage.cache_read_input_tokens || 0;
        w.output += usage.output_tokens || 0;
        w.messages += 1;
      }
    }
  }
  return {
    estimate: true, // token totals, not Anthropic's official utilization %
    windows,
    source: 'claude transcripts (local estimate)',
  };
}

// ── Provider APIs (dormant until keys are added to config) ──────────────────
async function fetchJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function anthropicApiUsage(adminKey, now) {
  // https://docs.anthropic.com — Admin API usage report, daily buckets, last 7d.
  const start = new Date(now - 7 * 24 * HOUR).toISOString();
  const data = await fetchJson(
    'https://api.anthropic.com/v1/organizations/usage_report/messages' +
      `?starting_at=${encodeURIComponent(start)}&bucket_width=1d`,
    { 'x-api-key': adminKey, 'anthropic-version': '2023-06-01' });
  let input = 0, output = 0;
  for (const bucket of data.data || []) {
    for (const r of bucket.results || []) {
      input += (r.uncached_input_tokens || 0) + (r.cache_creation?.ephemeral_5m_input_tokens || 0) +
        (r.cache_creation?.ephemeral_1h_input_tokens || 0);
      output += r.output_tokens || 0;
    }
  }
  return { provider: 'anthropic', period: '7d', inputTokens: input, outputTokens: output };
}

async function openaiApiUsage(adminKey, now) {
  // https://platform.openai.com/docs/api-reference/usage — completions usage, last 7d.
  const start = Math.floor((now - 7 * 24 * HOUR) / 1000);
  const data = await fetchJson(
    `https://api.openai.com/v1/organization/usage/completions?start_time=${start}&bucket_width=1d&limit=7`,
    { Authorization: `Bearer ${adminKey}` });
  let input = 0, output = 0;
  for (const bucket of data.data || []) {
    for (const r of bucket.results || []) {
      input += r.input_tokens || 0;
      output += r.output_tokens || 0;
    }
  }
  return { provider: 'openai', period: '7d', inputTokens: input, outputTokens: output };
}

async function apiUsage(usageConfig = {}, now = Date.now()) {
  const jobs = [];
  if (usageConfig.anthropicAdminKey) {
    jobs.push(anthropicApiUsage(usageConfig.anthropicAdminKey, now)
      .catch((err) => ({ provider: 'anthropic', error: err.message })));
  }
  if (usageConfig.openaiAdminKey) {
    jobs.push(openaiApiUsage(usageConfig.openaiAdminKey, now)
      .catch((err) => ({ provider: 'openai', error: err.message })));
  }
  if (usageConfig.xaiKey) {
    // xAI's management/usage API isn't wired yet — say so rather than guess.
    jobs.push(Promise.resolve({ provider: 'xai', error: 'usage API not wired yet' }));
  }
  return Promise.all(jobs);
}

// ── Assembler with a short cache (file scans are cheap but not free) ────────
let cache = null;
let cacheAt = 0;
const CACHE_MS = 60 * 1000;

async function getUsage(config) {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_MS) return cache;
  const [apis] = await Promise.all([apiUsage(config.usage, now)]);
  cache = {
    codex: codexUsage(),
    claude: claudeUsage(undefined, now),
    grok: null, // SuperGrok: no public usage API; placeholder by design
    apis,
    generatedAt: new Date(now).toISOString(),
  };
  cacheAt = now;
  return cache;
}

module.exports = { getUsage, codexUsage, claudeUsage };
