'use strict';
// Mission Intelligence, slice 1 (docs/INTELLIGENCE.md §3, §5): recommendation
// records with a human accept/reject/snooze loop. Two candidate sources:
//   - deterministic detectors, run after every scan — free and explainable;
//   - reconciliation, an LLM analyze run (human-triggered, read-only) whose
//     structured output is validated here before anything becomes a record.
// Nothing in this module executes agents or edits boards — it only proposes.
// Accepting is a separate, auth'd, audited human action handled in server.js.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { db } = require('./db');
const { cleanTitle, splitOwner } = require('./tasks');
const { readRejectedTitles, normalize } = require('./memory');
const { STATUSES } = require('./board');

const EXPIRE_DAYS = 14;
const SNOOZE_DAYS = 7;
const MAX_EVIDENCE = 6;
const MAX_TITLE = 140;

const STATUS_LABELS = { backlog: 'Backlog', ready: 'Ready', in_progress: 'In Progress', review: 'Review', done: 'Done' };

function normalizeStatus(raw) {
  const s = String(raw || '').toLowerCase().replace(/[\s-]+/g, '_').trim();
  return STATUSES.includes(s) ? s : null;
}

// Identity: reconciliation recs are about a specific mission, so the title
// is part of their identity. Detector recs are about a *condition* whose
// counts fluctuate ("7 uncommitted files" -> "8"), so their identity is just
// (project, kind, suggestion) and the title refreshes in place; otherwise
// every count change would mint a new record that dodges snooze/rejection.
function stableKey(title) {
  return normalize(title).replace(/\d+/g, '#');
}

const q = {
  byMissionTitle: db.prepare(`SELECT * FROM recommendations
    WHERE project = ? AND kind = ? AND title = ? AND coalesce(suggested_status,'') = ?
    ORDER BY created_at DESC LIMIT 1`),
  byCondition: db.prepare(`SELECT * FROM recommendations
    WHERE project = ? AND kind = ? AND coalesce(suggested_status,'') = ?
    ORDER BY created_at DESC LIMIT 1`),
  insert: db.prepare(`INSERT INTO recommendations
    (id, project, kind, title, current_status, suggested_status, source_file,
     evidence, provenance, state, created_at, updated_at, snooze_until)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  refresh: db.prepare(`UPDATE recommendations
    SET title = ?, evidence = ?, provenance = ?, current_status = ?, updated_at = ? WHERE id = ?`),
  setState: db.prepare(`UPDATE recommendations
    SET state = ?, updated_at = ?, snooze_until = ? WHERE id = ?`),
  get: db.prepare('SELECT * FROM recommendations WHERE id = ?'),
  open: db.prepare(`SELECT * FROM recommendations
    WHERE state = 'suggested' OR (state = 'snoozed' AND snooze_until <= ?)
    ORDER BY created_at DESC`),
  expire: db.prepare(`UPDATE recommendations SET state = 'expired', updated_at = ?
    WHERE state IN ('suggested','snoozed') AND created_at < ?`),
};

function rowPublic(row) {
  return { ...row, evidence: JSON.parse(row.evidence) };
}

// Create-or-refresh. Returns 'created' | 'refreshed' | 'suppressed'.
function upsert(rec, projectsRoot) {
  const title = String(rec.title || '').trim().slice(0, MAX_TITLE);
  if (!title || !rec.project || !rec.kind) return 'suppressed';

  // Durable suppression: anything the human has rejected stays rejected —
  // digit-insensitive, so "…7 files" can't dodge a rejection of "…6 files".
  const rejected = readRejectedTitles(projectsRoot, rec.project);
  const key = stableKey(title);
  for (const t of rejected) if (stableKey(t) === key) return 'suppressed';

  const existing = rec.kind === 'reconciliation'
    ? q.byMissionTitle.get(rec.project, rec.kind, title, rec.suggested_status || '')
    : q.byCondition.get(rec.project, rec.kind, rec.suggested_status || '');
  const now = new Date().toISOString();
  const evidence = JSON.stringify((rec.evidence || []).slice(0, MAX_EVIDENCE));

  if (existing) {
    if (existing.state === 'rejected') return 'suppressed';
    if (existing.state === 'suggested' || existing.state === 'snoozed') {
      q.refresh.run(title, evidence, rec.provenance || existing.provenance,
        rec.current_status || existing.current_status, now, existing.id);
      return 'refreshed';
    }
    // accepted/expired: allow a fresh record (the situation may have recurred)
  }
  q.insert.run(crypto.randomUUID(), rec.project, rec.kind, title,
    rec.current_status || null, rec.suggested_status || null, rec.source_file || null,
    evidence, rec.provenance || null, 'suggested', now, now, null);
  return 'created';
}

function listOpen() {
  const now = new Date().toISOString();
  q.expire.run(now, new Date(Date.now() - EXPIRE_DAYS * 864e5).toISOString());
  return q.open.all(now).map(rowPublic);
}

function get(id) {
  const row = q.get.get(String(id));
  return row ? rowPublic(row) : null;
}

function setState(id, state, { snoozeDays } = {}) {
  const snoozeUntil = state === 'snoozed'
    ? new Date(Date.now() + (snoozeDays || SNOOZE_DAYS) * 864e5).toISOString() : null;
  q.setState.run(state, new Date().toISOString(), snoozeUntil, String(id));
}

// ── Deterministic detectors — run after every scan ──────────────────────────
const DIRTY_THRESHOLD = 5;

function runDetectors(state, projectsRoot) {
  const counts = { created: 0, refreshed: 0, suppressed: 0 };
  for (const p of state.projects || []) {
    if (!p.is_git) continue;
    const candidates = [];

    if ((p.ahead || 0) > 0) {
      candidates.push({
        kind: 'unpushed',
        title: `Push ${p.ahead} unpushed commit${p.ahead > 1 ? 's' : ''} on ${p.branch}`,
        evidence: [`branch ${p.branch} is ${p.ahead} ahead of its remote`,
          'a disk failure would lose this work'],
      });
    }
    const mess = (p.dirty || 0) + (p.untracked || 0);
    if (mess >= DIRTY_THRESHOLD) {
      candidates.push({
        kind: 'dirty',
        title: `Commit or stash ${mess} uncommitted files`,
        evidence: [`${p.dirty || 0} modified + ${p.untracked || 0} untracked files in the working tree`],
      });
    }
    if (!fs.existsSync(path.join(projectsRoot, p.name, '.pakos', 'board.md'))) {
      candidates.push({
        kind: 'missing_board',
        title: 'Create a .pakos/board.md mission board',
        evidence: ['project has no mission board — its work is invisible to PakOS'],
      });
    }

    for (const c of candidates) {
      const result = upsert({ ...c, project: p.name, provenance: `detector:${c.kind}` }, projectsRoot);
      counts[result] = (counts[result] || 0) + 1;
    }
  }
  return counts;
}

// ── Reconciliation output parsing (LLM candidates, validated hard) ──────────
// The recon prompt asks the agent to END its output with:
//   ```json
//   {"misplaced":[{"title":"…","current":"…","suggested":"…","evidence":"…"}]}
//   ```
function parseReconOutput(text) {
  const blocks = [...String(text || '').matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (!blocks.length) return { error: 'no json block in agent output' };
  let parsed;
  try { parsed = JSON.parse(blocks[blocks.length - 1][1]); }
  catch { return { error: 'unparseable json block' }; }
  if (!Array.isArray(parsed?.misplaced)) return { error: 'json block missing "misplaced" array' };
  return { entries: parsed.misplaced.slice(0, 20) };
}

// Validate each LLM entry against the actual board before it may become a
// recommendation: the title must resolve to a real board task, the claimed
// current column must match reality, and the target must be a real status.
function applyReconResults(project, entries, tasks, { runId, projectsRoot }) {
  const created = [];
  const dropped = [];
  const boardTasks = tasks.filter((t) =>
    t.project === project && String(t.source_file || t.sourceFile || '').startsWith('.pakos/'));

  for (const e of entries || []) {
    const suggested = normalizeStatus(e.suggested);
    const claimed = normalizeStatus(e.current);
    const wanted = normalize(cleanTitle(splitOwner(String(e.title || '')).text));
    const task = boardTasks.find((t) => normalize(t.title) === wanted);

    if (!task) { dropped.push({ entry: e, why: 'no matching board mission' }); continue; }
    if (!suggested) { dropped.push({ entry: e, why: `bad suggested status: ${e.suggested}` }); continue; }
    if (claimed && claimed !== task.status) {
      dropped.push({ entry: e, why: `stale: board says ${task.status}, agent saw ${e.current}` });
      continue;
    }
    if (suggested === task.status) { dropped.push({ entry: e, why: 'already there' }); continue; }

    const result = upsert({
      project, kind: 'reconciliation', title: task.title,
      current_status: task.status, suggested_status: suggested,
      source_file: task.source_file || task.sourceFile,
      evidence: [String(e.evidence || 'agent-reported').slice(0, 300)],
      provenance: runId ? `run:${runId}` : 'recon',
    }, projectsRoot);
    if (result !== 'suppressed') created.push(task.title);
    else dropped.push({ entry: e, why: 'suppressed (previously rejected)' });
  }
  return { created, dropped };
}

// The fixed reconciliation prompt (proved out manually on a real project
// before being templated). Read-only by sandbox; the JSON contract at the
// end is what applyReconResults() validates.
function reconPrompt(project) {
  return [
    `You are auditing the "${project}" repository's mission board. Read`,
    `.pakos/board.md (and TODO.md / ROADMAP.md if present), then compare each`,
    `mission against actual repo evidence: recent commits, existing files and`,
    `code. Judge whether each mission's column (Backlog/Ready/In Progress/`,
    `Review/Done) matches reality. Modify nothing — this is a read-only audit.`,
    ``,
    `Report your findings briefly, then END your reply with exactly one fenced`,
    `json block of this shape (empty array if every column looks right):`,
    '```json',
    `{"misplaced":[{"title":"<board mission title>","current":"<its column>",` +
      `"suggested":"<column it should be in>","evidence":"<one line: commit hash or file path>"}]}`,
    '```',
  ].join('\n');
}

module.exports = {
  upsert, listOpen, get, setState, runDetectors,
  parseReconOutput, applyReconResults, reconPrompt, STATUS_LABELS,
};
