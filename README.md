# PakOS

**A personal command center for software projects.** PakOS scans the
project folders on your machine, reads their git state and markdown task
files, and turns them into one mobile-first dashboard: what's active,
what's dirty, what's shipping, and what needs you today.

Think of it as a personal JARVIS for a home-lab dev machine — opinionated
around how one person actually works, not a general-purpose tool.

- **Read-only by design (v0.1).** PakOS never writes to your
  repositories. No fetch, no commit, no push — it only looks.
- **Zero npm dependencies.** Node ≥ 22 stdlib only (`node:http`,
  `node:sqlite`). Nothing to install, no supply chain.
- **Local-first.** One process, one SQLite cache, no cloud. Remote access
  is your tailnet's problem (and Tailscale solves it well).
- **Everything is markdown + git.** The database is a disposable cache;
  the truth lives in files you can read and edit by hand.

## Concepts

| | |
|---|---|
| **Projects** | folders in `~/Projects` (or `$PAKOS_ROOT`), git-aware |
| **Missions** | tasks parsed from each project's markdown, shown as a board |
| **Progress** | done-ratios, dirty/ahead/behind, activity from real commits |
| **Daily Brief** | a computed summary of the last 24h across all projects |
| **Crew** | AI agents (Codex-first, Claude too) dispatched onto missions via markdown handoffs — human-triggered, two-step confirmed, never scheduled. Crew members, not the center of the app |
| **Usage** | Codex/Claude subscription usage from local files only — no OAuth, no cookies (SuperGrok has no API; shown as such) |

## Quickstart

```sh
git clone https://github.com/Pak209/Pakos.git PakOS
cd PakOS
node server.js          # requires Node >= 22
# → http://127.0.0.1:4180
```

To run it as an always-on macOS service and reach it from your phone over
Tailscale, see [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Giving PakOS missions

PakOS reads only these files per project: `TODO.md`, `ROADMAP.md`,
`README.md`, and `.pakos/*.md`.

```markdown
## In Progress
- [ ] Wire the live opportunity detail

## Ready
- [ ] Add offline mode

## Done
- [x] Auth flow refactor
```

- Headings choose the column: *Backlog/TODO/Planned · Ready/Next ·
  In Progress/WIP · Review/QA · Done/Shipped*.
- `- [x]` always means Done, wherever it appears.
- A trailing `@tag` (e.g. `… @codex`) assigns the mission to a crew
  member; it's stripped from the title. Mid-line mentions and emails
  are left alone.
- In `README.md`, only sections with a status-like heading are parsed —
  ordinary docs bullets never become missions.
- Full example: [`.pakos/board.md`](.pakos/board.md) in this repo.

## Repository layout

```
server.js            HTTP server + API (GET /api/state, POST /api/scan)
lib/scanner.js       read-only git collector
lib/tasks.js         markdown mission parser
lib/db.js            SQLite snapshot cache
public/index.html    the dashboard — one self-contained file, no build step
scripts/run_pakos.sh launchd entrypoint
.pakos/board.md      PakOS's own mission board (dogfooded)
docs/                architecture · design language · security · roadmap · operations
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — how the pieces fit, design rules
- [Design language](docs/DESIGN.md) — the "personal JARVIS" visual system
- [Security model](docs/SECURITY.md) — read this before widening the bind address
- [Roadmap](docs/ROADMAP.md) — v0.2 through v1.0
- [Operations](docs/OPERATIONS.md) — launchd, logs, Tailscale, recovery

## Philosophy

1. Function before visual effects.
2. Projects are the center; agents are crew.
3. Read-only until auth exists; writes only ever touch `.pakos/` files.
4. A dependency needs a reason the stdlib can't answer.
5. If the database dies, nothing of value is lost.

## Status

v0.1 — MVP. Running in production on one Mac mini, serving one human.
