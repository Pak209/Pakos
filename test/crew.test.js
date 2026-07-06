'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { previewDispatch, confirmDispatch, getRun, cancelRun } = require('../lib/crew');

const CONFIG = {
  crew: { defaultAgent: 'codex', models: { codex: ['gpt-5.5'], claude: ['opus', 'sonnet', 'haiku'] } },
};

function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pakos-crew-'));
  fs.mkdirSync(path.join(dir, 'demo'));
  return dir;
}

test('preview validates agent, mode, model allowlist, and mission', () => {
  const r = root();
  assert.match(previewDispatch({ project: 'demo', mission: 'x', agent: 'cursor' }, CONFIG, r).error, /agent/);
  assert.match(previewDispatch({ project: 'demo', mission: 'x', mode: 'yolo' }, CONFIG, r).error, /mode/);
  assert.match(previewDispatch({ project: 'demo', mission: 'x', model: 'gpt-9000' }, CONFIG, r).error, /model/);
  assert.match(previewDispatch({ project: 'demo', mission: '' }, CONFIG, r).error, /mission/);
});

test('preview rejects traversal and unknown projects', () => {
  const r = root();
  for (const bad of ['../demo', 'demo/../../etc', '.hidden', 'nope', '/etc']) {
    assert.match(previewDispatch({ project: bad, mission: 'x' }, CONFIG, r).error, /project/i);
  }
});

test('preview defaults to codex read-only, spawns nothing, writes nothing', () => {
  const r = root();
  const p = previewDispatch({ project: 'demo', mission: 'Look at the tests' }, CONFIG, r);
  assert.equal(p.agent, 'codex');
  assert.equal(p.mode, 'analyze');
  assert.deepEqual(p.argv.slice(0, 4), ['codex', 'exec', '--sandbox', 'read-only']);
  assert.equal(p.handoffFile, '.pakos/handoff-look-at-the-tests.md');
  assert.ok(p.dispatchId);
  // nothing written until confirm
  assert.ok(!fs.existsSync(path.join(r, 'demo', '.pakos')));
});

test('implement mode maps to workspace-write / acceptEdits', () => {
  const r = root();
  const codex = previewDispatch({ project: 'demo', mission: 'x', mode: 'implement' }, CONFIG, r);
  assert.ok(codex.argv.includes('workspace-write'));
  const claude = previewDispatch({ project: 'demo', mission: 'x', mode: 'implement', agent: 'claude', model: 'sonnet' }, CONFIG, r);
  assert.deepEqual(claude.argv.slice(0, 1), ['claude']);
  assert.ok(claude.argv.includes('acceptEdits'));
});

test('confirm requires a known, unexpired dispatchId (single use)', () => {
  assert.equal(confirmDispatch('not-a-real-id', {}).code, 404);
});

test('confirm writes the handoff and starts a run; cancel stops it', () => {
  const r = root();
  const p = previewDispatch({ project: 'demo', mission: 'sleep test' }, CONFIG, r);
  const { run } = confirmDispatch(p.dispatchId, {});
  assert.ok(run.id);
  const handoff = path.join(r, 'demo', '.pakos', 'handoff-sleep-test.md');
  assert.ok(fs.existsSync(handoff));
  assert.match(fs.readFileSync(handoff, 'utf8'), /## Mission\n\nsleep test/);
  // dispatchId is single-use
  assert.equal(confirmDispatch(p.dispatchId, {}).code, 404);
  // cancel (run may have already errored if codex isn't on PATH — both fine)
  const c = cancelRun(run.id);
  if (!c.error) assert.equal(c.run.status, 'cancelled');
  assert.ok(getRun(run.id));
  assert.equal(cancelRun('nope').code, 404);
});

test('missionRef is validated at preview', () => {
  const r = root();
  for (const bad of [
    { sourceFile: 'TODO.md', line: 1, title: 'x' },
    { sourceFile: '.pakos/board.md', line: 'one', title: 'x' },
    { sourceFile: '.pakos/board.md', line: 1, title: '  ' },
  ]) {
    assert.match(previewDispatch({ project: 'demo', mission: 'x', missionRef: bad }, CONFIG, r).error,
      /missionRef/, JSON.stringify(bad));
  }
});

test('confirm with a board-bound mission moves it to In Progress first; stale board aborts', () => {
  const r = root();
  const boardFile = path.join(r, 'demo', '.pakos', 'board.md');
  fs.mkdirSync(path.dirname(boardFile), { recursive: true });
  fs.writeFileSync(boardFile, '# Board\n\n## Ready\n\n- [ ] Board-bound mission @codex\n\n## Done\n');

  const p = previewDispatch({ project: 'demo', mission: 'Board-bound mission',
    missionRef: { sourceFile: '.pakos/board.md', line: 5, title: 'Board-bound mission' } }, CONFIG, r);
  assert.match(p.boardMove, /In Progress/);

  const events = [];
  const { run, error } = confirmDispatch(p.dispatchId, {
    onEvent: (event, info, detail) => events.push([event, detail]),
  });
  assert.equal(error, undefined);
  assert.match(fs.readFileSync(boardFile, 'utf8'), /## In Progress\n\n- \[ \] Board-bound mission @codex/);
  assert.ok(events.some(([e, d]) => e === 'crew_board_move' && /in_progress/.test(d)));
  cancelRun(run.id);

  // stale ref: line no longer matches → dispatch must abort before any spawn
  const p2 = previewDispatch({ project: 'demo', mission: 'Board-bound mission',
    missionRef: { sourceFile: '.pakos/board.md', line: 5, title: 'Board-bound mission' } }, CONFIG, r);
  const result = confirmDispatch(p2.dispatchId, {});
  assert.equal(result.code, 409);
  assert.match(result.error, /board move failed/);
  assert.ok(!fs.existsSync(path.join(r, 'demo', '.pakos', p2.handoffFile.replace('.pakos/', ''))) ||
    p.handoffFile !== p2.handoffFile, 'no second handoff for the aborted dispatch');
});
