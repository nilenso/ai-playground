#!/bin/bash
# Create a new card in fivetwo project tracker
# Usage: fivetwo-create-card.sh --project-id <id> --title <title> [--description <desc>] [--status <status>] [--priority <0-100>]

BASE_URL="${FIVETWO_URL:-http://localhost:3000}"
TOKEN="${FIVETWO_TOKEN}"

if [ -z "$TOKEN" ]; then
    echo "Error: FIVETWO_TOKEN environment variable is required" >&2
    echo "Generate one with: bun run auth <username>" >&2
    exit 1
fi

# Parse arguments
PROJECT_ID=""
TITLE=""
DESCRIPTION=""
STATUS=""
PRIORITY=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --project-id)
            PROJECT_ID="$2"
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

if [ -z "$PROJECT_ID" ] || [ -z "$TITLE" ]; then
    echo "Error: --project-id and --title are required" >&2
    exit 1
fi

# Build JSON payload
# Try to parse project_id as number, fall back to string
if [[ "$PROJECT_ID" =~ ^[0-9]+$ ]]; then
    JSON=$(jq -n \
        --argjson project_id "$PROJECT_ID" \
        --arg title "$TITLE" \
        --arg description "$DESCRIPTION" \
        --arg status "$STATUS" \
        --arg priority "$PRIORITY" \
        '{
            project_id: $project_id,
            title: $title
        } + (if $description != "" then {description: $description} else {} end)
          + (if $status != "" then {status: $status} else {} end)
          + (if $priority != "" then {priority: ($priority | tonumber)} else {} end)'
    )
else
    JSON=$(jq -n \
        --arg project_id "$PROJECT_ID" \
        --arg title "$TITLE" \
        --arg description "$DESCRIPTION" \
        --arg status "$STATUS" \
        --arg priority "$PRIORITY" \
        '{
            project_id: $project_id,
            title: $title
        } + (if $description != "" then {description: $description} else {} end)
          + (if $status != "" then {status: $status} else {} end)
          + (if $priority != "" then {priority: ($priority | tonumber)} else {} end)'
    )
fi

curl -s -X POST "${BASE_URL}/api/v1/cards" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$JSON" | jq .
