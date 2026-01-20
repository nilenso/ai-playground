---
description: Create a new fivetwo card from the user's message
---
Create a new fivetwo card from the user's message.

1. Detect the current project from `git remote get-url origin`
2. Parse the URL to extract host, owner, and repository
3. From the user's blurb, generate:
   - A concise title (imperative mood, e.g., "Add user authentication")
   - A full description with:
     - Context/background
     - What needs to be done
     - Acceptance criteria (if applicable)
4. Use the fivetwo-create-card.sh tool to create the card with:
   - `--project-id` set to `host/owner/repo` (e.g., `github.com/owner/repo`)
   - `--title` set to the generated title
   - `--description` set to the generated description
5. Report success with the created card ID
