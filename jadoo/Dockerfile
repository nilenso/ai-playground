FROM oven/bun:1 AS base
WORKDIR /app

# Install litem8 for database migrations
RUN apt-get update && apt-get install -y curl && \
    curl -sL https://github.com/neenaoffline/litem8/releases/latest/download/litem8-linux-x86_64-static \
      -o /usr/local/bin/litem8 && chmod +x /usr/local/bin/litem8 && \
    apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy application code
COPY src/ src/
COPY migrations/ migrations/
COPY tsconfig.json ./

# Data directory for SQLite
RUN mkdir -p /app/data
VOLUME /app/data

CMD ["bun", "src/index.ts"]
