# ask-forge-web Deployment

## 1. Provision Infrastructure

In the `infra` repo:

```bash
cd ../infra
tofu plan   # Review changes
tofu apply  # Creates droplet + DNS records
```

This creates:
- DigitalOcean droplet `ask-forge` (s-1vcpu-1gb, Docker image, blr1)
- Firewall allowing SSH (22), HTTP (80), HTTPS (443)
- DNS: `ask.nilenso.ai` → droplet IP
- DNS: `ask-forge-visualizer.nilenso.ai` → droplet IP

## 2. Setup Server

SSH into the new droplet:

```bash
ssh root@ask.nilenso.ai
```

Setup gateway and app directories:

```bash
# Create directories
mkdir -p ~/gateway ~/ask-forge-web

# Setup gateway (Caddy for SSL termination)
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
docker compose up -d
```

## 3. Deploy App

Copy files from this directory to the server:

```bash
scp docker-compose.yml .env.example root@ask.nilenso.ai:~/ask-forge-web/
```

On the server:

```bash
cd ~/ask-forge-web

# Create .env
cp .env.example .env
nano .env  # Add your OPENROUTER_API_KEY

# Start the app
docker compose up -d
```

## 4. Verify

```bash
# Check containers
docker ps

# Check logs
docker logs gateway
docker logs ask-forge-web

# Check web network
docker network inspect web

# Test endpoints
curl -I https://ask.nilenso.ai
curl -I https://ask-forge-visualizer.nilenso.ai
```

## Files in this directory

- `docker-compose.yml` - App container config
- `.env.example` - Environment variables template
- `README.md` - This file

## Updating the App

```bash
ssh root@ask.nilenso.ai
cd ~/ask-forge-web
docker compose pull
docker compose up -d
```
