FROM oven/bun:1 AS builder
WORKDIR /app

# Install litem8 globally for database migrations
RUN apt-get update && apt-get install -y curl && \
    mkdir -p ~/.local/bin && \
    curl -sL https://github.com/neenaoffline/litem8/releases/latest/download/litem8-linux-x86_64-static -o ~/.local/bin/litem8 && \
    chmod +x ~/.local/bin/litem8

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY . .

# Run as non-root
USER bun

# The web interface uses port 3000 by default
EXPOSE 3000

ENV PATH="/home/bun/.local/bin:${PATH}"

CMD ["sh", "-c", "bun run migrate && bun run start"]
