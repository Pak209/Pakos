# PakOS AutoPilot — design (v0.6 series)

Status: **design approved for planning, not yet implemented.** Ships as its
own PR series after the human-triggered crew dispatch (v0.2, PR #3) has
soaked. Nothing in this document changes PR #3's behavior.

AutoPilot is scheduled crew: PakOS wakes up a few times a day (and
optionally overnight), looks at the Mission Board, and runs **only
pre-approved** missions inside hard budgets — then writes a brief and goes
back to sleep. It is a scheduler around the existing, already-audited
dispatch machinery, not a new execution path.

## Goals / non-goals

- Goal: approved, low-risk work happens without a human tap; everything
  else keeps waiting for one.
- Goal: a human can understand *afterwards* exactly what ran, why it was
  eligible, and what it changed — from the board, the briefs, and the
  audit log alone.
- Non-goal: a continuously running agent loop. AutoPilot is discrete
  wake-ups with budgets, not a daemon that watches.
- Non-goal: replacing Manual Dispatch. PR #3 stays the default path.

## Modes

| Mode | Trigger | Default posture |
|---|---|---|
| **Manual Dispatch** | human, two-step confirm (PR #3) | any approved mode |
| **Day Watch** | launchd calendar, e.g. 09:00 / 13:00 / 17:00 | analyze-only; short budgets; can be set to *suggest* (analyze + brief, no board moves) |
| **Night Shift** | launchd hourly ticks inside a window, e.g. 23:00–05:00 | analyze-only unless a mission is explicitly approved for writes; larger budgets |

"No continuous loop" is enforced structurally: Day Watch is N discrete
calendar wake-ups; Night Shift is *hourly wake-ups inside the window*,
each a bounded process that exits — never a resident poller.

## Consent model — three keys, all required

Unattended execution requires ALL of:

1. **Global**: `~/.pakos/config.json → autopilot.enabled: true` (plus the
   mode's schedule) and `killSwitch: false`.
2. **Per-project**: the project contains `.pakos/crew.json` with
   `"autopilot": true`. No file, or `false` → project is invisible to
   AutoPilot regardless of tags.
3. **Per-mission**: the board line carries `@auto` (eligible day + night)
   or `@night` (night only), or the mission is listed in `crew.json`
   under `"approvedMissions"` with `"automationApproved": true`.

Missing any key → the mission can only be run by Manual Dispatch.

**Write access is a fourth, separate consent.** Unattended runs default
to analyze (read-only sandbox). `implement` mode requires BOTH
`crew.json → "allowImplement": true` (per-project) AND the mission
approved for writes (`@auto:write` tag or `"mode": "implement"` in its
`approvedMissions` entry). Either alone is not enough.

### `.pakos/crew.json` (per project, committed, human-edited)

```json
{
  "autopilot": true,
  "allowImplement": false,
  "maxMissionsPerRun": 2,
  "approvedMissions": [
    { "title": "Refresh dependency audit", "automationApproved": true, "mode": "analyze" }
  ]
}
```

## Hard safety invariants

- **Forbidden always** (enforced, not just prompted): commit, push,
  deploy, delete files outside the mission scope, read or edit secrets /
  `.env` / credentials, change git config or remotes. Enforcement layers:
  1. sandbox — analyze runs are read-only; implement runs are confined to
     the project working tree;
  2. handoff boundaries — the briefing states the prohibitions;
  3. **post-flight checks** — after every unattended run AutoPilot diffs
     `git rev-parse HEAD`, ref list, and `git status` shape against
     pre-run snapshots. New commits, ref changes, or touched dotfiles →
     the run is marked **unsafe**, the mission goes to **Blocked**, and
     that project's AutoPilot trips its breaker (below).
- **Budgets** (config, enforced by the runner):
  - `maxMissionsPerRun` (global cap AND per-project cap, lower wins)
  - `maxMissionMinutes` — SIGTERM at the limit, run marked failed
  - `maxDayMinutes` / `maxNightMinutes` — total runtime ledger per
    calendar day/night, persisted in `data/autopilot.json` (disposable);
    a wake-up that finds the ledger spent exits immediately
- **Failure breaker**: N consecutive failures (default 2) for the same
  mission → mission moves to **Blocked** and is skipped until a human
  moves it back. N consecutive failed runs for a project → project
  breaker trips (skipped until a human resets it in the UI). Unsafe
  post-flight → breaker trips immediately.
- **Kill switch**: `autopilot.killSwitch` in config — checked at wake-up
  and between missions; the UI toggle and an emergency `curl` both set
  it; `launchctl bootout` remains the hardware-level stop. Kill switch
  also cancels the in-flight run via the existing cancel path.
- **Identity & audit**: AutoPilot authorizes via the local bearer token
  on loopback only (never through the tunnel) and audits as
  `autopilot:day` / `autopilot:night`; every mission run produces the
  same handoff file + audit entries as Manual Dispatch, plus a run brief.

## Board lifecycle (extends PR #3's contract)

- Ready → **In Progress** when AutoPilot starts a mission (stale board →
  skip, not force)
- In Progress → **Review** when the agent completes and post-flight is
  clean
- → **Blocked** when the run fails, times out, or post-flight flags it
  (Blocked is a new board column/status in spec v2, parsed from a
  "Blocked" heading)
- Review → **Done**: always manual, in AutoPilot exactly as everywhere

## Briefs

Every wake-up writes `.pakos/briefs/autopilot-<date>-<mode>.md` in
PakOS's own repo: eligible queue at wake-up, what ran (with durations and
budget spend), what moved where, what was skipped and why, breaker state.
The morning brief in the UI is simply the newest night file rendered,
alongside the Daily Brief.

## UI — AutoPilot page (drawer entry)

- Master toggle (writes config via an auth'd settings endpoint) +
  **kill switch** button, both instant
- Next scheduled runs (computed from config; shows "disabled" states)
- **Approved queue**: missions currently eligible per the consent model,
  with the reason shown (`@auto` / crew.json / write-approved) — this
  doubles as a dry-run: you can see exactly what the next wake-up would
  pick up before ever enabling execution
- Last run summary (from `data/autopilot.json`) + link to the brief
- Breaker states per project, with a human reset button

## Scheduling (macOS)

Two LaunchAgents, both `StartCalendarInterval` (no KeepAlive — they run
and exit): `com.pakos.autopilot.day` at the configured times;
`com.pakos.autopilot.night` hourly within the window (each tick re-checks
window, ledger, kill switch). The runner is `scripts/autopilot.js`
(stdlib only), a thin client of the existing loopback API so its runs
appear in the normal crew run list.

## PR series (after #3 is stable)

1. **AP-1 — visibility, zero execution**: board spec v2 (`@auto`,
   `@night`, `@auto:write` tags; Blocked column), `crew.json` reader,
   AutoPilot page showing the approved queue + schedule preview. Merging
   this runs nothing; it shows what *would* run.
2. **AP-2 — analyze-only execution**: runner + LaunchAgents + budgets +
   ledger + breakers + briefs + kill switch. Implement mode rejected
   outright regardless of config.
3. **AP-3 — implement opt-in**: the fourth consent (project + mission),
   post-flight git checks, unsafe → Blocked + breaker.
4. **AP-4 — polish**: notifications hook (ntfy/webhook, v0.7 tie-in),
   breaker UX, brief history view.

Each PR is independently revertible; AP-1 is deliberately safe to merge
early since it only reads.

## Open questions for review

- Suggest-mode default for Day Watch: start with *suggest* (brief only,
  no board moves) for the first week, then flip to perform?
- Night window on a machine that sleeps: rely on `pmset` wake schedule,
  or accept skipped ticks? (Recommend: accept skips; document `pmset
  repeat wakeorpoweron` as optional.)
- Should `@night` missions also require `@auto`? (Current design: no —
  `@night` implies night-only automation approval.)
