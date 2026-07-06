'use strict';
// Portfolio Health v2 (docs/INTELLIGENCE.md §4): five local-computable
// dimensions, each 0–100 with human-readable reasons — every number
// traceable to raw signals, no vibes-percentages. The sixth dimension
// (Quality: CI/tests) is deliberately deferred until the GitHub/CI
// sensors land in v0.3.
//
// All math is deterministic and cheap; it runs on the scan snapshot plus
// per-project commit timestamps and the board file's mtime. Weights are
// user-tunable via ~/.pakos/config.json → health.weights.
const fs = require('node:fs');
const path = require('node:path');

const { db } = require('./db');

const DAY = 864e5;
const DEFAULT_WEIGHTS = { momentum: 0.25, hygiene: 0.2, recovery: 0.2, debt: 0.15, direction: 0.2 };

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
const daysAgo = (iso, now) => iso ? (now - Date.parse(iso)) / DAY : Infinity;

const qCommits = () => db.prepare('SELECT at FROM commits WHERE project = ? ORDER BY at DESC');

function momentum(p, now) {
  const commits = qCommits().all(p.name);
  if (!commits.length) return { score: 20, reasons: ['no commits recorded'] };
  const last = daysAgo(commits[0].at, now);
  const recent14 = commits.filter((c) => daysAgo(c.at, now) <= 14).length;
  const base = last <= 1 ? 100 : Math.max(0, 100 - (last - 1) * 8);
  const score = clamp(Math.min(100, base + Math.min(20, recent14 * 2)));
  return {
    score,
    reasons: [
      `last commit ${last < 1 ? 'today' : Math.round(last) + 'd ago'}`,
      `${recent14} commit${recent14 === 1 ? '' : 's'} in the last 14 days`,
    ],
  };
}

function hygiene(p) {
  const reasons = [];
  let score = 100;
  if (p.dirty) { score -= Math.min(40, p.dirty * 6); reasons.push(`${p.dirty} modified file${p.dirty === 1 ? '' : 's'} uncommitted`); }
  if (p.untracked) { score -= Math.min(30, p.untracked * 3); reasons.push(`${p.untracked} untracked file${p.untracked === 1 ? '' : 's'}`); }
  if (p.stashes) { score -= Math.min(15, p.stashes * 5); reasons.push(`${p.stashes} stash${p.stashes === 1 ? '' : 'es'} piling up`); }
  if (!reasons.length) reasons.push('working tree clean');
  return { score: clamp(score), reasons };
}

function recovery(p) {
  const reasons = [];
  let score = 100;
  if (!p.remote_url) { score -= 35; reasons.push('no remote — a disk failure loses everything'); }
  if (p.ahead) { score -= Math.min(45, p.ahead * 12); reasons.push(`${p.ahead} commit${p.ahead === 1 ? '' : 's'} not pushed anywhere`); }
  const mess = (p.dirty || 0) + (p.untracked || 0);
  if (mess) { score -= Math.min(25, mess * 3); reasons.push(`${mess} file${mess === 1 ? '' : 's'} exist only in the working tree`); }
  if (!reasons.length) reasons.push('everything is pushed and committed');
  return { score: clamp(score), reasons };
}

function debt(p, tasks) {
  const mine = tasks.filter((t) => t.project === p.name);
  if (!mine.length) return { score: 70, reasons: ['no missions tracked — debt invisible'] };
  const reasons = [];
  let score = 100;
  const backlog = mine.filter((t) => t.status === 'backlog').length;
  const review = mine.filter((t) => t.status === 'review').length;
  if (backlog > 5) { score -= Math.min(40, (backlog - 5) * 4); reasons.push(`${backlog} missions in Backlog`); }
  if (review > 2) { score -= Math.min(20, (review - 2) * 5); reasons.push(`${review} missions waiting in Review`); }
  const done = mine.filter((t) => t.status === 'done').length;
  reasons.push(`${done}/${mine.length} missions done`);
  return { score: clamp(score), reasons };
}

function direction(p, projectsRoot, now) {
  const boardPath = path.join(projectsRoot, p.name, '.pakos', 'board.md');
  let boardDays = Infinity;
  try { boardDays = (now - fs.statSync(boardPath).mtimeMs) / DAY; } catch { /* no board */ }
  const codeDays = daysAgo(p.last_commit_at, now);

  if (boardDays === Infinity) return { score: 50, reasons: ['no mission board — direction untracked'] };
  if (codeDays <= 7 && boardDays > 21) {
    return { score: 40, reasons: [`code moved ${Math.round(codeDays)}d ago but the board hasn't been touched in ${Math.round(boardDays)}d — drift`] };
  }
  if (codeDays <= 7 && boardDays <= 21) {
    return { score: 100, reasons: ['code and board both active'] };
  }
  if (codeDays > 30 && boardDays > 30) {
    return { score: 70, reasons: ['project dormant (code and board both quiet)'] };
  }
  return { score: 85, reasons: ['board fresher than code — planning ahead of work'] };
}

// -> { score, grade, dims: {momentum, hygiene, recovery, debt, direction} }
function computeHealth(p, tasks, projectsRoot, weights = {}, now = Date.now()) {
  if (!p.is_git) return null; // non-git folders don't get judged
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const dims = {
    momentum: momentum(p, now),
    hygiene: hygiene(p),
    recovery: recovery(p),
    debt: debt(p, tasks),
    direction: direction(p, projectsRoot, now),
  };
  const total = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  const score = clamp(Object.entries(dims)
    .reduce((sum, [k, d]) => sum + d.score * (w[k] ?? 0), 0) / total);
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F';
  return { score, grade, dims };
}

function computeAll(state, projectsRoot, weights, now = Date.now()) {
  const out = {};
  for (const p of state.projects || []) {
    const h = computeHealth(p, state.tasks || [], projectsRoot, weights, now);
    if (h) out[p.name] = h;
  }
  return out;
}

module.exports = { computeHealth, computeAll, DEFAULT_WEIGHTS };
