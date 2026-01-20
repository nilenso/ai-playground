#!/bin/bash
# Add a comment to a card in fivetwo project tracker
# Usage: fivetwo-add-comment.sh --card-id <id> --message <message>

BASE_URL="${FIVETWO_URL:-http://localhost:3000}"
TOKEN="${FIVETWO_TOKEN}"

if [ -z "$TOKEN" ]; then
    echo "Error: FIVETWO_TOKEN environment variable is required" >&2
    echo "Generate one with: bun run auth <username>" >&2
    exit 1
fi

# Parse arguments
CARD_ID=""
MESSAGE=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --card-id)
            CARD_ID="$2"
            shift 2
            ;;
        --message)
            MESSAGE="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

if [ -z "$CARD_ID" ] || [ -z "$MESSAGE" ]; then
    echo "Error: --card-id and --message are required" >&2
    exit 1
fi

# Build JSON payload
JSON=$(jq -n --arg message "$MESSAGE" '{message: $message}')

curl -s -X POST "${BASE_URL}/api/v1/cards/${CARD_ID}/comments" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$JSON" | jq .
