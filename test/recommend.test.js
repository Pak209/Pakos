'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// isolate the DB before anything touches lib/db
process.env.PAKOS_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pakos-rec-db-')), 'test.sqlite3');

const { appendRejected, readRejectedTitles, normalize } = require('../lib/memory');
const recommend = require('../lib/recommend');

function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pakos-rec-'));
  fs.mkdirSync(path.join(dir, 'demo'));
  return dir;
}

test('memory: appendRejected creates file with header; titles read back normalized', () => {
  const r = root();
  appendRejected(r, 'demo', { title: 'Add   Redis Cache', kind: 'reconciliation', reason: 'overkill', by: 'x@y.z' });
  appendRejected(r, 'demo', { title: 'Second idea', kind: 'dirty' });
  const text = fs.readFileSync(path.join(r, 'demo', '.pakos', 'rejected.md'), 'utf8');
  assert.match(text, /^# Rejected recommendations/);
  assert.match(text, /\[reconciliation\] Add {3}Redis Cache — overkill \(by x@y\.z\)/);
  const titles = readRejectedTitles(r, 'demo');
  assert.ok(titles.has(normalize('add redis cache')));
  assert.ok(titles.has('second idea'));
});

test('upsert: created once, refreshed on repeat, suppressed after rejection', () => {
  const r = root();
  const rec = { project: 'demo', kind: 'unpushed', title: 'Push 3 unpushed commits on main',
    evidence: ['e1'], provenance: 'detector:unpushed' };
  assert.equal(recommend.upsert(rec, r), 'created');
  assert.equal(recommend.upsert({ ...rec, evidence: ['e2'] }, r), 'refreshed');
  const open = recommend.listOpen().filter((x) => x.project === 'demo');
  assert.equal(open.length, 1);
  assert.deepEqual(open[0].evidence, ['e2']);

  appendRejected(r, 'demo', { title: rec.title, kind: rec.kind });
  assert.equal(recommend.upsert(rec, r), 'suppressed');
});

test('lifecycle: snooze hides until due; accept allows a future recurrence', () => {
  const r = root();
  recommend.upsert({ project: 'demo', kind: 'dirty', title: 'Commit or stash 9 uncommitted files',
    evidence: [] }, r);
  const rec = recommend.listOpen().find((x) => x.kind === 'dirty' && x.project === 'demo');
  recommend.setState(rec.id, 'snoozed', { snoozeDays: 7 });
  assert.ok(!recommend.listOpen().some((x) => x.id === rec.id), 'snoozed is hidden');
  recommend.setState(rec.id, 'accepted');
  assert.equal(recommend.upsert({ project: 'demo', kind: 'dirty',
    title: 'Commit or stash 9 uncommitted files', evidence: [] }, r), 'created');
});

test('detectors fire on ahead/dirty/missing-board and stay quiet otherwise', () => {
  const r = root();
  fs.mkdirSync(path.join(r, 'detdemo'));
  fs.mkdirSync(path.join(r, 'clean', '.pakos'), { recursive: true });
  fs.writeFileSync(path.join(r, 'clean', '.pakos', 'board.md'), '# Board\n');
  const state = { projects: [
    { name: 'detdemo', is_git: 1, branch: 'main', ahead: 2, dirty: 4, untracked: 3 }, // unpushed + dirty(7) + missing board
    { name: 'clean', is_git: 1, branch: 'main', ahead: 0, dirty: 1, untracked: 0 },
    { name: 'notgit', is_git: 0 },
  ] };
  const first = recommend.runDetectors(state, r);
  assert.equal(first.created, 3);
  const again = recommend.runDetectors(state, r);
  assert.equal(again.created || 0, 0);
  assert.equal(again.refreshed, 3);
  const kinds = recommend.listOpen().filter((x) => x.project === 'detdemo').map((x) => x.kind).sort();
  assert.deepEqual(kinds, ['dirty', 'missing_board', 'unpushed']);
});

test('parseReconOutput: last json block wins; garbage rejected', () => {
  const good = 'prose\n```json\n{"misplaced":[]}\n```\nmore\n```json\n{"misplaced":[{"title":"T","current":"Backlog","suggested":"Done","evidence":"c0ffee"}]}\n```';
  assert.equal(recommend.parseReconOutput(good).entries.length, 1);
  assert.match(recommend.parseReconOutput('no blocks here').error, /no json block/);
  assert.match(recommend.parseReconOutput('```json\n{oops\n```').error, /unparseable/);
  assert.match(recommend.parseReconOutput('```json\n{"nope":1}\n```').error, /misplaced/);
});

test('applyReconResults validates hard: only real, mis-columned, allowed moves survive', () => {
  const r = root();
  const tasks = [
    { project: 'demo', title: 'Ship the thing', status: 'backlog', source_file: '.pakos/board.md', owner: 'codex' },
    { project: 'demo', title: 'Locked mission', status: 'ready', source_file: 'TODO.md' },
  ];
  const entries = [
    { title: 'Ship the thing @codex', current: 'Backlog', suggested: 'Done', evidence: 'commit abc123' }, // ok (owner tag stripped)
    { title: 'Ghost mission', current: 'Ready', suggested: 'Done', evidence: 'x' },        // no such task
    { title: 'Ship the thing', current: 'Ready', suggested: 'Done', evidence: 'x' },       // stale current
    { title: 'Ship the thing', current: 'Backlog', suggested: 'Shipped', evidence: 'x' },  // bad status
    { title: 'Locked mission', current: 'Ready', suggested: 'Done', evidence: 'x' },       // not a .pakos source
  ];
  const out = recommend.applyReconResults('demo', entries, tasks, { runId: 'run1', projectsRoot: r });
  assert.deepEqual(out.created, ['Ship the thing']);
  assert.equal(out.dropped.length, 4);
  const rec = recommend.listOpen().find((x) => x.kind === 'reconciliation' && x.project === 'demo');
  assert.equal(rec.suggested_status, 'done');
  assert.equal(rec.provenance, 'run:run1');
});

test('count drift cannot dodge snooze or rejection (condition-identity dedup)', () => {
  const r = root();
  fs.mkdirSync(path.join(r, 'drift'));
  assert.equal(recommend.upsert({ project: 'drift', kind: 'dirty',
    title: 'Commit or stash 6 uncommitted files', evidence: [] }, r), 'created');
  assert.equal(recommend.upsert({ project: 'drift', kind: 'dirty',
    title: 'Commit or stash 7 uncommitted files', evidence: [] }, r), 'refreshed');
  const open = recommend.listOpen().filter((x) => x.project === 'drift');
  assert.equal(open.length, 1);
  assert.match(open[0].title, /7 uncommitted/);

  recommend.setState(open[0].id, 'snoozed', {});
  assert.equal(recommend.upsert({ project: 'drift', kind: 'dirty',
    title: 'Commit or stash 8 uncommitted files', evidence: [] }, r), 'refreshed');
  assert.equal(recommend.listOpen().filter((x) => x.project === 'drift').length, 0);

  appendRejected(r, 'drift', { title: 'Commit or stash 8 uncommitted files', kind: 'dirty' });
  recommend.setState(open[0].id, 'expired');
  assert.equal(recommend.upsert({ project: 'drift', kind: 'dirty',
    title: 'Commit or stash 9 uncommitted files', evidence: [] }, r), 'suppressed');
});
