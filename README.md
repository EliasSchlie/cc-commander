# CC Commander

> Control Claude Code sessions across all your machines, from any device.

CC Commander lets you create, manage, and interact with Claude Code sessions on any of your machines -- from your phone, your laptop, or a browser. Sessions run on the machines where your code lives. CC Commander is the remote control.

## Concepts

- **Client** -- something you use to interact with sessions (phone, laptop, browser tab). Runs the CC Commander app.
- **Runner** -- a small process on a machine where Claude Code sessions actually execute. Connects outbound to the hub.
- **Hub** -- a central server that all clients and runners connect to. Routes messages, manages accounts, keeps state in sync.
- **Account** -- a collection of clients and runners. Clients on the same account see the same sessions on that account's machines.

A MacBook can be both a client and a runner. A phone is only a client. A VPS is only a runner.

```
[iPhone]  ───┐                    ┌─── [MacBook runner]
[MacBook] ───┼─── Hub (VPS) ──────┼─── [VPS runner]
[Web]     ───┘                    └─── [Mac Mini runner]
```

## Components

- [`client/SPEC.md`](client/SPEC.md) -- the app you use (iOS, macOS, web)
- [`runner/SPEC.md`](runner/SPEC.md) -- the process that runs Claude Code sessions on each machine
- [`hub/SPEC.md`](hub/SPEC.md) -- the central server

## Running it

See [`DEPLOY.md`](DEPLOY.md) for an end-to-end guide: hub on a VPS,
runner on a Mac, client app on your laptop. There's also a
"local all-in-one" section if you just want to try it on one machine.

See [`SECURITY.md`](SECURITY.md) for the threat model and recommended deployment.

## Repository

Monorepo. Each component builds, tests, and deploys independently. They share no runtime code -- they communicate only over the network.

```
client/
  SPEC.md
  swift/    # iOS + macOS app
  web/      # browser client (later)
  cli/      # CLI client (later)
runner/
  SPEC.md
  src/
hub/
  SPEC.md
  src/
```
