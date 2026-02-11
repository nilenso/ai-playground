# ask-forge-infra

Ansible playbooks for deploying ask-forge-web.

## Structure

```
ask-forge-infra/
├── ansible.cfg           # Ansible configuration
├── inventory/
│   └── hosts.yml         # Server inventory
├── playbooks/
│   ├── setup.yml         # Initial server setup (run once)
│   └── deploy.yml        # Deployment (used by CI)
├── roles/
│   ├── gvisor/           # Install gVisor runtime
│   ├── gateway/          # Caddy reverse proxy
│   └── app/              # ask-forge-web application
└── requirements.yml      # Ansible Galaxy dependencies
```

## Prerequisites

```bash
# Install Ansible
pip install ansible

# Install required collections
ansible-galaxy collection install -r requirements.yml
```

## Usage

### Initial Server Setup

Run once on a new server to install all dependencies:

```bash
cd ask-forge-infra
ansible-playbook playbooks/setup.yml
```

This will:
- Install Docker
- Install gVisor (runsc)
- Set up Caddy as reverse proxy
- Create app directories and config files

After running, edit `~/ask-forge-web/.env` on the server with your API keys.

### Deployment

Used by CI to deploy new versions:

```bash
ansible-playbook playbooks/deploy.yml
```

This will:
- Pull the latest Docker images
- Restart containers
- Clean up old images
- Verify the app is healthy

### GitHub Actions

The deploy playbook is designed to run from GitHub Actions. It requires:
- `DEPLOY_SSH_KEY` secret with SSH private key
- Server must have the public key in `~/.ssh/authorized_keys`

## Verification

After deployment:

```bash
# Check containers are running
docker ps

# Test gVisor
docker run --runtime=runsc --rm hello-world

# Check endpoints
curl -I https://ask.nilenso.ai
curl -I https://ask-forge-visualizer.nilenso.ai
```
