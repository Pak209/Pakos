'use strict';
// Read-only scanner for the projects root. Runs only whitelisted, argument-fixed
// git read commands via execFile (no shell). Never writes to a repository.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseProjectTasks } = require('./tasks');

const PROJECTS_ROOT = process.env.PAKOS_ROOT || path.join(os.homedir(), 'Projects');
const GIT_TIMEOUT_MS = 8000;
const MAX_COMMITS = 20;
const MAX_BRANCHES = 30;

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// Strip credentials (https://user:token@host/...) so tokens can never
// reach the database or the browser.
function sanitizeRemote(url) {
  if (!url) return null;
  return url.replace(/^(\w+:\/\/)[^@/]+@/, '$1');
}

function scanRepo(name, repoPath) {
  const project = {
    name,
    path: repoPath,
    isGit: fs.existsSync(path.join(repoPath, '.git')),
    branch: null, remoteUrl: null, ahead: null, behind: null,
    dirty: null, untracked: null, stashes: null, branchCount: null,
    lastCommit: null,
  };
  const commits = [];
  const branches = [];
  if (!project.isGit) return { project, commits, branches };

  try {
    project.branch = git(repoPath, ['branch', '--show-current']) || '(detached)';

    try {
      project.remoteUrl = sanitizeRemote(git(repoPath, ['remote', 'get-url', 'origin']));
    } catch { /* no remote */ }

    const status = git(repoPath, ['status', '--porcelain']);
    const lines = status ? status.split('\n') : [];
    project.untracked = lines.filter((l) => l.startsWith('??')).length;
    project.dirty = lines.length - project.untracked;

    try {
      const counts = git(repoPath, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
      const [behind, ahead] = counts.split(/\s+/).map(Number);
      project.ahead = ahead; project.behind = behind;
    } catch { /* no upstream */ }

    try {
      project.stashes = Number(git(repoPath, ['rev-list', '--walk-reflogs', '--count', 'refs/stash']));
    } catch { project.stashes = 0; }

    // %1f = unit separator (for-each-ref hex escape): safe against odd names.
    const refs = git(repoPath, ['for-each-ref', 'refs/heads', '--sort=-committerdate',
      '--format=%(refname:short)%1f%(objectname:short)%1f%(committerdate:iso-strict)']);
    const refLines = refs ? refs.split('\n').filter(Boolean) : [];
    project.branchCount = refLines.length;
    for (const line of refLines.slice(0, MAX_BRANCHES)) {
      const [branchName, hash, at] = line.split('\x1f');
      branches.push({ project: name, name: branchName, hash, at });
    }

    // %x1f = unit separator: safe against | or tabs inside subjects.
    const log = git(repoPath, ['log', `-${MAX_COMMITS}`, '--format=%h%x1f%s%x1f%an%x1f%cI']);
    for (const line of log.split('\n').filter(Boolean)) {
      const [hash, subject, author, at] = line.split('\x1f');
      commits.push({ project: name, hash, subject, author, at });
    }
    if (commits.length) {
      const c = commits[0];
      project.lastCommit = { hash: c.hash, subject: c.subject, author: c.author, at: c.at };
    }
  } catch (err) {
    project.error = String(err.message || err).slice(0, 200);
  }
  return { project, commits, branches };
}

function scan() {
  const started = Date.now();
  const projects = [];
  const commits = [];
  const branches = [];
  const tasks = [];

  const entries = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const repoPath = path.join(PROJECTS_ROOT, entry.name);
    const { project, commits: repoCommits, branches: repoBranches } =
      scanRepo(entry.name, repoPath);
    projects.push(project);
    commits.push(...repoCommits);
    branches.push(...repoBranches);
    tasks.push(...parseProjectTasks(entry.name, repoPath));
  }

  return {
    projects,
    commits,
    branches,
    tasks,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };
}

module.exports = { scan, PROJECTS_ROOT };
