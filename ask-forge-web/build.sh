#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="${1:-ask-forge-web}"

echo "Building $IMAGE_NAME..."

# Copy ask-forge into build context
cp -r ../ask-forge ./ask-forge

# Ensure cleanup on exit
trap "rm -rf ./ask-forge" EXIT

# Build the image
docker build -t "$IMAGE_NAME" .

echo "Done! Run with:"
echo "  docker run -p 3000:3000 -e OPENROUTER_API_KEY=your-key -v ./data:/app/data $IMAGE_NAME"
