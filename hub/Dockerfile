# Build context is the monorepo root (see hub/docker-compose.yml and
# .github/workflows/release.yml). The hub depends on the workspace
# package @cc-commander/protocol, so we need access to that sibling
# directory at install time.
FROM node:22-alpine

RUN apk add --no-cache python3 make g++ \
 && addgroup -S hub && adduser -S hub -G hub

WORKDIR /app

# Copy workspace manifests + lockfile, then install only the hub
# subtree (and its workspace deps). `--workspace=cc-commander-hub`
# pulls in @cc-commander/protocol via the symlink npm sets up.
COPY package.json package-lock.json ./
COPY hub/package.json hub/package.json
COPY protocol/package.json protocol/package.json
RUN npm ci --omit=dev --workspace=cc-commander-hub --include-workspace-root \
 && apk del python3 make g++

COPY protocol/src ./protocol/src
COPY hub/src ./hub/src

# Set by CI on tag builds (e.g. ARG VERSION=v0.2.0). Runners poll
# /api/version and self-update when their own VERSION differs.
ARG VERSION=""
ENV VERSION=${VERSION}

ENV NODE_ENV=production \
    PORT=3000 \
    HUB_DB_PATH=/data/hub.db

RUN mkdir -p /data && chown -R hub:hub /data /app
USER hub

WORKDIR /app/hub

VOLUME ["/data"]
EXPOSE 3000

# JWT_SECRET MUST be supplied at runtime (>=32 chars).
CMD ["node", "--experimental-strip-types", "src/cli.ts"]
