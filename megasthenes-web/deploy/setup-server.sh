#!/bin/bash
set -e

echo "=== Setting up megasthenes-web server ==="

# =============================================================================
# Install gVisor (runsc) — required for sandbox container isolation
# =============================================================================

if ! command -v runsc &> /dev/null; then
    echo "Installing gVisor (runsc)..."

    # Install from gVisor apt repo (Debian/Ubuntu)
    sudo apt-get update && sudo apt-get install -y apt-transport-https ca-certificates curl gnupg
    curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" | sudo tee /etc/apt/sources.list.d/gvisor.list > /dev/null
    sudo apt-get update && sudo apt-get install -y runsc

    # Register runsc as a Docker runtime
    sudo runsc install
    sudo systemctl reload docker

    echo "gVisor installed and registered as Docker runtime"
else
    echo "gVisor (runsc) already installed"
fi

# Verify runsc is available to Docker
if ! docker info 2>/dev/null | grep -q runsc; then
    echo "ERROR: runsc runtime not registered with Docker."
    echo "Run: sudo runsc install && sudo systemctl reload docker"
    exit 1
fi

echo "runsc runtime verified ✓"

# =============================================================================
# Create directories
# =============================================================================

echo "Creating directories..."
mkdir -p ~/gateway ~/megasthenes-web/data/sessions

# =============================================================================
# Setup gateway (Caddy for SSL termination)
# =============================================================================

echo "Setting up gateway..."
cd ~/gateway

cat > docker-compose.yml << 'EOF'
services:
  caddy:
    image: caddy:2-alpine
    container_name: gateway
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
    networks:
      - web
    restart: unless-stopped

networks:
  web:
    name: web

volumes:
  caddy_data:
EOF

cat > Caddyfile << 'EOF'
ask.nilenso.ai {
    reverse_proxy megasthenes-web:3000
}

megasthenes-visualizer.nilenso.ai {
    reverse_proxy megasthenes-web:3001
}
EOF

# Start gateway
echo "Starting gateway..."
docker compose up -d

# =============================================================================
# Setup megasthenes-web
# =============================================================================

echo "Setting up megasthenes-web..."
cd ~/megasthenes-web

cat > .env.example << 'EOF'
OPENROUTER_API_KEY=your-openrouter-api-key
EOF

# Create .env if it doesn't exist
if [ ! -f .env ]; then
    cp .env.example .env
    echo ""
    echo "=== IMPORTANT ==="
    echo "Edit ~/megasthenes-web/.env and set your OPENROUTER_API_KEY"
    echo "Then run: cd ~/megasthenes-web && docker compose up -d"
else
    echo ".env already exists, skipping..."
    echo "Starting megasthenes-web..."
    docker compose up -d
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "To verify:"
echo "  docker ps"
echo "  docker run --runtime=runsc --rm hello-world  # verify gVisor"
echo "  curl -I https://ask.nilenso.ai"
echo "  curl -I https://megasthenes-visualizer.nilenso.ai"
