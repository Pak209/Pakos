# Remote access — pakos.pak-labs.com

How PakOS is reached from any device without opening a port or widening the
bind address: a Cloudflare Tunnel runs on the same machine as PakOS and
connects **outbound** to Cloudflare; Cloudflare Access sits in front and
demands a login before a single byte reaches the tunnel.

```
[phone / laptop] ──HTTPS──▶ Cloudflare edge ──▶ Access (email allowlist)
                                   │ tunnel (outbound from the Mac)
                                   ▼
                        cloudflared ──▶ http://127.0.0.1:4180 (PakOS)
```

Two independent layers:

1. **Cloudflare Access (identity, at the edge).** Only the allowlisted email
   can load any page. Everyone else never reaches this machine.
2. **PakOS bearer token (capability, at the server).** Every non-GET route
   additionally requires the token from `~/.pakos/config.json` — so even a
   logged-in browser session can't write without it, and a misconfigured
   tunnel doesn't expose writes.

PakOS itself keeps binding `127.0.0.1`. Nothing in this setup changes
`PAKOS_HOST`; the SECURITY.md rule "never bind 0.0.0.0" still stands.

## Setup (run on the machine that serves PakOS)

Prereqs: the `pak-labs.com` zone on this Cloudflare account (it is), Homebrew.

### Step 1 — Access policy FIRST (mandatory, Cloudflare dashboard)

**Do not create the tunnel before this exists.** The Access application can
be defined before any DNS record, and doing it first means the hostname is
identity-gated from the very first second it resolves. A tunnel without
this policy is a public URL straight to your dashboard.

1. [one.dash.cloudflare.com](https://one.dash.cloudflare.com) → Access → Applications → **Add an application** → Self-hosted.
2. Application domain: `pakos.pak-labs.com` (all paths). Session duration: 1 week.
3. Policy: name `owner-only`, action **Allow**, include → Emails →
   `dankimoto8@gmail.com`. No other includes. Save.
4. (Optional) Login methods: keep One-time PIN, or add Google so it's one tap.

### Step 2 — Tunnel

```sh
scripts/setup_tunnel.sh pakos.pak-labs.com
```

The script is idempotent, confirms you did Step 1 before routing DNS, and
performs:

1. `brew install cloudflared` (if missing)
2. `cloudflared tunnel login` — one browser approval, pick the pak-labs.com zone
3. `cloudflared tunnel create pakos` (if missing)
4. `cloudflared tunnel route dns pakos pakos.pak-labs.com`
5. writes `~/.cloudflared/config.yml` → ingress `pakos.pak-labs.com → http://127.0.0.1:4180`
6. `sudo cloudflared service install` — starts now and at boot

### Step 3 — Verify

- Open https://pakos.pak-labs.com from a phone **off** your WiFi — you must
  hit the Access login before anything else renders.
- A different email must be rejected at the edge.
- After login the dashboard loads and Rescan asks for the PakOS token once.
- `curl -sI https://pakos.pak-labs.com` from anywhere should return a
  Cloudflare Access redirect (302 to the login page), never PakOS content.

## Sign in with Google (no more token pasting)

Once `access` is configured in `~/.pakos/config.json`, the Google login you
do at the Cloudflare edge IS the write credential: PakOS verifies the
signed identity (`Cf-Access-Jwt-Assertion`, RS256 against the team's
published keys — `lib/access.js`) on every write, checks the email against
an allowlist, and the UI never asks for a token. The bearer token remains
the bootstrap/admin fallback for loopback, Tailscale, and scripts.
Cloudflare manages the session cookie (httpOnly/Secure); PakOS stores no
sessions and no OAuth secrets.

### One-time setup

1. **Google as a login method** (Zero Trust dashboard → Settings →
   Authentication → Login methods → Add new → Google):
   - In [Google Cloud Console](https://console.cloud.google.com) → APIs &
     Services → Credentials → Create OAuth client ID (Web application).
   - Authorized redirect URI: `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`
   - Paste the client ID + secret into the Cloudflare form. (These live in
     Cloudflare, never in PakOS.)
2. **Session length**: Access → Applications → the PakOS app → session
   duration → **1 month** (Cloudflare's maximum). Enable Google in the
   app's login methods; keep One-time PIN as backup.
3. **Aud tag**: same app page → Overview → copy the Application Audience
   (AUD) tag.
4. **Server config** — add to `~/.pakos/config.json` and restart PakOS:

```json
"access": {
  "teamDomain": "<team>.cloudflareaccess.com",
  "audTag": "<the 64-hex AUD tag>",
  "allowedEmails": ["you@example.com"]
}
```

### Behavior and guarantees

- Writes via Access identity are audited under the verified email; the
  raw edge headers are never trusted without signature verification.
- Cookie-derived writes require a same-host `Origin` (CSRF guard).
- **Logout**: drawer → Sign out (`/cdn-cgi/access/logout` on the team
  domain). **Revoke a session**: Zero Trust → My Team → Users → Revoke —
  enforced at the edge immediately.
- Sessions last up to 1 month; re-auth is one Google/Face ID tap.
- If verification is unconfigured or fails, behavior is exactly the
  token-only model — the JWT path never fails open.

## Operations

- Status: `sudo launchctl list | grep cloudflared` · `cloudflared tunnel info pakos`
- Logs: `/Library/Logs/com.cloudflare.cloudflared.err.log`
- Tailscale continues to work in parallel (`docs/OPERATIONS.md`), and
  localhost on the machine itself is always available.

## Rollback

**Kill remote exposure now (seconds, reversible):**

```sh
sudo launchctl bootout system/com.cloudflare.cloudflared
```

The hostname stops resolving to anything live; PakOS itself is untouched
(still on 127.0.0.1 and Tailscale). Bring it back with
`sudo launchctl bootstrap system /Library/LaunchDaemons/com.cloudflare.cloudflared.plist`.

**Remove the tunnel entirely:**

```sh
sudo cloudflared service uninstall
cloudflared tunnel delete pakos          # also removes its credentials file
```

Then delete the `pakos` CNAME record (Cloudflare dashboard → DNS) and,
optionally, the Access application. `~/.cloudflared/` can be deleted too.

**Revert the v0.2 auth change itself:**

```sh
git revert <merge-commit> && launchctl kickstart -k gui/$UID/com.pakos.dashboard
```

Nothing else to clean: the token lives only in `~/.pakos/config.json`
(delete it if you like — it is regenerated on next v0.2 start), the audit
trail is `data/audit.log` (plain text, disposable), and the browser copy of
the token sits in localStorage where a stale value is simply ignored by
v0.1. No schema or data migrations are involved.
