#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="${1:-megasthenes-web}"

echo "Building $IMAGE_NAME..."

# Build the image
docker build -t "$IMAGE_NAME" .

echo "Done! Run with:"
echo "  docker run -p 3000:3000 -p 3001:3001 -e OPENROUTER_API_KEY=your-key -v ./data:/app/data $IMAGE_NAME"
