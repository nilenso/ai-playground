#!/bin/bash
# List cards from fivetwo project tracker
# Usage: fivetwo-list-cards.sh [--id <id>] [--status <status>] [--priority <0-100>] [--project-id <id>] [--search <query>]

BASE_URL="${FIVETWO_URL:-http://localhost:3000}"
TOKEN="${FIVETWO_TOKEN}"

if [ -z "$TOKEN" ]; then
    echo "Error: FIVETWO_TOKEN environment variable is required" >&2
    echo "Generate one with: bun run auth <username>" >&2
    exit 1
fi

# Parse arguments
PARAMS=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --id)
            PARAMS="${PARAMS}&id=$2"
            shift 2
            ;;
        --status)
            PARAMS="${PARAMS}&status=$2"
            shift 2
            ;;
        --priority)
            PARAMS="${PARAMS}&priority=$2"
            shift 2
            ;;
        --project-id)
            PARAMS="${PARAMS}&project_id=$2"
            shift 2
            ;;
        --search)
            PARAMS="${PARAMS}&search=$(echo "$2" | jq -sRr @uri)"
            shift 2
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

# Remove leading &
PARAMS="${PARAMS#&}"

URL="${BASE_URL}/api/v1/cards"
if [ -n "$PARAMS" ]; then
    URL="${URL}?${PARAMS}"
fi

curl -s -X GET "$URL" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" | jq .
