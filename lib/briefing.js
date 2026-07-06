'use strict';
// The Briefing v1 (docs/INTELLIGENCE.md §8) — deterministic content only:
// every line computed from data PakOS already holds (scan snapshot, health,
// recommendations, crew runs, audit trail). No LLM in the loop; the seven
// morning questions get answered from signals, with evidence.
const fs = require('node:fs');
const path = require('node:path');

const DAY = 864e5;
const KIND_PRIORITY = { reconciliation: 0, unpushed: 1, dirty: 2, missing_board: 3 };

function since(hours, now) { return new Date(now - hours * 3600e3).toISOString(); }

// audit lines within the window, newest first (caller supplies parsed lines)
function recentAudit(auditLines, cutoffIso) {
  return auditLines.filter((l) => l.at >= cutoffIso);
}

function buildBriefing({ state, health, recommendations, runs, auditLines }, now = Date.now()) {
  const cutoff = since(24, now);

  // 1. what changed overnight
  const commits = (state.commits || []).filter((c) => c.at >= cutoff);
  const byProject = {};
  for (const c of commits) (byProject[c.project] ??= []).push(c.subject);
  const audit24 = recentAudit(auditLines || [], cutoff);
  const boardMoves = audit24.filter((l) => ['mission_move', 'mission_create', 'crew_board_move', 'rec_accept'].includes(l.action));
  const crewRuns = (runs || []).filter((r) => r.startedAt >= cutoff);
  const overnight = {
    commits: Object.entries(byProject).map(([project, subjects]) =>
      ({ project, count: subjects.length, latest: subjects[0] })),
    boardMoves: boardMoves.slice(0, 8).map((l) => l.detail),
    crewRuns: crewRuns.map((r) => `${r.agent} ${r.mode} on ${r.project}: ${r.mission} — ${r.status}`),
  };

  // 2. what deserves attention
  const attention = [];
  for (const [project, h] of Object.entries(health || {})) {
    for (const [dim, d] of Object.entries(h.dims)) {
      if (d.score < 50) attention.push({ project, line: `${dim} ${d.score}: ${d.reasons[0]}` });
    }
  }
  attention.sort((a, b) => a.line.localeCompare(b.line));

  // 3. what to work on today — top open recommendations, ranked
  const ranked = [...(recommendations || [])]
    .sort((a, b) => (KIND_PRIORITY[a.kind] ?? 9) - (KIND_PRIORITY[b.kind] ?? 9));
  const today = ranked.slice(0, 5).map((r) => ({
    project: r.project, title: r.title,
    action: r.suggested_status ? `move → ${r.suggested_status}` : 'new mission',
    why: r.evidence[0] || '',
  }));

  // 4. what can be delegated — owner-tagged missions sitting in Ready
  const delegate = (state.tasks || [])
    .filter((t) => t.owner && t.status === 'ready')
    .map((t) => ({ project: t.project, title: t.title, owner: t.owner }));

  // 5. which projects are drifting
  const drifting = Object.entries(health || {})
    .filter(([, h]) => h.dims.direction.score <= 40)
    .map(([project, h]) => ({ project, reason: h.dims.direction.reasons[0] }));

  // 6. opportunities — quick hygiene wins already captured as recommendations
  const opportunities = ranked.filter((r) => r.kind !== 'reconciliation').slice(0, 4)
    .map((r) => ({ project: r.project, title: r.title }));

  // 7. what executes next — nothing unattended exists yet, by design
  const next = 'AutoPilot not enabled — all execution is human-triggered (docs/AUTOPILOT.md).';

  return {
    generatedAt: new Date(now).toISOString(),
    overnight, attention, today, delegate, drifting, opportunities, next,
  };
}

// Persist a brief as markdown in PakOS's OWN repo (.pakos/briefs/) — the
// only write path here, and it is constant: no user input touches the path.
function saveBrief(briefing, pakosRepoDir) {
  const dir = path.join(pakosRepoDir, '.pakos', 'briefs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${briefing.generatedAt.slice(0, 10)}.md`);
  const md = [
    `# PakOS Briefing — ${briefing.generatedAt.slice(0, 16).replace('T', ' ')}`,
    '',
    '## Overnight',
    ...briefing.overnight.commits.map((c) => `- ${c.project}: ${c.count} commit(s) — latest: ${c.latest}`),
    ...briefing.overnight.crewRuns.map((r) => `- crew: ${r}`),
    ...briefing.overnight.boardMoves.map((m) => `- board: ${m}`),
    '',
    '## Attention',
    ...(briefing.attention.length ? briefing.attention.map((a) => `- ${a.project}: ${a.line}`) : ['- all clear']),
    '',
    '## Today',
    ...(briefing.today.length ? briefing.today.map((t) => `- [${t.project}] ${t.title} (${t.action}) — ${t.why}`) : ['- no open recommendations']),
    '',
    '## Delegate',
    ...(briefing.delegate.length ? briefing.delegate.map((d) => `- [${d.project}] ${d.title} @${d.owner}`) : ['- nothing tagged for crew']),
    '',
    '## Drifting',
    ...(briefing.drifting.length ? briefing.drifting.map((d) => `- ${d.project}: ${d.reason}`) : ['- none']),
    '',
    `## Next\n${briefing.next}`,
    '',
  ].join('\n');
  fs.writeFileSync(file, md);
  return file;
}

module.exports = { buildBriefing, saveBrief };
