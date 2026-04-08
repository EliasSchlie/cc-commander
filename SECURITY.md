# Security

CC Commander gives Claude full shell access on every machine where a runner
is installed. A valid hub JWT is, functionally, an SSH key to all of your
linked machines. The runner launches Claude with `permissionMode:
"bypassPermissions"` and `allowDangerouslySkipPermissions: true`. This is
intentional (yolo mode is the whole point), but it means the security of
your machines collapses to the security of your hub account.

The trust level is simple: if you can authenticate to the hub, you can run
any command on any runner attached to that account.

## Who this is for

Solo developers willing to self-host. One person, their own hub, their own
runners.

It is **not** recommended as a multi-tenant hosted service, and it is
**not** suitable for shared or corporate environments without significant
additional hardening that is out of scope for this project.

If you are not comfortable running something that has SSH-equivalent
authority over your machines, do not run CC Commander.

## What we defend against

- **Mass internet scanning and credential stuffing.** Primary defense:
  the recommended deployment keeps the hub on a Tailscale-only VPS with
  no public DNS and no reverse proxy, so scanners cannot reach it at all.
  See the "Recommended: Tailscale-only deployment" section in
  [`DEPLOY.md`](DEPLOY.md).
- **Brute force on hub login.** Defense: rate limiting on
  `/api/auth/login`. Hardware-key 2FA is planned (see tracker issues
  below).
- **Stolen long-lived runner registration tokens.** Current defense: the
  token file is written mode `0600` under `~/.config/cc-commander/`, and
  compromise is contained to one machine because each runner has its own
  token. Rotation and short-lived tokens are planned.
- **Supply chain compromise via npm install scripts.** Planned defense:
  `npm ci --ignore-scripts` in the runner self-update path, tracked in
  the hardening issues below.
- **GitHub maintainer account compromise leading to a malicious update
  rolling out to runners.** Planned defense: signed git tags (hardware
  key), plus manual operator approval for runner self-updates. Tracked
  below.

## What we explicitly do NOT defend against

- **The yolo runner itself.** Once a session starts, Claude can run any
  command the runner user can run. This is by design. Do not install a
  runner under a user account you are not willing to give away.
- **Prompt injection of Claude.** Same risk profile as running Claude
  Code locally: a hostile repo, a hostile web page pulled into context,
  or a hostile MCP server can steer the session. CC Commander does not
  add or remove that risk.
- **Physical access to an unlocked client device.** If your phone is
  unlocked and in someone else's hand, they have your hub.
- **State-level adversaries** with the ability to MITM Tailscale's
  control plane, compromise GitHub at the platform level, or subvert
  the Claude Agent SDK upstream. These are explicitly out of scope.

## Recommended deployment (for the maintainer)

The deployment the maintainer actually uses, and the one you should use
if you self-host:

- Hub on a Tailscale-only VPS. No public DNS record for the hub, no
  Caddy / nginx / Traefik, no port 443 exposed to the internet. The
  full walkthrough is in [`DEPLOY.md`](DEPLOY.md) under "Recommended:
  Tailscale-only deployment".
- Strong, unique hub password. Long (20+ chars) and stored in a
  password manager, not reused anywhere else.
- Runners installed only under user accounts you would be willing to
  hand an attacker.
- Once it lands: hardware-key (Yubikey) signed git tags, with runner
  self-update verifying signatures before applying.
- Once it lands: `npm ci --ignore-scripts` in the runner self-update
  path, so a malicious dep cannot execute during install.
- Once it lands: manual operator approval for runner self-updates
  (push notification to the client app, operator taps "apply").

Until those hardening items land, the supply chain (GitHub, npm, the
Claude Agent SDK) is where the concentrated residual risk lives. Treat
it accordingly.

## Reporting vulnerabilities

Email `security@TODO` (maintainer: replace this placeholder with a real
address before publishing). Please do not file public issues for
vulnerabilities that would let an attacker reach a runner.

There is no bug bounty. This is a personal project, maintained
best-effort. Response times are whatever the maintainer can manage
around a day job. Thank you for reporting anyway.

## Known limitations and unfixed risks

These are tracked as issues in the hardening tracker. Numbers below are
placeholders that the maintainer will replace with real issue numbers.

- `#TODO-tailscale`: document and default to Tailscale-only deployment
  (partially addressed by this file and `DEPLOY.md`).
- `#TODO-signed-tags`: hardware-key signed git tags, with runner-side
  signature verification before self-update.
- `#TODO-ignore-scripts`: switch the runner self-update to `npm ci
  --ignore-scripts`, audit which packages actually need postinstall.
- `#TODO-manual-update-approval`: require explicit operator approval
  in the client app before a runner applies a pending self-update.
- `#TODO-token-rotation`: short-lived registration tokens with
  rotation, so a stolen `runner.json` expires on its own.
- `#TODO-2fa`: hardware-key 2FA on hub login.

If you find a hardening gap that is not on this list, please report it
(see above).
