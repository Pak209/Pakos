# Roadmap — v0.2 → v1.0

Each release keeps the invariants: read-only until auth exists, zero (or
near-zero) dependencies, everything regenerable from git + markdown.

## v0.2 — Missions & depth (read-only)

- Per-project detail view: commit history, branch list, mission sources.
- Mission model formalized: `.pakos/board.md` spec v1 (status, tags,
  optional `@agent` owner), parser upgraded but backward-compatible.
- Daily Brief generator: scheduled markdown digest (commits, mission
  deltas, dirty repos) written to `.pakos/briefs/` in PakOS's own repo,
  rendered in the UI.
- UI: reduced-motion support, pull-to-refresh, better empty states.

## v0.3 — GitHub awareness (read-only)

- Opt-in `git fetch` per project (still never mutates working trees) for
  true ahead/behind.
- GitHub API (via `gh` or token): open PRs, issues, CI status per project.
- Activity feed merges local commits + remote events.

## v0.4 — Identity & the first write

- Auth: bearer token (and/or Tailscale identity headers). All non-GET
  routes require it; CSRF protection added.
- **First write endpoint**: move a mission between columns — implemented
  as a guarded edit to that project's `.pakos/board.md` only. Code and
  other files remain untouchable.
- Audit log of every write.

## v0.5 — Crew (agent handoffs)

- Handoff convention: `.pakos/handoff-<topic>.md` — structured context an
  agent (Lex, Fable, Codex, …) or human leaves for the next crew member.
- Crew panel: which agent touched which mission last, handoffs awaiting
  pickup. Agents stay peripheral: they appear on missions, not as the app.
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
