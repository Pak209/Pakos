'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { buildBriefing, saveBrief } = require('../lib/briefing');

const NOW = Date.parse('2026-07-06T09:00:00Z');
const iso = (hoursBack) => new Date(NOW - hoursBack * 3600e3).toISOString();

const FIXTURE = {
  state: {
    commits: [
      { project: 'alpha', subject: 'fix the flux capacitor', at: iso(3) },
      { project: 'alpha', subject: 'older work', at: iso(30) },
      { project: 'beta', subject: 'ship it', at: iso(10) },
    ],
    tasks: [
      { project: 'alpha', title: 'Delegable thing', owner: 'codex', status: 'ready' },
      { project: 'alpha', title: 'Not ready', owner: 'codex', status: 'backlog' },
      { project: 'beta', title: 'Human thing', owner: null, status: 'ready' },
    ],
  },
  health: {
    alpha: { dims: { momentum: { score: 90, reasons: ['x'] }, hygiene: { score: 45, reasons: ['9 modified files uncommitted'] },
      recovery: { score: 80, reasons: ['x'] }, debt: { score: 70, reasons: ['x'] }, direction: { score: 40, reasons: ['code moving, board stale — drift'] } } },
    beta: { dims: { momentum: { score: 80, reasons: ['x'] }, hygiene: { score: 90, reasons: ['x'] },
      recovery: { score: 90, reasons: ['x'] }, debt: { score: 90, reasons: ['x'] }, direction: { score: 100, reasons: ['x'] } } },
  },
  recommendations: [
    { project: 'alpha', kind: 'unpushed', title: 'Push 2 unpushed commits', evidence: ['branch main ahead 2'], suggested_status: null },
    { project: 'beta', kind: 'reconciliation', title: 'Ship it mission', evidence: ['commit abc'], current_status: 'ready', suggested_status: 'done' },
  ],
  runs: [{ project: 'alpha', agent: 'codex', mode: 'analyze', mission: 'audit', status: 'complete', startedAt: iso(5) }],
  auditLines: [
    { at: iso(2), action: 'mission_move', detail: 'alpha: Thing → done', who: 'x@y.z' },
    { at: iso(40), action: 'mission_move', detail: 'too old', who: 'x@y.z' },
  ],
};

test('buildBriefing answers the seven questions from fixtures', () => {
  const b = buildBriefing(FIXTURE, NOW);
  assert.deepEqual(b.overnight.commits.map((c) => [c.project, c.count]), [['alpha', 1], ['beta', 1]]);
  assert.equal(b.overnight.boardMoves.length, 1, 'old audit lines excluded');
  assert.equal(b.overnight.crewRuns.length, 1);
  assert.ok(b.attention.some((a) => a.project === 'alpha' && /hygiene 45/.test(a.line)));
  assert.ok(!b.attention.some((a) => a.project === 'beta'), 'healthy dims stay quiet');
  assert.equal(b.today[0].title, 'Ship it mission', 'reconciliation ranks first');
  assert.match(b.today[0].action, /done/);
  assert.deepEqual(b.delegate, [{ project: 'alpha', title: 'Delegable thing', owner: 'codex' }]);
  assert.deepEqual(b.drifting.map((d) => d.project), ['alpha']);
  assert.ok(b.opportunities.every((o) => o.title !== 'Ship it mission'), 'recon is not an opportunity');
  assert.match(b.next, /AutoPilot not enabled/);
});

test('saveBrief writes exactly one dated file inside .pakos/briefs', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pakos-brief-'));
  const b = buildBriefing(FIXTURE, NOW);
  const file = saveBrief(b, repo);
  assert.equal(file, path.join(repo, '.pakos', 'briefs', '2026-07-06.md'));
  const md = fs.readFileSync(file, 'utf8');
  assert.match(md, /^# PakOS Briefing — 2026-07-06/);
  assert.match(md, /## Attention\n(- alpha: .*\n)*- alpha: hygiene 45/);
  assert.match(md, /## Delegate\n- \[alpha\] Delegable thing @codex/);
  assert.equal(fs.readdirSync(path.join(repo, '.pakos', 'briefs')).length, 1);
});
