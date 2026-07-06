'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { parseProjectTasks } = require('../lib/tasks');

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pakos-tasks-'));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

test('trailing @tag becomes the owner and is stripped from the title', () => {
  const dir = project({
    'TODO.md': [
      '## In Progress',
      '- [ ] Fix the scanner @codex',
      '- [ ] Ship the tunnel @claude',
      '- [ ] Plain mission with no owner',
    ].join('\n'),
  });
  const tasks = parseProjectTasks('p', dir);
  assert.deepEqual(tasks.map((t) => [t.title, t.owner]), [
    ['Fix the scanner', 'codex'],
    ['Ship the tunnel', 'claude'],
    ['Plain mission with no owner', null],
  ]);
});

test('emails and mid-line mentions are not owners', () => {
  const dir = project({
    'TODO.md': [
      '## Ready',
      '- [ ] Email dankimoto8@gmail.com about the launch',
      '- [ ] Ask @codex to look, then report back',
    ].join('\n'),
  });
  const tasks = parseProjectTasks('p', dir);
  assert.equal(tasks[0].owner, null);
  assert.ok(tasks[0].title.includes('dankimoto8@gmail.com'));
  assert.equal(tasks[1].owner, null);
});

test('checkbox state still wins and statuses map as before (v0.1 compat)', () => {
  const dir = project({
    '.pakos/board.md': ['## Done', '- [ ] Not actually done @codex', '- [x] Done thing'].join('\n'),
  });
  const tasks = parseProjectTasks('p', dir);
  assert.equal(tasks[0].status, 'done'); // heading says done
  assert.equal(tasks[0].owner, 'codex');
  assert.equal(tasks[1].status, 'done');
});
