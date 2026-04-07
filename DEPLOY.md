# Deploying CC Commander end-to-end

This walks through a real three-machine deployment:

- **Hub** on a Linux VPS
- **Runner** on a Mac Mini at home
- **Client** (the macOS app) on your laptop

You can run all three on the same machine for testing — see the "Local
all-in-one" section at the bottom.

---

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
export JWT_SECRET=$(openssl rand -hex 32)

# Build + start
docker compose up -d --build

# Verify
curl -s http://localhost:3000/api/health
# → {"status":"ok"}
```

The compose file binds the container to `127.0.0.1:3000` so it is **not**
publicly reachable until you put a reverse proxy in front of it. SQLite is
persisted in the named volume `hub-data`.

To upgrade later:

```sh
git pull
JWT_SECRET=... docker compose up -d --build
```

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
cd cc-commander/runner
npm install
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
# terminal 1 — hub
cd hub && JWT_SECRET=$(openssl rand -hex 32) HUB_DB_PATH=:memory: npm start

# terminal 2 — make an account + register the runner
curl -s -X POST http://localhost:3000/api/auth/register \
    -H 'Content-Type: application/json' \
    -d '{"email":"dev@local","password":"devdevdevdevdev"}' >/dev/null

cd runner && npm install
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
