#!/bin/bash
# Update an existing card in fivetwo project tracker
# Usage: fivetwo-update-card.sh --id <id> [--title <title>] [--description <desc>] [--status <status>] [--priority <0-100>]

BASE_URL="${FIVETWO_URL:-http://localhost:3000}"
TOKEN="${FIVETWO_TOKEN}"

if [ -z "$TOKEN" ]; then
    echo "Error: FIVETWO_TOKEN environment variable is required" >&2
    echo "Generate one with: bun run auth <username>" >&2
    exit 1
fi

# Parse arguments
CARD_ID=""
TITLE=""
DESCRIPTION=""
STATUS=""
PRIORITY=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --id)
            CARD_ID="$2"
            shift 2
            ;;
        --title)
            TITLE="$2"
            shift 2
            ;;
        --description)
            DESCRIPTION="$2"
            shift 2
            ;;
        --status)
            STATUS="$2"
            shift 2
            ;;
        --priority)
            PRIORITY="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

if [ -z "$CARD_ID" ]; then
    echo "Error: --id is required" >&2
    exit 1
fi

# Build JSON payload with only provided fields
JSON=$(jq -n \
    --arg title "$TITLE" \
    --arg description "$DESCRIPTION" \
    --arg status "$STATUS" \
    --arg priority "$PRIORITY" \
    '(if $title != "" then {title: $title} else {} end)
      + (if $description != "" then {description: $description} else {} end)
      + (if $status != "" then {status: $status} else {} end)
      + (if $priority != "" then {priority: ($priority | tonumber)} else {} end)'
)

curl -s -X PATCH "${BASE_URL}/api/v1/cards/${CARD_ID}" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$JSON" | jq .
