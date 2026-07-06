# Security Model

PakOS runs with the same privileges as your user account and reads real
repositories, so its security posture is deliberately conservative.

## Threat model

Assets: your source code, git metadata, task lists, and the machine
itself. Adversaries considered: anything on your network (if you widen
the bind address), malicious content inside scanned repos (a repo you
cloned could contain hostile markdown/filenames), and supply chain.

## Guarantees (v0.1)

1. **Read-only against repositories.** The full set of executed git
   commands: `branch`, `status --porcelain`, `rev-list`, `remote get-url`,
   `log`. All run via `execFile` (argv array, no shell) with fixed
   arguments and an 8s timeout. There is no code path that writes to a
   scanned repo — no fetch, pull, commit, push, or checkout.
2. **Loopback by default.** Binds `127.0.0.1` unless `PAKOS_HOST` is set.
   Remote access is expected to go over Tailscale (WireGuard, tailnet-only).
   **There is no auth layer yet — never bind `0.0.0.0`.**
3. **No secrets touched.** `.env` files are never read. Remote URLs are
   stripped of embedded credentials (`https://user:token@…`) before they
   reach the database or a browser. Dotfiles are never served.
4. **Bounded parsing of untrusted input.** Task files are size-capped
   (256 KB), parsed line-by-line with regex (no markdown engine, no HTML
   rendering of file content server-side), and all strings are
   HTML-escaped client-side before insertion into the DOM.
5. **Traversal-guarded static serving.** Resolved paths must stay inside
   `public/`; anything else is a 404. Non-GET methods (except
   `POST /api/scan`) return 405.
6. **Zero npm dependencies.** The supply chain is Node itself.

## Known gaps (tracked in the roadmap)

- No authentication or rate limiting — acceptable only while
  loopback/tailnet-bound. Ships before any write endpoint (v0.4).
- `POST /api/scan` is unauthenticated; worst case is wasted CPU
  (scan is throttled to one at a time).
- No CSRF protection — irrelevant while read-only, mandatory with writes.
- SQLite in Node 22 is flagged experimental upstream.

## Operational rules

- Machine-specific runbooks (IPs, hostnames) live in `CHECKPOINT.md`,
  which is gitignored — the public repo never contains network details.
- If you fork/deploy this: review what `$PAKOS_ROOT` will expose before
  widening the bind address. The dashboard shows real branch names,
  commit subjects, and file names.
