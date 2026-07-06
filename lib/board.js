'use strict';
// The ONLY module in PakOS that writes to a project. It edits exactly one
// file per project — .pakos/board.md — and nothing else, ever. Writes are
// atomic (temp file + rename) and verified against what the caller saw,
// so a stale UI can never clobber an edit made by hand or by an agent.
const fs = require('node:fs');
const path = require('node:path');
const { headingStatus, cleanTitle, splitOwner } = require('./tasks');

const STATUSES = ['backlog', 'ready', 'in_progress', 'review', 'done'];
const HEADINGS = {
  backlog: 'Backlog', ready: 'Ready', in_progress: 'In Progress',
  review: 'Review', done: 'Done',
};
const MAX_TITLE_LEN = 140;

class BoardError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function sanitizeTitle(raw) {
  const title = String(raw ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ') // strip control chars incl. newlines
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_LEN);
  if (!title) throw new BoardError(400, 'mission title is empty');
  return title;
}

function assertStatus(status) {
  if (!STATUSES.includes(status)) throw new BoardError(400, `invalid status: ${status}`);
}

// Resolve a project name to its directory, refusing anything that isn't a
// direct child of the projects root (no separators, no traversal).
function projectDir(root, name) {
  if (!name || name !== path.basename(name) || name.startsWith('.')) {
    throw new BoardError(400, 'invalid project name');
  }
  const dir = path.join(root, name);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new BoardError(404, `unknown project: ${name}`);
  }
  return dir;
}

function boardPath(root, project) {
  return path.join(projectDir(root, project), '.pakos', 'board.md');
}

function readBoard(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch { return '# Mission Board\n'; }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// Insert a mission line under the first heading matching `status`,
// appending a new "## <Status>" section if the board has none.
function insertUnderStatus(lines, status, missionLine) {
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^#{1,6}\s+(.+)/);
    if (h && headingStatus(h[1]) === status) { headingIdx = i; break; }
  }
  if (headingIdx === -1) {
    if (lines[lines.length - 1]?.trim() !== '') lines.push('');
    lines.push(`## ${HEADINGS[status]}`, '', missionLine);
    return lines;
  }
  // skip blank lines directly after the heading, insert at top of section
  let at = headingIdx + 1;
  while (at < lines.length && lines[at].trim() === '') at++;
  lines.splice(at, 0, missionLine);
  return lines;
}

function missionLineFor(status, title) {
  return `- [${status === 'done' ? 'x' : ' '}] ${title}`;
}

function createMission(root, { project, title, status }) {
  assertStatus(status);
  const clean = sanitizeTitle(title);
  const file = boardPath(root, project);
  const lines = readBoard(file).split('\n');
  insertUnderStatus(lines, status, missionLineFor(status, clean));
  writeAtomic(file, lines.join('\n'));
  return { project, title: clean, status };
}

// Move a mission line to another section. Titles are compared with any
// trailing @owner tag stripped (the parser strips it from stored tasks),
// and the tag is preserved on the rewritten line. `line` may be omitted:
// the mission is then located by title — used for the crew-finished →
// Review move, where the line number has changed since dispatch. Ambiguity
// (0 or 2+ title matches) is a 409, never a guess.
function moveMission(root, { project, sourceFile, line, title, toStatus }) {
  assertStatus(toStatus);
  if (typeof sourceFile !== 'string' || !/^\.pakos\/[^/]+\.md$/.test(sourceFile)) {
    throw new BoardError(403, 'only missions in .pakos/*.md can be moved');
  }
  const dir = projectDir(root, project);
  const file = path.join(dir, sourceFile);
  const lines = readBoard(file).split('\n');
  const wantTitle = cleanTitle(splitOwner(String(title ?? '')).text);

  const missionAt = (i) => {
    const m = lines[i]?.match(/^\s*[-*+]\s+(?:\[[ xX]\]\s+)?(.+)/);
    if (!m) return null;
    const { text, owner } = splitOwner(m[1]);
    return cleanTitle(text) === wantTitle ? { text: cleanTitle(text), owner } : null;
  };

  let idx;
  let hit;
  if (line != null) {
    idx = Number(line) - 1;
    hit = missionAt(idx);
    if (!hit) throw new BoardError(409, 'board changed since last scan — rescan and retry');
  } else {
    const matches = [];
    for (let i = 0; i < lines.length; i++) if (missionAt(i)) matches.push(i);
    if (matches.length !== 1) {
      throw new BoardError(409, matches.length
        ? 'mission title is ambiguous on the board' : 'mission not found on the board');
    }
    idx = matches[0];
    hit = missionAt(idx);
  }

  lines.splice(idx, 1);
  const ownerSuffix = hit.owner ? ` @${hit.owner}` : '';
  insertUnderStatus(lines, toStatus, missionLineFor(toStatus, hit.text) + ownerSuffix);
  writeAtomic(file, lines.join('\n'));
  return { project, title: hit.text, status: toStatus, owner: hit.owner || null };
}

module.exports = { createMission, moveMission, BoardError, STATUSES };
