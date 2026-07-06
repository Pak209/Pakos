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

```sh
scripts/setup_tunnel.sh pakos.pak-labs.com
```

The script is idempotent and stops to tell you what it needs. It performs:

1. `brew install cloudflared` (if missing)
2. `cloudflared tunnel login` — one browser approval, pick the pak-labs.com zone
3. `cloudflared tunnel create pakos` (if missing)
4. `cloudflared tunnel route dns pakos pakos.pak-labs.com`
5. writes `~/.cloudflared/config.yml` → ingress `pakos.pak-labs.com → http://127.0.0.1:4180`
6. `sudo cloudflared service install` — starts now and at boot

## Access policy (one-time, Cloudflare dashboard)

Until this step is done the hostname is reachable by anyone — do it
immediately after the script:

1. [one.dash.cloudflare.com](https://one.dash.cloudflare.com) → Access → Applications → **Add an application** → Self-hosted.
2. Application domain: `pakos.pak-labs.com` (all paths). Session duration: 1 week.
3. Policy: name `owner-only`, action **Allow**, include → Emails →
   `dankimoto8@gmail.com`. No other includes. Save.
4. (Optional) Login methods: keep One-time PIN, or add Google so it's one tap.

Verify: open https://pakos.pak-labs.com from a phone **off** your WiFi — you
must hit the Access login; a different email must be rejected; after login the
dashboard loads and Rescan asks for the PakOS token once.

## Operations

- Status: `sudo launchctl list | grep cloudflared` · `cloudflared tunnel info pakos`
- Logs: `/Library/Logs/com.cloudflare.cloudflared.err.log`
- Uninstall: `sudo cloudflared service uninstall`; delete the Access app in
  the dashboard; `cloudflared tunnel delete pakos`.
- Tailscale continues to work in parallel (`docs/OPERATIONS.md`), and
  localhost on the machine itself is always available.
