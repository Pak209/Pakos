# PakOS Engineering Intelligence — design proposal

Status: **vision + architecture, approved for planning 2026-07.** Nothing
here changes shipped behavior or PR #3 (which stays human-triggered
exactly as designed). This document defines where PakOS goes after v0.2
soaks, and re-grounds the roadmap around one idea:

> **Agents are tools. Intelligence is the product.**

Hermes orchestrates *how* work runs. PakOS decides *what deserves to run
and why* — and remembers what happened. That division of labor is the
moat: an Engineering Intelligence System that continuously understands
the whole portfolio, not another agent runner or task tracker.

---

## 1. Vision

PakOS is the operating system for one engineer's entire software
portfolio. Every morning it already knows:

1. **What changed overnight?** — commits, CI, agent runs, board moves
2. **What deserves attention?** — regressions, drift, aging work, risk
3. **What should I work on today?** — ranked, reasoned, effort-sized
4. **What can be delegated?** — missions with a high agent-fit score
5. **Which projects are drifting?** — activity diverging from stated intent
6. **Which opportunities exist?** — cheap wins, unblocked dependencies
7. **What should execute next?** — the AutoPilot queue, pre-consented

The test of every feature: does it improve the quality of an engineering
decision, or the quality of the system's memory of one? If neither, it
doesn't belong.

Invariants carry forward unchanged: zero npm dependencies, local-first,
markdown + git as truth, the DB a disposable index, writes confined to
`.pakos/` files, every write audited, nothing unattended without the
AutoPilot consent keys (docs/AUTOPILOT.md).

## 2. Engineering Intelligence architecture

Five layers, each useful without the ones above it:

```
L4  PRESENTATION   The Briefing · Portfolio · Dossiers · Mission Intelligence · AutoPilot
L3  INTELLIGENCE   discovery engine · ranking · recommendation records · learning loop
L2  ANALYZERS      health · momentum · drift · debt · risk · dependencies (deterministic first)
L1  PORTFOLIO MODEL   one normalized model: projects × signals × missions × runs × memory
L0  SENSORS        local git · markdown · GitHub/CI (v0.3) · handoffs · run ledger · memory files
                   · usage telemetry (subscription windows)
```

Design rules:

- **Deterministic core, LLM at the edges.** Everything in L1–L2 computes
  from raw signals with plain code — free, instant, explainable, always
  on. LLM (crew analyze runs) enters only in L3 as an *enrichment
  sensor*: proposing candidate missions and narrative summaries in
  structured form, which the deterministic ranker then scores. PakOS
  degrades gracefully to a fully useful system when no agent ever runs.
- **Explainable or it doesn't ship.** Every score, rank, and
  recommendation carries its evidence chain down to raw signals. No
  black-box numbers anywhere in the UI.
- **The DB stays disposable.** L1 is a SQLite *index* rebuilt from
  sensors; durable truth (decisions, outcomes, rejections) lives as
  markdown/JSONL in `.pakos/` and `~/.pakos/memory/` — human-readable,
  git-trackable, regenerable-from.

## 3. Mission Intelligence system

The unit of intelligence is the **recommendation record** — a suggested
mission with its full decision context:

```json
{
  "id": "rec-…",
  "project": "Cadence",
  "title": "Fix flaky AU validation test before plugin submission",
  "priority": "P1", "score": 87,
  "confidence": 0.8,
  "effort": "M", "estMinutes": 45,
  "duration": "one sitting",
  "dependencies": ["rec-… (CI must be green)"],
  "risk": { "level": "low", "why": "test-only change, analyze first" },
  "recommendedAgent": "codex",
  "recommendedModel": "gpt-5.5",
  "executionMode": "analyze",
  "reasoning": [
    "CI red for 3 days after 6 green weeks (regression signal)",
    "board mission 'ship v0.2 plugin' blocked on this (dependency)",
    "codex analyze runs on Cadence: 5/5 success, median 4 min (memory)"
  ],
  "provenance": ["signal:ci", "detector:regression", "memory:agent-ledger"],
  "state": "suggested"
}
```

- **Confidence** is evidence-based: how many independent signals agree,
  how fresh they are, and how often this detector's past suggestions were
  accepted (learning loop, §6).
- **Agent/model recommendation** comes from the agent performance ledger
  — real success rates and durations by agent × model × mission type ×
  project — plus current subscription headroom from the usage sensors
  (don't recommend a codex run into a nearly-spent 5h window).
- **Lifecycle**: `discovered → suggested → accepted | rejected | snoozed
  | expired`. *Accepted* materializes a board mission (with tags/owner
  pre-filled) — from there the existing consent machinery governs
  execution; discovery NEVER executes anything itself. *Rejected*
  requires one tap and optionally a reason; both are written to memory so
  the same idea is suppressed and the detector's confidence recalibrates.

## 4. Portfolio Health model

Replaces the v0.1 done-ratio with six explainable dimensions, each 0–100
with a trend and a "because" list:

| Dimension | Computed from (examples) |
|---|---|
| **Momentum** | commit recency/frequency trend, mission throughput, streak vs stall |
| **Hygiene** | age of dirty/untracked files, stash pileup, unpushed commits, stale branches |
| **Quality** | CI status and stability (v0.3), test presence, red-after-green regressions |
| **Debt** | TODO/FIXME density and *trend*, aging Backlog, blocked-mission dwell time |
| **Recovery risk** | volume of uncommitted/unpushed work (what a disk failure would eat), missing remote |
| **Direction** | drift: commits touching areas no mission mentions; ROADMAP/board staleness vs code activity |

Health = weighted blend (weights in config, sane defaults), displayed as
a grade with per-dimension bars, 30-day sparklines (scan history retained
— the one schema change from "snapshot only"), and deltas in every brief.
Clicking any dimension shows the raw signals that produced it. Arbitrary
percentages die here.

## 5. Mission Discovery engine

Three candidate sources feeding one ranker:

1. **Deterministic detectors** (always on, free): regression watch (CI
   red after green), hygiene nags (dirty work aging past N days, unpushed
   commits), aging In Progress/Review items, drift (active code area with
   no covering mission), TODO/FIXME harvest (size-capped code comment
   scan → candidate missions with file:line provenance), missing
   scaffolding (no board, no README section, no CI), dependency chains
   (mission B waits on A — surfaced when A completes), opportunity
   detection (small, high-health-impact fixes).
2. **Memory-informed adjustments**: suppress rejected ideas, boost
   patterns that historically got accepted and succeeded, respect
   per-project preferences (§6).
3. **LLM discovery** (optional, scheduled): AutoPilot Day Watch in
   *suggest* mode dispatches analyze-only crew runs that read a project +
   its signal summary and emit candidate recommendations as structured
   JSON in the handoff. PakOS validates them (schema, dedup against board
   + memory + open recommendations) and hands them to the same ranker —
   LLM candidates get no special authority.

Ranking = value × urgency ÷ effort, risk-adjusted, confidence-weighted;
ties broken toward portfolio balance (don't pile ten recommendations on
one project while another drifts). Every run of the engine is itself
logged, so "why did this appear today?" always has an answer.

## 6. Engineering Memory architecture

Truth in files, index in SQLite, learning as counting — no ML infra:

- **Per project** (`<project>/.pakos/memory/`):
  - `decisions.md` — ADR-lite: dated architectural decisions with context
    ("2026-05: rejected Electron shell — startup cost. Revisit if …")
  - `log.md` — completed missions with outcome one-liners (auto-appended
    on Done, human-editable)
  - `rejected.md` — declined recommendations + reasons (auto-appended)
  - existing `handoff-*.md` — episodic memory of every agent run
- **Global** (`~/.pakos/memory/`):
  - `agent-ledger.jsonl` — one line per crew run: agent, model, mode,
    mission type, project, duration, outcome, post-flight result. This is
    the substrate for agent/model recommendations and delegation scores.
  - `patterns.md` — cross-project observations worth keeping
- **Retrieval** is boring on purpose: project match + tag match + recency
  (no embeddings; revisit only if retrieval demonstrably fails).
- **Learning loop**: accept/reject/snooze updates per-detector and
  per-mission-type counters (simple Bayesian smoothing). Detectors that
  keep getting rejected get quieter *for that project*; agent/model
  choices follow the ledger's actual success rates. All counters are
  inspectable JSON — the "model" can be read, edited, and reset with a
  text editor.
- Memory files are PakOS-owned writes (audited, `.pakos/`-confined) and
  double as excellent agent context: future handoffs embed the relevant
  decisions and rejections so agents stop re-proposing what you've
  already declined — and recommendations can cite them ("you rejected
  this in May because X; X changed").

## 7. AutoPilot architecture

docs/AUTOPILOT.md stands as written — triple consent, budgets, breakers,
post-flight checks, kill switch, no continuous loop, Review → Done always
human. This design extends it in two ways:

- **A fourth mode: Weekly Maintenance** — one weekend window (e.g. Sunday
  09:00) for the slow work: dependency audits, doc freshness passes,
  memory compaction (log rollups), and the weekly portfolio health
  report. Same consent and budget machinery, longer per-mission budget,
  analyze-first.
- **Intelligence-first scheduling**: AutoPilot's *primary* job becomes
  running the discovery engine and writing the brief; executing missions
  is the optional second half. Day Watch in suggest mode is the default
  posture — an AutoPilot that only ever *thinks* is already valuable, and
  execution is enabled per-project/per-mission exactly as specified.
  Subscription awareness: the scheduler consults usage sensors and defers
  agent-hungry work when a window is nearly spent, preferring the model
  whose budget is healthiest among approved options.

## 8. UI evolution — calm operating system, not a Kanban

The board demotes from home page to *one view among several*. Density up,
noise down: typographic hierarchy, tables and ranked lists over cards,
near-zero motion, numbers with deltas, everything answerable in one
screen. Still the JARVIS design language (docs/DESIGN.md), still
self-contained static files, still no build step.

- **The Briefing** (new home): the seven morning questions as seven
  compact sections — overnight delta, attention list, today's ranked
  plan, delegation queue, drift watch, opportunities, AutoPilot's next
  queue. Each line links to its evidence.
- **Portfolio**: health matrix — projects × six dimensions, sparklines,
  sortable; the drifting and the thriving visible in one glance.
- **Project Dossier**: per-project deep view — signals, health breakdown,
  missions, run history, memory (decisions/log/rejected) rendered inline.
- **Mission Intelligence**: the recommendation feed with accept / reject
  (+reason) / snooze, reasoning expanded in place, provenance links.
- **Missions** (the board): unchanged mechanics, one tap away.
- **AutoPilot**: as designed — toggle, schedule, approved queue, last
  run, breakers, kill switch.
- Keyboard-first on desktop (j/k through the briefing, a/r/s on
  recommendations) lands late in the roadmap; phone stays first-class.

## 9. Phased implementation roadmap

Each phase is independently shippable and keeps every invariant. (Aligns
with ROADMAP.md; this section is the authoritative sequencing for the
intelligence work.)

- **Phase 0 — Foundation (now)**: land #2 (usage) and #3 (crew); soak.
  These are sensors and actuators the intelligence needs.
- **Phase 1 — Sense (v0.3)**: GitHub-aware Rescan as specced (fetch-only,
  opt-in, Local vs GitHub freshness labels) + CI/PR/issue sensors; scan
  history retention (sparkline substrate); code TODO/FIXME harvester;
  signals table in the DB.
- **Phase 2 — Remember (v0.4)**: memory file conventions + auto-append on
  Done/reject; agent ledger (backfilled from existing handoffs where
  possible); per-project detail view becomes the Dossier v1.
- **Phase 3 — Understand (v0.5)**: Health v2 (six dimensions,
  explainable, replaces done-ratio everywhere); drift + regression +
  hygiene detectors; Portfolio view; Daily Brief generator upgraded into
  Briefing v1 (deterministic content only).
- **Phase 4 — Recommend (v0.5.x)**: recommendation records + ranker +
  Mission Intelligence UI + accept/reject/snooze loop; Briefing gains the
  ranked plan and delegation queue.
- **Phase 5 — Schedule (v0.6)**: AutoPilot AP-1 → AP-4 per
  docs/AUTOPILOT.md, with Day Watch suggest-mode LLM discovery and Weekly
  Maintenance; Briefing gains "what executes next".
- **Phase 6 — Refine (v0.7+)**: learning-loop calibration surfaced in UI,
  notifications (brief to phone via ntfy), keyboard-first pass, density
  polish, multi-root.

## 10. The 25 highest-impact differentiators

Versus Hermes (orchestrates agents), GitHub Projects/Linear (track tasks
humans write), and AI dashboards (visualize without deciding):

1. **The Morning Briefing** — seven questions answered before you ask.
2. **Explainable health scores** — six engineering dimensions, every
   number clickable down to raw git/CI signals; no vibes-percentages.
3. **Mission discovery** — the system writes the backlog candidates;
   you curate instead of author.
4. **Full-context recommendations** — priority, confidence, effort,
   risk, dependencies, agent, model, mode, and *reasoning* on every one.
5. **Drift detection** — code activity diverging from stated missions,
   caught weekly, not at retro time.
6. **Regression watch** — CI red-after-green treated as a first-class
   attention event with an auto-suggested mission.
7. **Delegation queue** — missions ranked by agent-fit from measured
   history, not hope.
8. **Agent performance ledger** — success rates and durations by agent ×
   model × mission type; recommendations cite it.
9. **Subscription-aware scheduling** — routes work to the model whose
   plan window has headroom; defers when budgets are tight (no other
   tool even sees your Codex/Claude windows).
10. **Rejected-idea memory** — declined suggestions stay declined, with
    reasons, and resurface only when their context changes.
11. **ADR-lite decision memory** — architectural decisions live next to
    the code and flow into agent handoffs automatically.
12. **Recommendation provenance** — "why am I seeing this today?" always
    has a one-tap answer.
13. **Triple-consent autonomy** — global + project + mission keys before
    anything unattended; a fourth for writes. Autonomy you can audit.
14. **Post-flight safety checks** — unattended runs are verified against
    git snapshots; a surprise commit trips a breaker, not a shrug.
15. **Human-gated lifecycle** — Ready→In Progress→Review automated at
    most; Done is constitutionally human.
16. **Handoff paper trail** — every agent run leaves markdown a human
    (or the next agent) can read; episodic memory for free.
17. **Audit-grade attribution** — every write attributed to a verified
    human identity or a named machine actor (`crew:codex`,
    `autopilot:night`).
18. **Everything is markdown + git** — the board, memory, and briefs
    work in any editor, survive PakOS itself, and diff like code.
19. **Zero-dependency local-first privacy** — portfolio intelligence
    with no cloud, no SaaS, no supply chain; your code never leaves.
20. **Dry-run visibility** — AutoPilot's approved queue shows exactly
    what would run before execution is ever enabled.
21. **Budget ledgers + breakers + kill switch** — autonomy with
    circuit-breaker engineering, inspectable and resettable in the UI.
22. **Portfolio balance ranking** — recommendations spread across
    projects so quiet repos don't rot silently.
23. **Opportunity detection** — cheap, high-health-impact wins surfaced
    explicitly, not just problems.
24. **Learning that's just counting** — accept/reject recalibrates
    detectors per project; the whole "model" is human-readable JSON you
    can edit or reset.
25. **Weekly Maintenance mode** — scheduled deep passes (deps, docs,
    memory rollups, health report) as a system feature, not a chore you
    remember.

---

*Review notes welcome inline. Phase 1 planning starts when #2/#3 have
soaked and the GitHub-aware Rescan PR is scoped.*
