# Security Model

PakOS runs with the same privileges as your user account and reads real
repositories, so its security posture is deliberately conservative.

## Threat model

Assets: your source code, git metadata, task lists, and the machine
itself. Adversaries considered: anything on your network (if you widen
the bind address), malicious content inside scanned repos (a repo you
cloned could contain hostile markdown/filenames), and supply chain.

## Guarantees (v0.2)

1. **Read-only against repository content.** The full set of executed git
   commands: `branch`, `status --porcelain`, `rev-list`, `remote get-url`,
   `log`, `for-each-ref`. All run via `execFile` (argv array, no shell)
   with fixed arguments and an 8s timeout. There is no code path that
   writes to a scanned repo's code or git state — no fetch, pull, commit,
   push, or checkout. The single exception is `lib/board.js`, the only
   module allowed to write into a project, and only to `.pakos/*.md`
   board files: project names must be direct children of the root (no
   separators, no dotfiles), the source path must match `.pakos/*.md`
   exactly, writes are atomic (temp + rename), and moves are verified
   against the caller's view of the line (409 on mismatch) so concurrent
   hand-edits can't be clobbered. Mission writes require the bearer token
   and land in the audit log like every other write.
2. **Loopback by default.** Binds `127.0.0.1` unless `PAKOS_HOST` is set.
   Remote access goes over Tailscale (WireGuard, tailnet-only) or a
   Cloudflare Tunnel fronted by Cloudflare Access (docs/REMOTE.md) — both
   connect to loopback locally. **Never bind `0.0.0.0`**: GET routes carry
   no auth of their own; keeping them unreachable except via loopback,
   tailnet, or the Access-gated tunnel is the perimeter.
3. **Writes require a bearer token.** Every non-GET route demands
   `Authorization: Bearer <authToken>` (constant-time compare) from
   `~/.pakos/config.json` — a 0600 file generated on first run, never
   hardcoded, never served, never echoed by any endpoint. Each
   authenticated write is appended to `data/audit.log` together with the
   `Cf-Access-Authenticated-User-Email` header when the edge provides one.
4. **No secrets touched.** `.env` files are never read. Remote URLs are
   stripped of embedded credentials (`https://user:token@…`) before they
   reach the database or a browser. Dotfiles are never served. The only
   secret PakOS holds is its own config file above.
5. **Bounded parsing of untrusted input.** Task files are size-capped
   (256 KB), parsed line-by-line with regex (no markdown engine, no HTML
   rendering of file content server-side), and all strings are
   HTML-escaped client-side before insertion into the DOM.
6. **Traversal-guarded static serving.** Resolved paths must stay inside
   `public/`; anything else is a 404. Unknown non-GET methods return 405.
7. **Zero npm dependencies.** The supply chain is Node itself.

## Recommendations (v0.2.x)

Recommendation records are proposals only. Accepting one is an auth'd,
audited write that flows through the same `lib/board.js` guards as any
manual move; rejecting appends to that project's `.pakos/rejected.md`
(the only new write, `.pakos/`-confined). Reconciliation runs are fixed
read-only analyze templates; their JSON output is validated against the
actual board (title/status/source checks) before a record is created, so
a hallucinating agent cannot invent moves for missions that don't exist.

## Known gaps (tracked in the roadmap)

- GET routes have no auth of their own — the perimeter (loopback / tailnet
  / Access-gated tunnel) is what protects reads. Rate limiting: none.
- The `Cf-Access-Jwt-Assertion` header is not cryptographically verified
  server-side (stdlib RS256 verification is a planned hardening); identity
  enforcement happens at the Cloudflare edge.
- CSRF: the bearer token lives in `localStorage` and is attached
  explicitly per request (never a cookie), so classic CSRF doesn't apply;
  revisit if cookie-based sessions are ever added.
- SQLite in Node 22 is flagged experimental upstream.

## Operational rules

- Machine-specific runbooks (IPs, hostnames) live in `CHECKPOINT.md`,
  which is gitignored — the public repo never contains network details.
- If you fork/deploy this: review what `$PAKOS_ROOT` will expose before
  widening the bind address. The dashboard shows real branch names,
  commit subjects, and file names.
