#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="${1:-ask-forge-web}"

echo "Building $IMAGE_NAME..."

# Copy ask-forge into build context (excluding workdir, node_modules, etc.)
rsync -a --exclude='node_modules' --exclude='workdir' --exclude='.git' --exclude='__pycache__' ../ask-forge/ ./ask-forge/

# Ensure cleanup on exit
trap "rm -rf ./ask-forge" EXIT

# Build the image
docker build -t "$IMAGE_NAME" .

echo "Done! Run with:"
echo "  docker run -p 3000:3000 -p 3001:3001 -e OPENROUTER_API_KEY=your-key -v ./data:/app/data $IMAGE_NAME"
