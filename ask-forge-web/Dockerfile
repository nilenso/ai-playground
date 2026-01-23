# Get litem8 binary from official image
FROM ghcr.io/neenaoffline/litem8:latest AS litem8

# Build stage
FROM oven/bun:1-alpine AS builder

WORKDIR /app

# Copy ask-forge dependency first (from build context)
COPY ask-forge ./ask-forge

# Copy package files
COPY package.json bun.lock ./

# Update local dependency path for Docker context
RUN sed -i 's|file:../ask-forge|file:./ask-forge|' package.json

# Install dependencies
RUN bun install

# Copy source files
COPY src ./src
COPY public ./public
COPY tsconfig.json biome.json ./

# Build the client
RUN bun run build

# Production stage
FROM oven/bun:1-alpine

WORKDIR /app

# Install git (needed for git operations in the app)
RUN apk add --no-cache git openssh-client

# Copy litem8 binary
COPY --from=litem8 /litem8 /usr/local/bin/litem8

# Copy ask-forge dependency
COPY ask-forge ./ask-forge

# Copy package files and install production dependencies
COPY package.json bun.lock ./
RUN sed -i 's|file:../ask-forge|file:./ask-forge|' package.json && \
    bun install --production

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
ENV DATABASE_PATH=/app/data/ask-forge.db

EXPOSE 3000

# Entrypoint script that runs migrations then starts server
COPY --chmod=755 <<'EOF' /app/entrypoint.sh
#!/bin/sh
set -e

echo "Running database migrations..."
litem8 up --db "${DATABASE_PATH:-/app/data/ask-forge.db}" --migrations /app/migrations

echo "Starting server..."
exec bun run src/server.ts
EOF

USER appuser

ENTRYPOINT ["/app/entrypoint.sh"]
