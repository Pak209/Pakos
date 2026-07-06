# Contributing

PakOS is a personal tool that happens to be public. Issues and PRs are
welcome, but the philosophy is fixed (see README): projects at the
center, read-only until auth, zero dependencies, markdown as truth.

## Ground rules

- **No new npm dependencies** without a written reason the Node stdlib
  can't do it.
- **No writes to scanned repositories.** Ever. Write features may only
  touch `.pakos/` files, behind auth (v0.4+).
- **No build step.** `public/index.html` stays a single self-contained
  file; `node server.js` must be the entire setup.
- Match the design language in `docs/DESIGN.md` for any UI change.

## Dev loop

```sh
node server.js                # run
curl -s localhost:4180/api/state | head -c 400   # inspect the snapshot
node --test                   # tests (once they exist — see roadmap)
```

## Branching

- `main` is always runnable.
- Work on `feat/<topic>`, `fix/<topic>`, or `docs/<topic>` branches;
  merge to `main` via PR (squash preferred, imperative commit subjects).
- Version tags: `v0.x.y` on `main` when a roadmap milestone lands.
