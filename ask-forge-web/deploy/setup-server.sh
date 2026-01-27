#!/bin/bash
set -e

echo "=== Setting up ask-forge-web server ==="

# Create directories
echo "Creating directories..."
mkdir -p ~/gateway ~/ask-forge-web

# Setup gateway (Caddy for SSL termination)
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
    reverse_proxy ask-forge-web:3000
}

ask-forge-visualizer.nilenso.ai {
    reverse_proxy ask-forge-web:3001
}
EOF

# Start gateway
echo "Starting gateway..."
docker compose up -d

# Setup ask-forge-web
echo "Setting up ask-forge-web..."
cd ~/ask-forge-web

cat > docker-compose.yml << 'EOF'
services:
  web:
    image: ghcr.io/nilenso/ask-forge-web:latest
    container_name: ask-forge-web
    environment:
      - PORT=3000
      - VISUALIZER_PORT=3001
      - DATABASE_PATH=/app/data/ask-forge.db
      - SESSION_DIR=/app/data/sessions
      - OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
    volumes:
      - ./data:/app/data
    networks:
      - default
      - web
    restart: unless-stopped

networks:
  web:
    external: true
EOF

cat > .env.example << 'EOF'
OPENROUTER_API_KEY=your-openrouter-api-key
EOF

# Create .env if it doesn't exist
if [ ! -f .env ]; then
    cp .env.example .env
    echo ""
    echo "=== IMPORTANT ==="
    echo "Edit ~/ask-forge-web/.env and set your OPENROUTER_API_KEY"
    echo "Then run: cd ~/ask-forge-web && docker compose up -d"
else
    echo ".env already exists, skipping..."
    echo "Starting ask-forge-web..."
    docker compose up -d
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "To verify:"
echo "  docker ps"
echo "  curl -I https://ask.nilenso.ai"
echo "  curl -I https://ask-forge-visualizer.nilenso.ai"
