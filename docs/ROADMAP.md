# Roadmap — v0.2 → v1.0

Each release keeps the invariants: read-only until auth exists, zero (or
near-zero) dependencies, everything regenerable from git + markdown.

> **Reorder note (v0.2, 2026-07):** remote multi-device access and a
> Codex-first crew became the immediate need, so v0.2 pulled auth forward
> from v0.4 and a scoped dispatch slice forward from v0.5. The original
> v0.2 read-only items (detail view, Daily Brief) moved to v0.3 —
> deferred, not cancelled. Invariants unchanged.

## v0.2 — Auth, remote access, usage, crew dispatch *(shipped as this release)*

- Auth (from v0.4): bearer token in `~/.pakos/config.json` (0600,
  generated), required by all non-GET routes; audit log of every write.
- Remote: Cloudflare Tunnel + Cloudflare Access at pakos.pak-labs.com
  (docs/REMOTE.md); server stays loopback-bound.
- Usage panel: Codex subscription limits (exact, from local session
  files), Claude estimate (local transcript parsing — no secrets, no
  OAuth), provider API usage cards that appear only when admin keys are
  added to config.
- Crew dispatch (scoped slice of v0.5): `@owner` tag in the board spec;
  human-triggered two-step (preview → confirm) dispatch of Codex/Claude
  onto a mission; handoff file convention `.pakos/handoff-<topic>.md`;
  run log polling + cancel. No scheduling, no auto-pickup.
- Crew board lifecycle (human-gated at both ends): confirming a dispatch
  moves the bound mission Ready → In Progress; the agent finishing cleanly
  moves it → Review; failures/cancels stay In Progress; **Review → Done is
  only ever a human move** — no code path automates it.
- Interactive Mission Board (v0.4's write pulled forward too): create
  missions and move them between columns from the UI — guarded edits to
  `.pakos/*.md` board files only (`lib/board.js`), token-auth'd, audited,
  stale-view-safe. Missions parsed from other files stay read-only in the
  UI. Plus: internally-scrolling kanban columns, Daily Brief modal,
  per-project detail API, centered desktop layout, nav drawer.

## v0.3 — GitHub-aware Rescan + missions & depth (read-only)

GitHub-aware Rescan (spec agreed 2026-07):

- **Opt-in per project**: a per-project `githubSync: true/false` setting
  (config or `.pakos/`); disabled projects behave exactly as today.
- **`git fetch` only** for enabled projects — hard guarantees: no working
  tree changes, no push, no checkout, no merge/pull. Fetch updates
  remote-tracking refs so ahead/behind is finally true.
- **GitHub API**: open PRs, issues, CI status per project (via `gh` or a
  read-only token in `~/.pakos/config.json`, server-side only).
- **UI freshness labels**: every git-derived number is labeled **Local**
  (as of last disk scan) vs **GitHub** (as of last sync), with timestamps —
  no number pretends to be fresher than it is.
- Activity feed merges local commits + remote events.

Also in v0.3:

- Per-project detail view: commit history, branch list, mission sources
  *(moved from v0.2)*.
- Daily Brief generator: markdown digest written to `.pakos/briefs/`,
  rendered in the UI *(moved from v0.2; still human-triggered)*.
- UI: reduced-motion support, pull-to-refresh, better empty states.

## v0.4 — Mission write-back

- **Board write endpoint**: move a mission between columns — a guarded
  edit to that project's `.pakos/board.md` only. Code and other files
  remain untouchable. (Auth + audit shipped early in v0.2.)
- Stdlib RS256 verification of `Cf-Access-Jwt-Assertion` (edge identity
  checked server-side too).

## v0.5 — Crew (full)

- Crew panel matures: which agent touched which mission last, handoffs
  awaiting pickup. Agents stay peripheral: they appear on missions, not
  as the app.
- "New mission" and "request handoff" quick actions (writes to `.pakos/`).

## v0.6 — AutoPilot (scheduled crew)

Full design: [docs/AUTOPILOT.md](AUTOPILOT.md) — approved 2026-07, ships
as its own PR series (AP-1 … AP-4) only after v0.2 crew dispatch has
soaked. In one paragraph: Day Watch (a few calendar wake-ups) and Night
Shift (hourly ticks inside a window) inspect the Mission Board and run
**pre-approved missions only** — triple consent (global config +
per-project `.pakos/crew.json` + per-mission `@auto`/`@night` tag),
analyze-only by default with a fourth consent for writes, hard budgets
(missions/run, minutes/mission, minutes/day+night), failure breakers,
post-flight git checks (never commit/push/deploy/secrets), kill switch,
a brief per wake-up, and the same board lifecycle as manual dispatch —
Review → Done stays human, always. No continuous loop by construction.

## v0.7–v0.9 — Local automation, polish & hardening

- Script runner for a whitelist the user defines per project
  (`.pakos/commands.md`): build, test, package — opt-in, auth-gated,
  output captured to the activity feed.
- launchd health: PakOS watches its sibling agents (AlphaLab-style) and
  surfaces their status.

- Progress trends (scan history retained, sparklines per project).
- Notifications (ntfy/webhook) for briefs and failures.
- Multi-root support (`PAKOS_ROOT` as a list).
- Performance pass, accessibility pass, visual QA against DESIGN.md.

## v1.0 — Command center

- PakOS is the default screen for the Mac mini: projects, missions,
  briefs, crew, automation — stable APIs, documented conventions, and a
  setup script that works on a fresh Mac.
- Consolidation decision point: only now does PakOS consider absorbing
  reporting duties from existing control-room tooling, which remains
  untouched until this line.
