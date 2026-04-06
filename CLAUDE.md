# CC Commander

Remote control for Claude Code sessions across machines.

## Architecture

Monorepo with 3 packages:
- `packages/shared` -- Protocol types shared between all components
- `packages/hub` -- Central server (WebSocket + SQLite)
- `packages/agent` -- Machine agent (connects to hub, runs Claude SDK)

## Development

```bash
npm install              # Install all dependencies
npm test                 # Run all tests

# Type-check (doesn't emit, allows .ts imports in tests)
npx tsc -p packages/shared/tsconfig.check.json
npx tsc -p packages/hub/tsconfig.check.json
npx tsc -p packages/agent/tsconfig.check.json
```

Tests use Node's built-in test runner with `--experimental-strip-types`.

## Running

```bash
# Hub
JWT_SECRET=your-secret PORT=8080 node --experimental-strip-types packages/hub/src/cli.ts

# Agent
CC_HUB_URL=ws://localhost:8080 CC_TOKEN=<registration-token> node --experimental-strip-types packages/agent/src/cli.ts
```

## Git workflow

Work in worktrees, merge via PR. Don't commit to main directly.
