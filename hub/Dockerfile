FROM node:22-alpine

RUN apk add --no-cache python3 make g++ \
 && addgroup -S hub && adduser -S hub -G hub

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && apk del python3 make g++

COPY src ./src

# Set by CI on tag builds (e.g. ARG VERSION=v0.2.0). Runners poll
# /api/version and self-update when their own VERSION differs.
ARG VERSION=""
ENV VERSION=${VERSION}

ENV NODE_ENV=production \
    PORT=3000 \
    HUB_DB_PATH=/data/hub.db

RUN mkdir -p /data && chown -R hub:hub /data /app
USER hub

VOLUME ["/data"]
EXPOSE 3000

# JWT_SECRET MUST be supplied at runtime (>=32 chars).
CMD ["node", "--experimental-strip-types", "src/cli.ts"]
