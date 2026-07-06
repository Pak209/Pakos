'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.PAKOS_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pakos-health-db-')), 't.sqlite3');

const { db, replaceScan, getHistory } = require('../lib/db');
const { computeHealth } = require('../lib/health');

const NOW = Date.parse('2026-07-06T12:00:00Z');
const iso = (daysBack) => new Date(NOW - daysBack * 864e5).toISOString();

function seedCommits(project, days) {
  const ins = db.prepare('INSERT INTO commits (project, hash, subject, author, at) VALUES (?,?,?,?,?)');
  days.forEach((d, i) => ins.run(project, `h${i}`, 's', 'a', iso(d)));
}

function root(withBoard, boardAgeDays = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pakos-health-'));
  fs.mkdirSync(path.join(dir, 'p', '.pakos'), { recursive: true });
  if (withBoard) {
    const f = path.join(dir, 'p', '.pakos', 'board.md');
    fs.writeFileSync(f, '# Board\n');
    const t = (NOW - boardAgeDays * 864e5) / 1000;
    fs.utimesSync(f, t, t);
  }
  return dir;
}

test('a thriving project grades A with clean reasons', () => {
  seedCommits('p', [0.5, 1, 2, 3, 5]);
  const p = { name: 'p', is_git: 1, dirty: 0, untracked: 0, stashes: 0, ahead: 0,
    remote_url: 'https://x', last_commit_at: iso(0.5) };
  const h = computeHealth(p, [{ project: 'p', status: 'done' }], root(true, 1), {}, NOW);
  assert.equal(h.grade, 'A');
  assert.match(h.dims.hygiene.reasons[0], /clean/);
  assert.match(h.dims.recovery.reasons[0], /pushed and committed/);
  assert.equal(h.dims.direction.score, 100);
  db.prepare("DELETE FROM commits WHERE project = 'p'").run();
});

test('a rotting project grades poorly and says why', () => {
  seedCommits('rot', [45, 60]);
  const p = { name: 'rot', is_git: 1, dirty: 8, untracked: 10, stashes: 3, ahead: 4,
    remote_url: null, last_commit_at: iso(45) };
  const tasks = Array.from({ length: 12 }, () => ({ project: 'rot', status: 'backlog' }));
  const h = computeHealth(p, tasks, root(true, 50), {}, NOW);
  assert.ok(h.score < 45, `expected <45, got ${h.score}`);
  assert.ok(['D', 'F'].includes(h.grade));
  assert.match(h.dims.recovery.reasons.join(' '), /no remote/);
  assert.match(h.dims.recovery.reasons.join(' '), /4 commits not pushed/);
  assert.match(h.dims.debt.reasons.join(' '), /12 missions in Backlog/);
  db.prepare("DELETE FROM commits WHERE project = 'rot'").run();
});

test('drift: fresh code + stale board tanks direction with an explicit reason', () => {
  seedCommits('drift', [1]);
  const p = { name: 'drift', is_git: 1, dirty: 0, untracked: 0, ahead: 0,
    remote_url: 'https://x', last_commit_at: iso(1) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pakos-health-'));
  fs.mkdirSync(path.join(dir, 'drift', '.pakos'), { recursive: true });
  const f = path.join(dir, 'drift', '.pakos', 'board.md');
  fs.writeFileSync(f, '# Board\n');
  const t = (NOW - 30 * 864e5) / 1000;
  fs.utimesSync(f, t, t);
  const h = computeHealth(p, [], dir, {}, NOW);
  assert.equal(h.dims.direction.score, 40);
  assert.match(h.dims.direction.reasons[0], /drift/);
  db.prepare("DELETE FROM commits WHERE project = 'drift'").run();
});

test('non-git folders are not judged', () => {
  assert.equal(computeHealth({ name: 'x', is_git: 0 }, [], root(false), {}, NOW), null);
});

test('weights shift the composite', () => {
  seedCommits('w', [40]);
  const p = { name: 'w', is_git: 1, dirty: 0, untracked: 0, ahead: 0,
    remote_url: 'https://x', last_commit_at: iso(40) };
  const r = root(true, 41);
  const balanced = computeHealth(p, [], r, {}, NOW);
  const momentumOnly = computeHealth(p, [], r,
    { momentum: 1, hygiene: 0, recovery: 0, debt: 0, direction: 0 }, NOW);
  assert.ok(momentumOnly.score < balanced.score, 'momentum-only should be worse for a stale repo');
  db.prepare("DELETE FROM commits WHERE project = 'w'").run();
});

test('scan_history: rows written per scan, retrievable oldest-first', () => {
  const snap = (at) => ({
    projects: [{ name: 'hist', path: '/x', isGit: true, branch: 'main', remoteUrl: null,
      dirty: 1, untracked: 2, ahead: 0, behind: 0, stashes: 0, branchCount: 1,
      lastCommit: { hash: 'h', subject: 's', author: 'a', at } }],
    tasks: [{ project: 'hist', title: 't', status: 'ready', sourceFile: '.pakos/board.md', line: 1 }],
    commits: [], branches: [], scannedAt: at, durationMs: 1,
  });
  replaceScan(snap(iso(2)));
  replaceScan(snap(iso(1)));
  const rows = getHistory('hist');
  assert.equal(rows.length, 2);
  assert.ok(rows[0].at < rows[1].at, 'oldest first');
  assert.equal(rows[1].ready, 1);
  assert.equal(rows[1].untracked, 2);
});
