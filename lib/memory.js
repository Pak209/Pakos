'use strict';
// Engineering memory, slice 1: rejected recommendations (docs/INTELLIGENCE.md §6).
// Truth lives as markdown in the project's .pakos/ — human-readable and
// human-editable; PakOS only ever appends. Rejections both document the
// decision and suppress the same suggestion from being re-raised.
const fs = require('node:fs');
const path = require('node:path');

const REJECTED_FILE = 'rejected.md';
const MAX_FILE_BYTES = 256 * 1024;
const HEADER = `# Rejected recommendations

Suggestions declined from PakOS, with reasons. Lines here suppress the
same suggestion from being re-raised. Delete a line to un-suppress it.
`;

function projectDir(root, name) {
  if (!name || name !== path.basename(name) || name.startsWith('.')) return null;
  const dir = path.join(root, name);
  try { return fs.statSync(dir).isDirectory() ? dir : null; } catch { return null; }
}

function rejectedPath(root, project) {
  const dir = projectDir(root, project);
  return dir ? path.join(dir, '.pakos', REJECTED_FILE) : null;
}

function normalize(title) {
  return String(title || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function appendRejected(root, project, { title, kind, reason, by }) {
  const file = rejectedPath(root, project);
  if (!file) throw new Error(`unknown project: ${project}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = `- ${new Date().toISOString().slice(0, 10)} · [${kind || 'suggestion'}] ` +
    `${String(title || '').replace(/[\r\n]+/g, ' ').trim()}` +
    (reason ? ` — ${String(reason).replace(/[\r\n]+/g, ' ').trim()}` : '') +
    (by ? ` (by ${by})` : '');
  const prefix = fs.existsSync(file) ? '' : HEADER + '\n';
  fs.appendFileSync(file, prefix + line + '\n');
  return line;
}

// Normalized titles of everything ever rejected in this project — used to
// suppress re-suggestions. Size-capped like every other parsed file.
function readRejectedTitles(root, project) {
  const file = rejectedPath(root, project);
  const titles = new Set();
  if (!file) return titles;
  let text;
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) return titles;
    text = fs.readFileSync(file, 'utf8');
  } catch { return titles; }
  for (const line of text.split('\n')) {
    const m = line.match(/^- \d{4}-\d{2}-\d{2} · \[[^\]]*\]\s+(.*?)(?:\s+—\s.*)?(?:\s+\(by [^)]*\))?\s*$/);
    if (m) titles.add(normalize(m[1]));
  }
  return titles;
}

module.exports = { appendRejected, readRejectedTitles, normalize };
