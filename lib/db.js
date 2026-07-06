'use strict';
// SQLite persistence via Node's built-in node:sqlite (Node >= 22). Zero npm deps.
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.PAKOS_DB || path.join(DATA_DIR, 'pakos.sqlite3');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

// The DB is a disposable cache, so "migration" = add-column-or-ignore.
try { db.exec('ALTER TABLE tasks ADD COLUMN owner TEXT'); } catch { /* fresh DB or already there */ }

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS projects (
    name          TEXT PRIMARY KEY,
    path          TEXT NOT NULL,
    is_git        INTEGER NOT NULL DEFAULT 0,
    branch        TEXT,
    remote_url    TEXT,
    ahead         INTEGER,
    behind        INTEGER,
    dirty         INTEGER,
    untracked     INTEGER,
    stashes       INTEGER,
    branch_count  INTEGER,
    last_commit_hash    TEXT,
    last_commit_subject TEXT,
    last_commit_author  TEXT,
    last_commit_at      TEXT,
    scanned_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project     TEXT NOT NULL,
    title       TEXT NOT NULL,
    owner       TEXT,            -- crew member from a trailing @tag, if any
    status      TEXT NOT NULL,   -- backlog | ready | in_progress | review | done
    source_file TEXT NOT NULL,
    line        INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS commits (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    project  TEXT NOT NULL,
    hash     TEXT NOT NULL,
    subject  TEXT NOT NULL,
    author   TEXT,
    at       TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS branches (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    project  TEXT NOT NULL,
    name     TEXT NOT NULL,
    hash     TEXT NOT NULL,
    at       TEXT
  );

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  -- Scan history survives rescans: the substrate for health trends and
  -- sparklines (docs/INTELLIGENCE.md §4). Pruned after 90 days.
  CREATE TABLE IF NOT EXISTS scan_history (
    at          TEXT NOT NULL,
    project     TEXT NOT NULL,
    dirty       INTEGER, untracked INTEGER, ahead INTEGER, behind INTEGER,
    last_commit_at TEXT,
    backlog     INTEGER, ready INTEGER, in_progress INTEGER, review INTEGER, done INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_history_project_at ON scan_history (project, at);

  -- Recommendations survive rescans (unlike the snapshot tables above):
  -- open ones are regenerable by re-running detectors/reconciliation, and
  -- durable decisions (rejections) also live in .pakos/rejected.md, so the
  -- DB remains a disposable cache.
  CREATE TABLE IF NOT EXISTS recommendations (
    id               TEXT PRIMARY KEY,
    project          TEXT NOT NULL,
    kind             TEXT NOT NULL,  -- reconciliation | unpushed | dirty | missing_board
    title            TEXT NOT NULL,
    current_status   TEXT,
    suggested_status TEXT,
    source_file      TEXT,
    evidence         TEXT NOT NULL,  -- JSON array of strings
    provenance       TEXT,
    state            TEXT NOT NULL,  -- suggested | accepted | rejected | snoozed | expired
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    snooze_until     TEXT
  );
`);

function replaceScan({ projects, tasks, commits, branches = [], scannedAt, durationMs }) {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM projects; DELETE FROM tasks; DELETE FROM commits; DELETE FROM branches;');
    const insProject = db.prepare(`INSERT INTO projects
      (name, path, is_git, branch, remote_url, ahead, behind, dirty, untracked, stashes,
       branch_count, last_commit_hash, last_commit_subject, last_commit_author, last_commit_at, scanned_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insTask = db.prepare(
      'INSERT INTO tasks (project, title, owner, status, source_file, line) VALUES (?,?,?,?,?,?)');
    const insCommit = db.prepare(
      'INSERT INTO commits (project, hash, subject, author, at) VALUES (?,?,?,?,?)');
    const insBranch = db.prepare(
      'INSERT INTO branches (project, name, hash, at) VALUES (?,?,?,?)');

    for (const p of projects) {
      insProject.run(p.name, p.path, p.isGit ? 1 : 0, p.branch, p.remoteUrl,
        p.ahead, p.behind, p.dirty, p.untracked, p.stashes, p.branchCount,
        p.lastCommit?.hash ?? null, p.lastCommit?.subject ?? null,
        p.lastCommit?.author ?? null, p.lastCommit?.at ?? null, scannedAt);
    }
    for (const t of tasks) insTask.run(t.project, t.title, t.owner ?? null, t.status, t.sourceFile, t.line);
    for (const c of commits) insCommit.run(c.project, c.hash, c.subject, c.author, c.at);
    for (const b of branches) insBranch.run(b.project, b.name, b.hash, b.at ?? null);

    // history: one row per project per scan (trend substrate, pruned at 90d)
    const insHistory = db.prepare(`INSERT INTO scan_history
      (at, project, dirty, untracked, ahead, behind, last_commit_at,
       backlog, ready, in_progress, review, done) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    const taskCounts = {};
    for (const t of tasks) {
      const c = (taskCounts[t.project] ??= { backlog: 0, ready: 0, in_progress: 0, review: 0, done: 0 });
      if (t.status in c) c[t.status] += 1;
    }
    for (const p of projects) {
      const c = taskCounts[p.name] || {};
      insHistory.run(scannedAt, p.name, p.dirty ?? null, p.untracked ?? null,
        p.ahead ?? null, p.behind ?? null, p.lastCommit?.at ?? null,
        c.backlog ?? 0, c.ready ?? 0, c.in_progress ?? 0, c.review ?? 0, c.done ?? 0);
    }
    db.prepare('DELETE FROM scan_history WHERE at < ?')
      .run(new Date(Date.now() - 90 * 864e5).toISOString());

    const setMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)');
    setMeta.run('last_scan_at', scannedAt);
    setMeta.run('last_scan_duration_ms', String(durationMs));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getState() {
  const projects = db.prepare('SELECT * FROM projects ORDER BY last_commit_at DESC NULLS LAST').all();
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY project, id').all();
  const commits = db.prepare('SELECT * FROM commits ORDER BY at DESC LIMIT 30').all();
  const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all()
    .map((r) => [r.key, r.value]));
  return { projects, tasks, commits, meta };
}

// Recent history rows for one project, oldest first (trend/sparkline data).
function getHistory(project, limit = 60) {
  return db.prepare(`SELECT * FROM (
      SELECT * FROM scan_history WHERE project = ? ORDER BY at DESC LIMIT ?
    ) ORDER BY at ASC`).all(project, limit);
}

// Everything the per-project detail view needs, in one shot.
function getProject(name) {
  const project = db.prepare('SELECT * FROM projects WHERE name = ?').get(name);
  if (!project) return null;
  const branches = db.prepare(
    'SELECT name, hash, at FROM branches WHERE project = ? ORDER BY at DESC NULLS LAST').all(name);
  const commits = db.prepare(
    'SELECT hash, subject, author, at FROM commits WHERE project = ? ORDER BY at DESC').all(name);
  const tasks = db.prepare(
    'SELECT * FROM tasks WHERE project = ? ORDER BY id').all(name);
  return { project, branches, commits, tasks };
}

module.exports = { db, replaceScan, getState, getProject, getHistory, DB_PATH };
