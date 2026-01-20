---
description: Work on fivetwo project tracker cards with a structured workflow (card selection, implementation, review, commit)
---

# FiveTwo Workflow Skill

You help users work through cards from the fivetwo project tracker in a structured, documented workflow.

## Prerequisites

Set environment variables:
- `FIVETWO_URL` - API base URL (default: `http://localhost:3000`)
- `FIVETWO_TOKEN` - Auth token (generate with: `bun run auth <username>`)

## Project Detection

At the start of each session, determine the current project:

1. Run `git remote get-url origin` to get the remote URL
2. Parse the URL to extract host, owner, and repository:
   - SSH format: `git@github.com:owner/repo.git` → host=github.com, owner=owner, repo=repo
   - HTTPS format: `https://github.com/owner/repo.git` → host=github.com, owner=owner, repo=repo
3. Use `fivetwo_list_cards` with the matching `project_id` for all card operations

If parsing fails, ask the user for the project_id.

## API Tools

Use the CLI tools in `{baseDir}/tools/` to interact with the fivetwo API:

### List Cards
```bash
{baseDir}/tools/fivetwo-list-cards.sh [options]
```
Options: `--id`, `--status`, `--priority`, `--project-id`, `--search`

### Create Card
```bash
{baseDir}/tools/fivetwo-create-card.sh --project-id <id> --title <title> [--description <desc>] [--status <status>] [--priority <0-100>]
```

### Update Card
```bash
{baseDir}/tools/fivetwo-update-card.sh --id <id> [--title <title>] [--description <desc>] [--status <status>] [--priority <0-100>]
```

### Add Comment
```bash
{baseDir}/tools/fivetwo-add-comment.sh --card-id <id> --message <message>
```

### Delete Comment
```bash
{baseDir}/tools/fivetwo-delete-comment.sh --id <id>
```

## Workflow Phases

You operate in 4 phases. Always track which phase you're in.

### Phase 1: Card Selection

1. List cards with `--status backlog` and the detected `--project-id`
2. **Filter out epic cards** - Epic cards (type="epic") are for planning and organization only. Do not present, select, or work on epic cards. Skip them silently.
3. If no non-epic cards found: Say "No cards available. All caught up!" and stop
4. Present available cards in a table showing: ID, Title, Priority, Description (truncated)
5. Ask the user which card they want to work on
6. Once selected:
   - Update card to `--status in_progress`
   - Add comment: "Work started"
7. Proceed to Phase 2

### Phase 2: Implementation

1. Analyze the card's title and description to understand requirements
2. If anything is unclear, ask clarifying questions
3. When the user answers questions, add a comment with:
   ```
   **Question:** <your question>
   **Answer:** <user's answer>
   ```
4. Break down the work into trackable tasks
5. Implement the required changes
6. Mark tasks as completed as you progress
7. When implementation is complete, proceed to Phase 3

### Phase 3: Completion

1. Summarize all changes made (files modified, features added, etc.)
2. Add a comment with a detailed completion summary:
   ```
   **Work completed**
   
   <summary of changes>
   
   Files modified:
   - file1.ts
   - file2.ts
   ```
3. Update card to `--status review`
4. Proceed to Phase 4

### Phase 4: Review & Commit

1. Run `git diff` and `git status` to show the user all changes
2. Present a summary and ask the user to review
3. Wait for explicit user approval before proceeding
4. Once approved:
   - Stage relevant files with `git add`
   - Commit with message format: `#<card_id> <brief description>`
   - Update card to `--status done`
   - Add comment: "Committed and pushed: <commit_hash>"
   - Run `git push`
5. Immediately return to Phase 1 (do not ask, just proceed)

## Important Guidelines

- **Ignore epic cards** - Epic cards (type="epic") are high-level planning containers, not actionable work items. Never select, work on, or modify epic cards. They are managed separately by humans.
- **Check for card updates between turns** - Before each response during Phase 2 (Implementation), re-fetch the current card using `--id <card_id>` to check for new comments or status changes. If the card has been updated (new comments, changed description, status change, etc.), reload the full card details, inform the user what changed, and adjust your work plan as necessary to incorporate the new information or direction.
- **Do not update cards in a terminal state** (`done`, `wont_do`, `invalid`). If a bug is discovered in work from a completed card, create a new card with type `bug` that references the original card (using `follows` or `relates_to`). For other changes needed for terminated cards, create an appropriate new card that references the original. Terminal states are final.
- **Always comment on cards** to maintain a clear audit trail
- **Reference card IDs in commit messages** using format `#<id> <description>`
- **Never skip the review phase** - always wait for explicit user approval before committing
- **If blocked**, update card to `--status blocked` and add a comment explaining why
- **Batch questions** - When you have multiple questions or uncertainties, ask them all together in a single message rather than one at a time. This reduces back-and-forth and speeds up the workflow.
- **Card descriptions should start with plain text** - Don't begin card descriptions with markdown headers (`##`) or bold text (`**`). Start with a clear, readable sentence. Markdown formatting can be used later in the description for structure.

## Card Statuses

Valid statuses:
- `backlog` - Not yet started
- `in_progress` - Currently being worked on
- `review` - Ready for review
- `blocked` - Work is blocked
- `done` - Completed (terminal)
- `wont_do` - Won't be done (terminal)
- `invalid` - Invalid card (terminal)

## Session Start

When the user asks you to work on fivetwo cards, immediately begin Phase 1:
1. Detect the current project from git remote
2. Fetch backlog cards
3. Present them to the user

Do not wait for the user to ask - proactively start the workflow.
