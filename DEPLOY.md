# Deploying CC Commander end-to-end

This walks through a real three-machine deployment:

- **Hub** on a Linux VPS
- **Runner** on a Mac Mini at home
- **Client** (the macOS app) on your laptop

You can run all three on the same machine for testing — see the "Local
all-in-one" section at the bottom.

See [`SECURITY.md`](SECURITY.md) for the threat model before choosing
between the two deployment paths below.

---

## Recommended: Tailscale-only deployment (personal use)

This is the recommended deployment for personal / solo use. It is
significantly safer than exposing the hub on the public internet: the
hub is unreachable except from devices on your tailnet, which kills
mass scanning, credential stuffing, brute force, and any external
0-day against the hub's HTTP / WebSocket surface in one shot.

Residual risk after this deployment is concentrated in the supply
chain (GitHub, npm, the Claude Agent SDK). That is tracked separately
in [`SECURITY.md`](SECURITY.md).

### 1. Install Tailscale everywhere

- On the **hub VPS**: follow the Tailscale Linux instructions,
  `sudo tailscale up`, and note the resulting tailnet IP (e.g.
  `100.64.0.5`) and MagicDNS name (e.g. `hub.tail1234.ts.net`).
- On each **runner machine** (Mac Mini, MacBook, ...): install the
  Tailscale app (or `brew install --cask tailscale`), sign in, and
  confirm the device shows up in the admin console.
- On each **client device** (iPhone, Mac laptop, ...): install the
  Tailscale app from the App Store, sign in, and confirm it can ping
  the hub's tailnet IP.

### 2. Run the hub bound to the tailnet only

Two options, pick one.

**Option A (simplest): bind the container to the tailnet IP.**
Edit `hub/docker-compose.yml` and change the port mapping from
`127.0.0.1:3000:3000` to your tailnet IP, e.g. `100.64.0.5:3000:3000`.
Start the hub with `docker compose up -d`. Skip the reverse proxy
step in the alternative section entirely. No TLS, no public DNS, no
Caddy, no nginx. The hub is reachable only from devices on your
tailnet, over WireGuard.

**Option B (cleanest, with TLS): `tailscale serve`.** Leave the
compose file bound to `127.0.0.1:3000` and put Tailscale in front of
it:

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:3000
```

This gives you a real HTTPS endpoint at
`https://hub.tail1234.ts.net` with a free cert provisioned by
`tailscale cert`, reachable only from your tailnet. WebSocket
upgrades work out of the box. You do not need Caddy or nginx.

### 3. Point the client app at the hub's MagicDNS name

Use the MagicDNS name, not the raw tailnet IP, so the Tailscale cert
(option B) validates and so the URL keeps working if the VPS is
recreated.

```sh
# Option A, no TLS
defaults write com.cc-commander.app HubBaseURL http://hub.tail1234.ts.net:3000

# Option B, tailscale serve with TLS
defaults write com.cc-commander.app HubBaseURL https://hub.tail1234.ts.net
```

iOS: bake the URL into the build (see "Option B" under the macOS
client app section below) since there is no defaults trick for a
device build yet.

### 4. Register runners the same way, using the tailnet URL

```sh
node --experimental-strip-types src/cli.ts register \
    --hub https://hub.tail1234.ts.net \
    --email you@example.com \
    --name "mac-mini-living-room"
```

Everything else in the "Runner on a Mac" section below still applies.

### 5. Optional: lock it down with Tailscale ACLs

By default every device on your tailnet can talk to every other
device on every port. You can tighten this so that only your client
devices can reach the hub's port 443, and runners are only allowed
to egress to the hub (not to each other, not to clients). Edit your
tailnet policy in the Tailscale admin console:

```json
{
  "tagOwners": {
    "tag:hub":    ["autogroup:admin"],
    "tag:runner": ["autogroup:admin"],
    "tag:client": ["autogroup:admin"]
  },
  "acls": [
    { "action": "accept", "src": ["tag:client"], "dst": ["tag:hub:443"] },
    { "action": "accept", "src": ["tag:runner"], "dst": ["tag:hub:443"] }
  ]
}
```

Tag each device accordingly in the admin console. Clients can reach
the hub, runners can reach the hub, nothing else can reach anything.

### 6. Optional: enable tailnet lock

For the paranoid: turn on tailnet lock in the Tailscale admin console
so that new nodes joining your tailnet must be signed by an existing
trusted node. This prevents a compromised Tailscale control plane
from silently adding a new device to your tailnet.

---

## Alternative: public hub on a VPS (advanced)

> Warning: this path significantly increases attack surface. A public
> hub is exposed to mass scanning, credential stuffing, and any
> external 0-day against the hub's HTTP / WebSocket surface. Only use
> it if you know what you are doing, set a strong unique password, and
> are prepared to keep up with the hardening tracker in
> [`SECURITY.md`](SECURITY.md). For personal use, prefer the
> Tailscale-only deployment above.

## 1. Hub on a VPS

The hub is a Node.js HTTP/WebSocket server that stores accounts, machines,
and session metadata in SQLite.

### Requirements

- Linux VPS with Docker installed
- A domain you control, pointed at the VPS (e.g. `hub.example.com`)
- A reverse proxy that terminates TLS (Caddy, nginx + certbot, Traefik, ...)

### Build and run

```sh
# On the VPS
git clone https://github.com/EliasSchlie/cc-commander.git
cd cc-commander/hub

# Generate a JWT secret (>= 32 chars). Save it somewhere safe.
# (Append, don't clobber: a future .env may carry other vars.)
[ -f .env ] || touch .env
grep -q '^JWT_SECRET=' .env || echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env

# Pull the prebuilt image from GHCR and start. The :main tag is
# updated by .github/workflows/release.yml on every push to main.
# (For local dev where you want to build from source instead, run
# `docker compose up -d --build` -- the compose file carries both
# `image:` and `build:` for that case.)
docker compose pull
docker compose up -d

# Verify
curl -s http://localhost:3000/api/health
# → {"status":"ok"}
```

The compose file binds the container to `127.0.0.1:3000` so it is **not**
publicly reachable until you put a reverse proxy in front of it. SQLite is
persisted in the named volume `hub-data`.

### Updating: auto-deploy on push to main

`.github/workflows/release.yml` builds and pushes the hub image to GHCR
on every push to `main`, then SSHes into the VPS and rolls the
container forward. No manual step is required once the deploy secrets
are configured (see "Auto-deploy secrets" below).

If the auto-deploy job is disabled (no `DEPLOY_SSH_HOST` secret), or
you want to roll a deploy by hand on the VPS:

```sh
cd cc-commander/hub
git pull
docker compose pull
docker compose up -d
```

#### Auto-deploy secrets

Set these in **Repo Settings → Secrets → Actions**:

| Secret             | Notes                                                           |
| ------------------ | --------------------------------------------------------------- |
| `DEPLOY_SSH_HOST`  | VPS hostname. Presence of this secret enables the deploy job.   |
| `DEPLOY_SSH_USER`  | SSH user (e.g. `ccuser`)                                        |
| `DEPLOY_SSH_KEY`   | Private key. Pubkey lives in `~/.ssh/authorized_keys` on the VPS. |
| `DEPLOY_SSH_PORT`  | Optional, defaults to 22                                        |
| `DEPLOY_HUB_DIR`   | Optional, defaults to `~/cc-commander/hub`                      |

The deploy job runs `git fetch && git reset --hard origin/main` on the
VPS (only to refresh `docker-compose.yml` -- no source build happens
on the VPS), then `docker compose pull && docker compose up -d`, then
polls `https://$DEPLOY_SSH_HOST/api/version` until it reports the SHA
CI just built. If the verify step times out (~90s), the workflow
fails loudly so a stale rollout doesn't go unnoticed.

### How runners stay in sync with the hub

The hub bakes a `VERSION` (full git SHA) into the image and serves it
from `GET /api/version`. Each runner polls that endpoint every 5 minutes
(configurable via `CC_COMMANDER_POLL_MS`). When the runner's own
checked-out commit no longer matches the hub's `VERSION`, the runner
runs `runner/scripts/update.sh` **synchronously** (`git fetch && git
checkout origin/main && npm ci`), then exits and launchd restarts it
against the new code. Synchronous execution is load-bearing: the
previous detached approach raced launchd's restart and could leave a
half-updated checkout (PR #67). Logs land in
`~/Library/Logs/cc-commander-runner-update.log`.

So the deploy story is: **push to main → CI builds and SSH-deploys the
hub → every runner picks up the new code within 5 minutes**. No
per-runner intervention.

If the hub's `VERSION` is empty (e.g. local dev hub), runners skip the
self-update protocol entirely.

### One-time migration: pre-workspace runner hosts

If you installed a runner **before** the protocol-extraction
refactor (PR #42), your local clone has `runner/package-lock.json`
and a `runner/node_modules/` directory. The first self-update against
post-#42 main will fail because the new `runner/scripts/update.sh`
expects to install at the workspace root.

On each runner host, run **once** after pulling the new tree:

```sh
cd cc-commander
git pull
rm -f runner/package-lock.json
rm -rf runner/node_modules hub/node_modules
npm install
launchctl unload ~/Library/LaunchAgents/com.cc-commander.runner.plist
launchctl load   ~/Library/LaunchAgents/com.cc-commander.runner.plist
```

After that one manual step, future self-updates work normally.

### Reverse proxy (Caddy example)

Caddy is the easiest because it gets TLS automatically:

```caddy
hub.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

That's the entire config. Caddy will fetch a Let's Encrypt cert on first
request and proxy WebSocket upgrades transparently.

### nginx example

```nginx
server {
    listen 443 ssl http2;
    server_name hub.example.com;

    ssl_certificate     /etc/letsencrypt/live/hub.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hub.example.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # WebSocket upgrade for /ws/client and /ws/runner
        proxy_set_header   Upgrade           $http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

### Hub environment variables

| Var            | Default      | Notes                                                  |
| -------------- | ------------ | ------------------------------------------------------ |
| `PORT`         | `3000`       | HTTP port the hub listens on                           |
| `HUB_DB_PATH`  | `./hub.db`   | SQLite path. The Docker image uses `/data/hub.db`.     |
| `JWT_SECRET`   | *(required)* | ≥32 chars. Generate with `openssl rand -hex 32`.       |

---

## 2. Create your account

The hub has no admin UI yet. Create the first account with curl:

```sh
curl -X POST https://hub.example.com/api/auth/register \
    -H 'Content-Type: application/json' \
    -d '{"email":"you@example.com","password":"<a long password>"}'
```

You'll get back `{"token": "...", "refreshToken": "..."}`. You don't need
to save these — the runner CLI and the macOS app will both prompt for your
email/password when they need to log in.

---

## 3. Runner on a Mac (Mac Mini, MacBook, ...)

The runner is a small Node.js process that holds an outbound WebSocket to
the hub and runs Claude Code sessions on demand using the Claude Agent SDK.

### Requirements

- macOS
- Node.js ≥ 22 (`brew install node`)
- A Claude API key (or Claude Code already authenticated for the user
  the runner runs as — the SDK uses whatever credentials it finds)

### Install

```sh
git clone https://github.com/EliasSchlie/cc-commander.git
cd cc-commander
# npm workspaces: install at the repo root. This populates a single
# node_modules at the root that the runner picks up via standard
# Node.js module resolution.
npm install
cd runner
```

### Register the machine with the hub

```sh
node --experimental-strip-types src/cli.ts register \
    --hub https://hub.example.com \
    --email you@example.com \
    --name "mac-mini-living-room"
# (you'll be prompted for the hub password)
```

This logs into the hub, creates a machine row, and writes the registration
token to `~/.config/cc-commander/runner.json` (mode 0600). Override the
location with `--config <path>` or the `CC_COMMANDER_CONFIG` env var if
you want to run multiple runners on one host.

### Run it once to sanity-check

```sh
node --experimental-strip-types src/cli.ts run
# [runner] starting "mac-mini-living-room" → wss://hub.example.com (config=...)
# [runner] Connected to hub as "mac-mini-living-room"
```

Ctrl-C to stop. If that worked, install it as a launchd agent so it
starts on login and restarts on crash:

```sh
./launchd/install.sh
```

That writes `~/Library/LaunchAgents/com.cc-commander.runner.plist`,
loads it with launchctl, and points its logs at
`~/Library/Logs/cc-commander-runner.log`. To stop or restart later:

```sh
launchctl unload ~/Library/LaunchAgents/com.cc-commander.runner.plist
launchctl load   ~/Library/LaunchAgents/com.cc-commander.runner.plist
```

---

## 4. The macOS client app

Open `client/swift/CCCommander.xcodeproj` in Xcode and build the
`CCCommander_macOS` scheme. Drag the resulting `.app` into `/Applications`.

By default the **Release** build points at `https://hub.cc-commander.com`,
which probably isn't where you deployed. Two ways to override:

**Option A — runtime override (no rebuild):**

```sh
defaults write com.cc-commander.app HubBaseURL https://hub.example.com
# launch the app — it will use the new URL.
# revert with:
defaults delete com.cc-commander.app HubBaseURL
```

**Option B — bake it into the build:**

Edit `client/swift/project.yml` (or open the project in Xcode → target
`CCCommander_macOS` → Build Settings → search `HUB_BASE_URL`) and set the
**Release** value to your hub URL. Rebuild.

The same `defaults write` trick works on iOS via `xcrun simctl spawn` for
the simulator; for a device build you need to bake the URL in (option B)
or add a settings screen.

---

## 5. Local all-in-one (for testing)

```sh
# terminal 0 — install workspace deps once at the repo root
npm install

# terminal 1 — hub
cd hub && JWT_SECRET=$(openssl rand -hex 32) HUB_DB_PATH=:memory: npm start

# terminal 2 — make an account + register the runner
curl -s -X POST http://localhost:3000/api/auth/register \
    -H 'Content-Type: application/json' \
    -d '{"email":"dev@local","password":"devdevdevdevdev"}' >/dev/null

cd runner
node --experimental-strip-types src/cli.ts register \
    --hub http://localhost:3000 \
    --email dev@local \
    --password devdevdevdevdev \
    --name laptop-dev

# terminal 3 — runner
cd runner && node --experimental-strip-types src/cli.ts run

# terminal 4 — open the macOS app from Xcode (Debug config defaults to localhost:3000)
# log in with dev@local / devdevdevdevdev
```

---

## Troubleshooting

**Runner says "Invalid registration token".** The hub's SQLite was wiped
(or the machine row was deleted). Re-run `register` to create a new one.

**Client can connect via the proxy but WebSockets fail.** Your reverse
proxy is missing the `Upgrade`/`Connection` headers (see the nginx block
above). Caddy handles this automatically.

**Sessions immediately move to `error: Runner disconnected`.** The runner
WebSocket dropped after connecting. Check the runner log
(`~/Library/Logs/cc-commander-runner.log`) — usually a network blip or
the runner process being killed. The hub intentionally errors live
sessions on runner disconnect; they don't auto-resume yet (tracked in
issue #18).

**Client app keeps using the old hub URL.** You changed `project.yml`
but didn't rebuild — or you have a stale `defaults write` override. Run
`defaults read com.cc-commander.app HubBaseURL` to check.
