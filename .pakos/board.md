# PakOS Mission Board

Any repo can have a `.pakos/*.md` file like this one. Headings set the
board column; `- [x]` items are always Done.

## In Progress

- [ ] First public commit to Pak209/Pakos (awaiting approval)

## Ready

- [ ] Per-project detail view (tap a project card)
- [ ] Daily Brief generator (markdown digest of last 24h)

## Backlog

- [ ] GitHub PR/issue/CI awareness (v0.3)
- [ ] Auth token, then mission write-back to .pakos/board.md (v0.4)
- [ ] Crew handoffs: .pakos/handoff-*.md convention (v0.5)
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
