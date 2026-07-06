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
- Interactive Mission Board (v0.4's write pulled forward too): create
  missions and move them between columns from the UI — guarded edits to
  `.pakos/*.md` board files only (`lib/board.js`), token-auth'd, audited,
  stale-view-safe. Missions parsed from other files stay read-only in the
  UI. Plus: internally-scrolling kanban columns, Daily Brief modal,
  per-project detail API, centered desktop layout, nav drawer.

## v0.3 — Missions & depth + GitHub awareness (read-only)

- Per-project detail view: commit history, branch list, mission sources
  *(moved from v0.2)*.
- Daily Brief generator: markdown digest written to `.pakos/briefs/`,
  rendered in the UI *(moved from v0.2; still human-triggered)*.
- UI: reduced-motion support, pull-to-refresh, better empty states.
- Opt-in `git fetch` per project (still never mutates working trees) for
  true ahead/behind.
- GitHub API (via `gh` or token): open PRs, issues, CI status per project.
- Activity feed merges local commits + remote events.

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

## v0.6 — Local automation

- Script runner for a whitelist the user defines per project
  (`.pakos/commands.md`): build, test, package — opt-in, auth-gated,
  output captured to the activity feed.
- launchd health: PakOS watches its sibling agents (AlphaLab-style) and
  surfaces their status.

## v0.7–v0.9 — Polish & hardening

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
