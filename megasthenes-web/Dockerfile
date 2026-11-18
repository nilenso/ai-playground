# Refresh version + multi-platform digest together in a reviewed PR (see docs/container-security.md).
# Bun's embedded CA roots are independent of Alpine's ca-certificates package.
FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS base

# Build stage
FROM base AS builder

WORKDIR /app

# Copy package files and registry config
COPY package.json bun.lock .npmrc ./

# Install dependencies (pulls @nilenso/megasthenes from JSR)
RUN bun install --frozen-lockfile

# Copy source files
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY tsconfig.json biome.json ./

# Build both clients and create build info with current timestamp
RUN bun run build && bun run build:visualizer && \
    echo "{\"buildTime\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > public/build-info.json

# Never copy the builder's dev tools to production.
FROM base AS production-dependencies
WORKDIR /app
COPY package.json bun.lock .npmrc ./
RUN bun install --frozen-lockfile --production

# Production stage
FROM base

WORKDIR /app

# Refresh all OS packages and system roots on every uncached build.
# litem8 v0.2.0 hashes come from upstream release SHA256SUMS / asset digests.
RUN apk upgrade --no-cache && \
    apk add --no-cache ca-certificates git openssh-client curl ripgrep fd && \
    update-ca-certificates && \
    ARCH=$(uname -m) && \
    case "$ARCH" in \
      x86_64)  LITEM8_ARCH="x86_64"; LITEM8_SHA256="89d6352f951b50afda07602a319160049a1aaec6a7afbc9da21287b21c2a69c0" ;; \
      aarch64) LITEM8_ARCH="aarch64"; LITEM8_SHA256="5320ed2175dfe39b8e3eb7686a966a897ad93746295423f198d345592d88f959" ;; \
      *)       echo "Unsupported arch: $ARCH" && exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/neenaoffline/litem8/releases/download/v0.2.0/litem8-linux-${LITEM8_ARCH}-static" \
      -o /usr/local/bin/litem8 && \
    echo "$LITEM8_SHA256  /usr/local/bin/litem8" | sha256sum -c - && \
    chmod +x /usr/local/bin/litem8

# Copy production dependencies, not the builder's development tools.
COPY package.json bun.lock ./
COPY --from=production-dependencies /app/node_modules ./node_modules

# Fail on regressions in either independent trust store.
COPY scripts/check-container-trust.ts ./scripts/check-container-trust.ts
RUN bun run scripts/check-container-trust.ts

# Copy built assets and source
COPY --from=builder /app/public ./public
COPY --from=builder /app/src ./src
COPY tsconfig.json ./

# Copy migrations
COPY migrations ./migrations

# Create non-root user and data directory
RUN addgroup -g 1001 appgroup && \
    adduser -u 1001 -G appgroup -D appuser && \
    mkdir -p /app/data && \
    chown -R appuser:appgroup /app

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV VISUALIZER_PORT=3001
ENV DATABASE_PATH=/app/data/megasthenes.db

EXPOSE 3000 3001

# Entrypoint script that runs migrations then starts both servers
COPY --chmod=755 <<'EOF' /app/entrypoint.sh
#!/bin/sh
set -e

echo "Running database migrations..."
litem8 up --db "${DATABASE_PATH:-/app/data/megasthenes.db}" --migrations /app/migrations

echo "Starting visualizer server on port ${VISUALIZER_PORT:-3001}..."
PORT="${VISUALIZER_PORT:-3001}" bun run src/visualizer-server.ts &

echo "Starting main server on port ${PORT:-3000}..."
exec bun run src/server.ts
EOF

USER appuser

ENTRYPOINT ["/app/entrypoint.sh"]
