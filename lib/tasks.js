'use strict';
// Markdown task parser. Reads ONLY these files per project (never .env or code):
//   TODO.md, ROADMAP.md, README.md, .pakos/*.md
//
// Rules:
//  - A heading containing a status word sets the status for list items under it:
//      backlog:     todo, backlog, planned, later, icebox, ideas
//      ready:       ready, next, up next, queued
//      in_progress: in progress, doing, wip, active, current, now
//      review:      review, testing, qa, verify
//      done:        done, complete(d), shipped, finished
//  - Checkbox state wins over the heading: "- [x]" is always done.
//  - In README.md, only sections whose heading matches a status/todo/roadmap
//    word are parsed (avoids turning docs bullets into fake tasks).
//  - Plain "- item" bullets (no checkbox) count only inside .pakos/*.md,
//    TODO.md and ROADMAP.md sections that have a recognized status heading.
const fs = require('node:fs');
const path = require('node:path');

const MAX_FILE_BYTES = 256 * 1024;
const MAX_TASKS_PER_PROJECT = 200;
const MAX_TITLE_LEN = 140;

const STATUS_PATTERNS = [
  ['in_progress', /\b(in[ -]?progress|doing|wip|active|current|now)\b/i],
  ['review', /\b(review|testing|qa|verify|verification)\b/i],
  ['ready', /\b(ready|next up|up next|next|queued)\b/i],
  ['done', /\b(done|completed?|shipped|finished)\b/i],
  ['backlog', /\b(todo|to[ -]do|backlog|planned|planning|later|icebox|ideas?|roadmap|tasks?)\b/i],
];

function headingStatus(text) {
  for (const [status, re] of STATUS_PATTERNS) if (re.test(text)) return status;
  return null;
}

function cleanTitle(raw) {
  return raw
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // markdown links -> text
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_LEN);
}

function parseFile(project, filePath, sourceLabel, { requireStatusHeading }) {
  let text;
  try {
    if (fs.statSync(filePath).size > MAX_FILE_BYTES) return [];
    text = fs.readFileSync(filePath, 'utf8');
  } catch { return []; }

  const tasks = [];
  let sectionStatus = null;
  let inFence = false;
  const defaultStatus = requireStatusHeading ? null : 'backlog';

  text.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;

    const heading = line.match(/^#{1,6}\s+(.+)/);
    if (heading) { sectionStatus = headingStatus(heading[1]); return; }

    const checkbox = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)/);
    const bullet = checkbox ? null : line.match(/^\s*[-*+]\s+(.+)/);
    const effectiveStatus = sectionStatus ?? defaultStatus;

    if (checkbox && effectiveStatus) {
      const done = checkbox[1].toLowerCase() === 'x';
      const title = cleanTitle(checkbox[2]);
      if (title) tasks.push({ project, title, status: done ? 'done' : effectiveStatus, sourceFile: sourceLabel, line: i + 1 });
    } else if (bullet && sectionStatus) {
      // plain bullets only count under an explicit status heading
      const title = cleanTitle(bullet[1]);
      if (title) tasks.push({ project, title, status: sectionStatus, sourceFile: sourceLabel, line: i + 1 });
    }
  });
  return tasks;
}

function parseProjectTasks(project, projectPath) {
  const tasks = [];

  for (const name of ['TODO.md', 'ROADMAP.md']) {
    tasks.push(...parseFile(project, path.join(projectPath, name), name,
      { requireStatusHeading: false }));
  }
  tasks.push(...parseFile(project, path.join(projectPath, 'README.md'), 'README.md',
    { requireStatusHeading: true }));

  const pakosDir = path.join(projectPath, '.pakos');
  try {
    for (const f of fs.readdirSync(pakosDir).sort()) {
      if (f.endsWith('.md')) {
        tasks.push(...parseFile(project, path.join(pakosDir, f), `.pakos/${f}`,
          { requireStatusHeading: false }));
      }
    }
  } catch { /* no .pakos dir */ }

  return tasks.slice(0, MAX_TASKS_PER_PROJECT);
}

module.exports = { parseProjectTasks, headingStatus, cleanTitle };
