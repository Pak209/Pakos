# Operations

Generic runbook. Machine-specific values (IPs, hostnames) belong in your
local, gitignored `CHECKPOINT.md`.

## Run manually

```sh
cd PakOS && node server.js        # http://127.0.0.1:4180
```

## Run as a macOS service (launchd)

Copy `scripts/run_pakos.sh`-based agent (see the plist template below) to
`~/Library/LaunchAgents/com.pakos.dashboard.plist`, then:

```sh
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.pakos.dashboard.plist
launchctl kickstart -k gui/$UID/com.pakos.dashboard   # restart
launchctl bootout   gui/$UID/com.pakos.dashboard      # stop
launchctl list | grep pakos                           # status
```

Plist essentials: `ProgramArguments` → `/bin/zsh scripts/run_pakos.sh`,
`RunAtLoad` + `KeepAlive` true, `ThrottleInterval` 10,
`StandardOut/ErrorPath` → `logs/pakos.{out,err}.log`.
`scripts/run_pakos.sh` resolves node through nvm, so launchd's bare
environment and future node upgrades are handled.

## Logs

- `logs/pakos.out.log` — scans, requests of note, startup banner
- `logs/pakos.err.log` — failures (should stay empty)

## Remote access

**Cloudflare Tunnel (any device, browser login)** — the primary path:
`scripts/setup_tunnel.sh pakos.pak-labs.com`, then add the Access policy.
Full runbook: [docs/REMOTE.md](REMOTE.md). PakOS keeps binding loopback.

**Tailscale (tailnet devices)** — still works in parallel:

1. Add to the plist's `EnvironmentVariables`:
   `<key>PAKOS_HOST</key><string>YOUR_TAILSCALE_IP</string>`
2. `launchctl kickstart -k gui/$UID/com.pakos.dashboard`
3. Open `http://<machine-tailnet-name>:4180` from any tailnet device.

Never bind `0.0.0.0` — GET routes rely on the perimeter (see docs/SECURITY.md).

## Auth token

Non-GET routes require the bearer token from `~/.pakos/config.json`
(created on first run, mode 0600). View it with `cat ~/.pakos/config.json`;
the dashboard asks for it once and keeps it in the browser's localStorage.
Rotate by editing the file and restarting the service.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PAKOS_ROOT` | `~/Projects` | directory to scan |
| `PAKOS_HOST` | `127.0.0.1` | bind address |
| `PAKOS_PORT` | `4180` | HTTP port |
| `PAKOS_SCAN_INTERVAL` | `300` | auto-rescan seconds |
| `PAKOS_DB` | `data/pakos.sqlite3` | SQLite path |
| `PAKOS_CONFIG_DIR` | `~/.pakos` | config dir (config.json) |

## Recovery

| Problem | Fix |
|---|---|
| Port in use | `lsof -nP -iTCP:4180 -sTCP:LISTEN` — kill the exact PID |
| Stale/broken data | stop service, delete `data/`, start (full rescan) |
| Service won't start | `tail logs/pakos.err.log`; check node ≥ 22 via `scripts/run_pakos.sh` output |
| Remove everything | bootout + delete plist + delete the PakOS folder |
