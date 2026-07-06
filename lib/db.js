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

module.exports = { db, replaceScan, getState, getProject, DB_PATH };
