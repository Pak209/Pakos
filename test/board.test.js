'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createMission, moveMission, BoardError } = require('../lib/board');

function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pakos-board-'));
  fs.mkdirSync(path.join(dir, 'demo'));
  return dir;
}
const boardOf = (r) => path.join(r, 'demo', '.pakos', 'board.md');

test('createMission creates the board file and inserts under the right heading', () => {
  const r = root();
  createMission(r, { project: 'demo', title: 'First mission', status: 'ready' });
  const text = fs.readFileSync(boardOf(r), 'utf8');
  assert.match(text, /## Ready\n\n- \[ \] First mission/);

  createMission(r, { project: 'demo', title: 'Done thing', status: 'done' });
  assert.match(fs.readFileSync(boardOf(r), 'utf8'), /## Done\n\n- \[x\] Done thing/);
});

test('createMission sanitizes titles and rejects junk', () => {
  const r = root();
  const res = createMission(r, { project: 'demo', title: '  Fix\nthe\tthing  ', status: 'backlog' });
  assert.equal(res.title, 'Fix the thing');
  assert.throws(() => createMission(r, { project: 'demo', title: '\n\t ', status: 'backlog' }),
    (e) => e instanceof BoardError && e.code === 400);
  assert.throws(() => createMission(r, { project: 'demo', title: 'x', status: 'shipped' }),
    (e) => e.code === 400);
});

test('project names cannot traverse or hide', () => {
  const r = root();
  for (const bad of ['../demo', 'a/b', '.hidden', 'nope']) {
    assert.throws(() => createMission(r, { project: bad, title: 'x', status: 'ready' }),
      (e) => e instanceof BoardError && (e.code === 400 || e.code === 404), bad);
  }
});

test('moveMission moves a line between sections and verifies the caller view', () => {
  const r = root();
  fs.mkdirSync(path.join(r, 'demo', '.pakos'), { recursive: true });
  fs.writeFileSync(boardOf(r),
    '# Board\n\n## Ready\n\n- [ ] Ship it\n\n## Done\n');

  const res = moveMission(r, {
    project: 'demo', sourceFile: '.pakos/board.md', line: 5,
    title: 'Ship it', toStatus: 'in_progress',
  });
  assert.equal(res.status, 'in_progress');
  const text = fs.readFileSync(boardOf(r), 'utf8');
  assert.match(text, /## In Progress\n\n- \[ \] Ship it/);
  assert.doesNotMatch(text.split('## In Progress')[0], /Ship it/);

  // stale view — line content changed since scan
  assert.throws(() => moveMission(r, {
    project: 'demo', sourceFile: '.pakos/board.md', line: 5,
    title: 'Ship it', toStatus: 'done',
  }), (e) => e instanceof BoardError && e.code === 409);
});

test('moveMission refuses non-.pakos sources', () => {
  const r = root();
  for (const src of ['TODO.md', '../.pakos/board.md', '.pakos/../../etc.md', '.pakos/a/b.md']) {
    assert.throws(() => moveMission(r, {
      project: 'demo', sourceFile: src, line: 1, title: 'x', toStatus: 'done',
    }), (e) => e instanceof BoardError && e.code === 403, src);
  }
});

test('moveMission strips and preserves @owner tags (crew missions)', () => {
  const r = root();
  fs.mkdirSync(path.join(r, 'demo', '.pakos'), { recursive: true });
  fs.writeFileSync(boardOf(r), '# Board\n\n## Ready\n\n- [ ] Fix the scanner @codex\n\n## Done\n');

  // caller passes the stored (owner-stripped) title, line known
  const res = moveMission(r, {
    project: 'demo', sourceFile: '.pakos/board.md', line: 5,
    title: 'Fix the scanner', toStatus: 'in_progress',
  });
  assert.equal(res.owner, 'codex');
  const text = fs.readFileSync(boardOf(r), 'utf8');
  assert.match(text, /## In Progress\n\n- \[ \] Fix the scanner @codex/);
});

test('moveMission locates by title when line is omitted; ambiguity is 409', () => {
  const r = root();
  fs.mkdirSync(path.join(r, 'demo', '.pakos'), { recursive: true });
  fs.writeFileSync(boardOf(r), '# Board\n\n## In Progress\n\n- [ ] Ship v2 @codex\n\n## Done\n');

  const res = moveMission(r, {
    project: 'demo', sourceFile: '.pakos/board.md',
    title: 'Ship v2', toStatus: 'review',
  });
  assert.equal(res.status, 'review');
  assert.match(fs.readFileSync(boardOf(r), 'utf8'), /## Review\n\n- \[ \] Ship v2 @codex/);

  fs.appendFileSync(boardOf(r), '\n## Backlog\n\n- [ ] Ship v2\n- [ ] Ship v2 @claude\n');
  assert.throws(() => moveMission(r, {
    project: 'demo', sourceFile: '.pakos/board.md', title: 'Ship v2', toStatus: 'done',
  }), (e) => e.code === 409 && /ambiguous/.test(e.message));
});
