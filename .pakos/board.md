# PakOS Mission Board

Any repo can have a `.pakos/*.md` file like this one. Headings set the
board column; `- [x]` items are always Done. A trailing `@tag` assigns a
crew member (`- [ ] Fix the scanner @codex`).

## In Progress

- [ ] v0.2 rollout on the production Mac mini (tunnel + Access policy)

## Ready

- [ ] Per-project detail view (tap a project card) — v0.3
- [ ] Daily Brief generator (markdown digest of last 24h) — v0.3

## Backlog

- [ ] GitHub PR/issue/CI awareness (v0.3)
- [ ] Mission write-back: move between columns via .pakos/board.md edit (v0.4)
- [ ] Verify Cf-Access-Jwt-Assertion server-side, stdlib RS256 (v0.4)
- [ ] Crew panel v2: last-touched, handoffs awaiting pickup (v0.5)
- [ ] Whitelisted local automation runner (v0.6)
- [ ] System log viewer
- [ ] Opt-in git fetch for true ahead/behind

## Done

- [x] Zero-dependency server with node:sqlite
- [x] Read-only git scanner for $PAKOS_ROOT
- [x] Markdown mission parser (TODO.md, ROADMAP.md, README.md, .pakos/)
- [x] Mobile-first dashboard
- [x] launchd agent (com.pakos.dashboard) with KeepAlive
- [x] JARVIS design language (docs/DESIGN.md) applied to the UI
- [x] Production repo structure + docs for contributors
- [x] First public commit to Pak209/Pakos
- [x] Bearer auth + audit log; token generated into ~/.pakos/config.json (v0.2)
- [x] Cloudflare Tunnel + Access runbook for pakos.pak-labs.com (v0.2)
- [x] AI usage panel: codex exact, claude estimate, no secrets touched (v0.2)
- [x] Crew dispatch: preview→confirm gate, handoff files, run log + cancel (v0.2)
- [x] Board spec v1: trailing @owner tag on missions (v0.2)
