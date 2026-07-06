'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { codexUsage, claudeUsage } = require('../lib/usage');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pakos-usage-'));
}

test('codexUsage reads the newest rate_limits snapshot', () => {
  const home = tmpdir();
  const day = path.join(home, 'sessions', '2026', '07', '05');
  fs.mkdirSync(day, { recursive: true });

  const event = (usedPrimary, ts) => JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: usedPrimary, window_minutes: 300, resets_at: 1783316068 },
        secondary: { used_percent: 33, window_minutes: 10080, resets_at: 1783402263 },
        plan_type: 'plus',
      },
    },
  });

  // older file (must lose) + newer file with two snapshots (last one wins)
  fs.writeFileSync(path.join(day, 'rollout-a.jsonl'),
    ['{"type":"noise"}', event(99, '2026-07-05T01:00:00Z')].join('\n'));
  const newer = path.join(day, 'rollout-b.jsonl');
  fs.writeFileSync(newer,
    ['{"type":"noise"}', event(10, '2026-07-05T02:00:00Z'), 'not json {{{',
      event(42, '2026-07-05T03:00:00Z')].join('\n'));
  const future = Date.now() / 1000 + 60;
  fs.utimesSync(newer, future, future);

  const u = codexUsage(home);
  assert.equal(u.plan, 'plus');
  assert.equal(u.primary.usedPercent, 42);
  assert.equal(u.primary.windowMinutes, 300);
  assert.equal(u.secondary.usedPercent, 33);
  assert.ok(u.primary.resetsAt.startsWith('20'));
});

test('codexUsage returns null when there are no sessions', () => {
  assert.equal(codexUsage(tmpdir()), null);
});

test('claudeUsage buckets tokens into 5h and 7d windows and dedups by id', () => {
  const home = tmpdir();
  const proj = path.join(home, 'projects', '-Users-x-proj');
  fs.mkdirSync(proj, { recursive: true });
  const now = Date.parse('2026-07-05T12:00:00Z');

  const entry = (id, iso, input, output) => JSON.stringify({
    timestamp: iso,
    message: { id, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 7 } },
  });

  fs.writeFileSync(path.join(proj, 's.jsonl'), [
    entry('m1', '2026-07-05T11:00:00Z', 100, 10),  // inside 5h
    entry('m1', '2026-07-05T11:00:00Z', 100, 10),  // duplicate — ignored
    entry('m2', '2026-07-03T12:00:00Z', 1000, 50), // inside 7d only
    entry('m3', '2026-06-20T12:00:00Z', 5000, 5),  // too old — ignored
    'garbage line',
  ].join('\n'));

  const u = claudeUsage(home, now);
  assert.equal(u.estimate, true);
  assert.equal(u.windows.fiveHour.input, 100);
  assert.equal(u.windows.fiveHour.messages, 1);
  assert.equal(u.windows.week.input, 1100);
  assert.equal(u.windows.week.output, 60);
  assert.equal(u.windows.week.messages, 2);
});

test('claudeUsage returns null with no transcripts', () => {
  assert.equal(claudeUsage(tmpdir(), Date.now()), null);
});
