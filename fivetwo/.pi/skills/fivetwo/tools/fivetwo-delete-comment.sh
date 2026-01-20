#!/bin/bash
# Delete (soft-delete) a comment from fivetwo project tracker
# Usage: fivetwo-delete-comment.sh --id <comment_id>

BASE_URL="${FIVETWO_URL:-http://localhost:3000}"
TOKEN="${FIVETWO_TOKEN}"

if [ -z "$TOKEN" ]; then
    echo "Error: FIVETWO_TOKEN environment variable is required" >&2
    echo "Generate one with: bun run auth <username>" >&2
    exit 1
fi

# Parse arguments
COMMENT_ID=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --id)
            COMMENT_ID="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

if [ -z "$COMMENT_ID" ]; then
    echo "Error: --id is required" >&2
    exit 1
fi

curl -s -X DELETE "${BASE_URL}/api/v1/comments/${COMMENT_ID}" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" | jq .
