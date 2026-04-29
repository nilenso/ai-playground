# Build stage
FROM oven/bun:1-alpine AS builder

WORKDIR /app

# Copy package files and registry config
COPY package.json bun.lock .npmrc ./

# Install dependencies (pulls @nilenso/megasthenes from JSR)
RUN bun install

# Copy source files
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY tsconfig.json biome.json ./

# Build both clients and create build info with current timestamp
RUN bun run build && bun run build:visualizer && \
    echo "{\"buildTime\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > public/build-info.json

# Production stage
FROM oven/bun:1-alpine

WORKDIR /app

# Install git and download litem8 static binary from GitHub (arch-aware)
RUN apk add --no-cache git openssh-client curl ripgrep fd && \
    ARCH=$(uname -m) && \
    case "$ARCH" in \
      x86_64)  LITEM8_ARCH="x86_64" ;; \
      aarch64) LITEM8_ARCH="aarch64" ;; \
      *)       echo "Unsupported arch: $ARCH" && exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/neenaoffline/litem8/releases/download/v0.2.0/litem8-linux-${LITEM8_ARCH}-static" \
      -o /usr/local/bin/litem8 && \
    chmod +x /usr/local/bin/litem8

# Copy package files and node_modules from builder
COPY package.json bun.lock ./
COPY --from=builder /app/node_modules ./node_modules

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
