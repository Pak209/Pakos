'use strict';
// Crew dispatch — run an agent CLI (codex | claude) against one project's
// mission. Human-triggered only: there is no scheduler and no auto-pickup
// of @owner missions; every run starts from an explicit two-step approval
// (preview → confirm) in the UI, both steps auth-gated.
//
// Write boundaries (docs/SECURITY.md):
//  - PakOS itself writes exactly one file outside its own repo: the
//    handoff `.pakos/handoff-<slug>.md` inside the target project, plus
//    a result section appended there when the run ends.
//  - "analyze" runs the agent read-only (codex --sandbox read-only /
//    claude default permissions, which cannot edit without approval).
//  - "implement" lets the agent edit *that project only* (codex
//    --sandbox workspace-write confines writes to the cwd; claude runs
//    --permission-mode acceptEdits with cwd = the project).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { moveMission } = require('./board');

const AGENTS = ['codex', 'claude'];
const MODES = ['analyze', 'implement'];
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_LOG_LINES = 2000;
const MAX_RESULT_BYTES = 16 * 1024; // stdout tail appended to the handoff
const MAX_RUNS_KEPT = 50;

const previews = new Map(); // dispatchId -> spec (expires)
const runs = new Map();     // runId -> run

// Agent CLIs usually live outside launchd's bare PATH (nvm bin, ~/.local/bin,
// homebrew) — extend rather than replace.
function spawnEnv() {
  const extra = [
    path.dirname(process.execPath),           // nvm's bin (codex lives here)
    path.join(os.homedir(), '.local', 'bin'), // claude installer default
    '/opt/homebrew/bin', '/usr/local/bin',
  ];
  return { ...process.env, PATH: [process.env.PATH, ...extra].filter(Boolean).join(':') };
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'mission';
}

// The project must be a real directory directly inside PAKOS_ROOT — the
// same universe the scanner shows; no traversal, no absolute paths.
function resolveProject(projectsRoot, name) {
  if (!name || /[\/\\]/.test(name) || name.startsWith('.')) return null;
  const full = path.join(projectsRoot, name);
  if (path.dirname(full) !== path.resolve(projectsRoot)) return null;
  try { if (!fs.statSync(full).isDirectory()) return null; } catch { return null; }
  return full;
}

function buildArgv(agent, mode, model, prompt) {
  if (agent === 'codex') {
    return ['codex', 'exec',
      '--sandbox', mode === 'implement' ? 'workspace-write' : 'read-only',
      '-m', model, prompt];
  }
  return ['claude', '--print', '--model', model,
    ...(mode === 'implement' ? ['--permission-mode', 'acceptEdits'] : []), prompt];
}

function handoffContent({ project, mission, agent, model, mode }) {
  return `# Handoff — ${mission}

- **Project:** ${project}
- **Crew:** ${agent} (${model}), mode: ${mode}
- **Dispatched:** ${new Date().toISOString()} via PakOS

## Mission

${mission}

## Boundaries

- Work only inside this project directory.
- ${mode === 'analyze'
    ? 'Read-only run: investigate and report; do not modify files.'
    : 'You may edit files in this project. Nothing outside it.'}
- Keep the result concise: what you did/found, what a human should do next.

## Result

_(appended by PakOS from the agent's output when the run completes)_
`;
}

function previewDispatch(body, config, projectsRoot) {
  const agent = body.agent || config.crew.defaultAgent || 'codex';
  const mode = body.mode || 'analyze';
  const mission = String(body.mission || '').trim().slice(0, 500);
  if (!AGENTS.includes(agent)) return { error: `agent must be one of ${AGENTS.join(', ')}` };
  if (!MODES.includes(mode)) return { error: `mode must be one of ${MODES.join(', ')}` };
  if (!mission) return { error: 'mission is required' };

  const allowed = config.crew.models[agent] || [];
  const model = body.model || allowed[0];
  if (!allowed.includes(model)) {
    return { error: `model must be one of the configured ${agent} models: ${allowed.join(', ')}` };
  }
  const projectPath = resolveProject(projectsRoot, body.project);
  if (!projectPath) return { error: 'project must name a folder directly inside the projects root' };

  // Optional board binding. When the dispatch is launched from a board
  // mission, the human-approved lifecycle applies: confirm moves it
  // Ready → In Progress; the agent finishing moves it → Review; moving
  // to Done is always a human action, never automated.
  let missionRef = null;
  if (body.missionRef) {
    const r = body.missionRef;
    if (typeof r.sourceFile !== 'string' || !/^\.pakos\/[^/]+\.md$/.test(r.sourceFile) ||
        !Number.isInteger(r.line) || typeof r.title !== 'string' || !r.title.trim()) {
      return { error: 'missionRef must be { sourceFile: ".pakos/….md", line, title }' };
    }
    missionRef = { sourceFile: r.sourceFile, line: r.line, title: r.title.trim().slice(0, 200) };
  }

  const slug = slugify(mission);
  let handoffFile = `handoff-${slug}.md`;
  for (let n = 2; fs.existsSync(path.join(projectPath, '.pakos', handoffFile)); n++) {
    handoffFile = `handoff-${slug}-${n}.md`;
  }
  const prompt = `You are a crew member on the "${body.project}" project. ` +
    `Your mission briefing is in .pakos/${handoffFile} — read it first, then complete the mission. ` +
    `Finish with a concise summary of what you did or found.`;

  const dispatchId = crypto.randomUUID();
  const spec = {
    dispatchId, project: body.project, projectPath, projectsRoot, mission, agent, model, mode,
    missionRef,
    argv: buildArgv(agent, mode, model, prompt),
    handoffFile: `.pakos/${handoffFile}`,
    expiresAt: Date.now() + PREVIEW_TTL_MS,
  };
  previews.set(dispatchId, spec);
  // What confirm will do, stated exactly — this is the approval gate's content.
  const { projectPath: _p, projectsRoot: _r, ...pub } = spec;
  return {
    ...pub,
    expiresAt: new Date(spec.expiresAt).toISOString(),
    sandbox: agent === 'codex'
      ? (mode === 'implement' ? 'codex workspace-write: edits confined to this project' : 'codex read-only: no file edits')
      : (mode === 'implement' ? 'claude acceptEdits: edits in this project (cwd)' : 'claude default: cannot edit without approval'),
    boardMove: missionRef
      ? 'confirm moves this mission → In Progress; agent success moves it → Review; Done stays yours'
      : null,
  };
}

function runPublic(run) {
  const { _proc, ...pub } = run;
  return pub;
}

function confirmDispatch(dispatchId, { onEvent }) {
  const spec = previews.get(dispatchId);
  if (!spec) return { error: 'unknown dispatchId', code: 404 };
  previews.delete(dispatchId);
  if (Date.now() > spec.expiresAt) return { error: 'preview expired — request a new one', code: 409 };

  // Board move #1 (human-approved by this very confirm): → In Progress.
  // Runs BEFORE anything else so a stale board aborts the whole dispatch.
  if (spec.missionRef) {
    try {
      const moved = moveMission(spec.projectsRoot, {
        project: spec.project, ...spec.missionRef, toStatus: 'in_progress',
      });
      onEvent?.('crew_board_move', spec, `${spec.project}: "${moved.title}" → in_progress (dispatch confirmed)`);
    } catch (err) {
      return { error: `board move failed: ${err.message}`, code: err.code || 409 };
    }
  }

  return startRun(spec, { onEvent });
}

// Fixed-template analyze run — used by server-owned templates (e.g. board
// reconciliation) where the prompt and read-only sandbox are hardcoded, so
// the two-step preview gate would be reviewing constants. Still one human
// click per invocation (the route is auth'd) and audited by the caller.
function dispatchTemplate({ project, mission, prompt }, config, projectsRoot, { onEvent, onComplete } = {}) {
  const projectPath = resolveProject(projectsRoot, project);
  if (!projectPath) return { error: 'project must name a folder directly inside the projects root' };
  const agent = 'codex';
  const model = (config.crew.models[agent] || [])[0];
  if (!model) return { error: 'no codex model configured' };

  const slug = slugify(mission);
  let handoffFile = `handoff-${slug}.md`;
  for (let n = 2; fs.existsSync(path.join(projectPath, '.pakos', handoffFile)); n++) {
    handoffFile = `handoff-${slug}-${n}.md`;
  }
  const spec = {
    project, projectPath, projectsRoot, mission, agent, model,
    mode: 'analyze', missionRef: null,
    argv: buildArgv(agent, 'analyze', model, prompt),
    handoffFile: `.pakos/${handoffFile}`,
  };
  return startRun(spec, { onEvent, onComplete });
}

function startRun(spec, { onEvent, onComplete } = {}) {
  // PakOS-owned write #1: the handoff briefing.
  const handoffAbs = path.join(spec.projectPath, spec.handoffFile);
  fs.mkdirSync(path.dirname(handoffAbs), { recursive: true });
  fs.writeFileSync(handoffAbs, handoffContent(spec));

  const run = {
    id: crypto.randomUUID(),
    project: spec.project, mission: spec.mission,
    agent: spec.agent, model: spec.model, mode: spec.mode,
    handoffFile: spec.handoffFile,
    status: 'running',
    startedAt: new Date().toISOString(), endedAt: null, exitCode: null,
    log: [],
    _proc: null,
  };

  const addLog = (type, text) => {
    for (const lineText of String(text).split('\n')) {
      const line = lineText.trimEnd();
      if (!line) continue;
      if (run.log.length >= MAX_LOG_LINES) return;
      run.log.push({ at: new Date().toISOString(), type, line });
    }
  };

  let proc;
  try {
    proc = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.projectPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: spawnEnv(),
    });
  } catch (err) {
    run.status = 'error';
    addLog('error', `spawn failed: ${err.message}`);
    runs.set(run.id, run);
    return { run: runPublic(run) };
  }
  run._proc = proc;
  runs.set(run.id, run);
  trimRuns();

  let stdoutTail = '';
  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    stdoutTail = (stdoutTail + text).slice(-MAX_RESULT_BYTES);
    addLog('out', text);
  });
  proc.stderr.on('data', (chunk) => addLog('err', chunk.toString()));

  proc.on('error', (err) => {
    run.status = 'error';
    run.endedAt = new Date().toISOString();
    addLog('error', `process error: ${err.message} (is ${spec.argv[0]} installed and logged in?)`);
    onEvent?.('crew_run_failed', run);
  });

  proc.on('close', (code) => {
    if (run.status === 'cancelled') return finishHandoff();
    run.exitCode = code;
    run.endedAt = new Date().toISOString();
    run.status = code === 0 ? 'complete' : 'error';
    finishHandoff();

    // Board move #2: agent finished cleanly → Review (located by title,
    // since the line moved at dispatch). Failures and cancels stay in
    // In Progress for the human to judge; nothing ever auto-moves to Done.
    if (spec.missionRef && run.status === 'complete') {
      try {
        const moved = moveMission(spec.projectsRoot, {
          project: spec.project, sourceFile: spec.missionRef.sourceFile,
          title: spec.missionRef.title, toStatus: 'review',
        });
        addLog('info', `board: "${moved.title}" → review`);
        onEvent?.('crew_board_move', spec, `${spec.project}: "${moved.title}" → review (agent finished)`);
      } catch (err) {
        addLog('error', `board move to review failed: ${err.message} — mission left in In Progress`);
      }
    }

    onEvent?.(code === 0 ? 'crew_run_complete' : 'crew_run_failed', run);
    try { onComplete?.(runPublic(run), stdoutTail); }
    catch (err) { addLog('error', `post-run hook failed: ${err.message}`); }
  });

  // PakOS-owned write #2: append the captured result to the handoff, so the
  // durable outcome lives in markdown even for read-only agent runs.
  const finishHandoff = () => {
    const stamp = `\n---\n\n### ${run.status} · ${run.agent} (${run.model}) · ${run.endedAt || new Date().toISOString()}\n\n`;
    const body = stdoutTail.trim()
      ? '```\n' + stdoutTail.trim() + '\n```\n' : '_(no output captured)_\n';
    try { fs.appendFileSync(handoffAbs, stamp + body); } catch { /* project may have vanished */ }
  };

  return { run: runPublic(run) };
}

function trimRuns() {
  const finished = [...runs.values()].filter((r) => r.status !== 'running');
  while (runs.size > MAX_RUNS_KEPT && finished.length) {
    const oldest = finished.shift();
    runs.delete(oldest.id);
  }
}

function listRuns() {
  return [...runs.values()].map(runPublic)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .map(({ log, ...summary }) => ({ ...summary, logLines: log.length }));
}

function getRun(id) {
  const run = runs.get(id);
  return run ? runPublic(run) : null;
}

function cancelRun(id) {
  const run = runs.get(id);
  if (!run) return { error: 'unknown run', code: 404 };
  if (run.status !== 'running') return { error: 'run is not running', code: 409 };
  run.status = 'cancelled';
  run.endedAt = new Date().toISOString();
  run.log.push({ at: run.endedAt, type: 'error', line: '✕ cancelled by user' });
  try { run._proc?.kill('SIGTERM'); } catch { /* already gone */ }
  return { run: runPublic(run) };
}

module.exports = { previewDispatch, confirmDispatch, dispatchTemplate, listRuns, getRun, cancelRun };
