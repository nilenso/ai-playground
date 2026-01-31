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

Run the setup script (installs gVisor, sets up Caddy gateway, creates directories):

```bash
bash setup-server.sh
```

This will:
- Install **gVisor (runsc)** and register it as a Docker runtime — required for sandbox container isolation
- Set up Caddy as a reverse proxy with automatic TLS
- Create the app directory structure

> **Note:** gVisor is mandatory. The sandbox container runs with `runtime: runsc` to provide kernel-level syscall interception. Without it, `docker compose up` will fail.

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
