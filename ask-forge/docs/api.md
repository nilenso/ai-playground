# ask-forge Library Reference

`ask-forge` is a TypeScript library for safely querying remote git repositories using LLM agents. It clones repos into isolated worktrees, exposes read-only tools to an LLM, and streams the agent's reasoning back to the caller.

Runtime: **Bun**

## Quick Start

```typescript
import { connect } from "ask-forge";

const session = await connect("https://github.com/owner/repo");

const result = await session.ask("What does the auth module do?", {
  onProgress: (event) => console.log(event.type),
});

console.log(result.response);
session.close();
```

---

## Exported Function

### `connect(repoUrl, options?)`

Clones (or reuses) a bare git repository, creates a worktree at the target commit, and returns a `Session`.

```typescript
async function connect(repoUrl: string, options?: ConnectOptions): Promise<Session>
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `repoUrl` | `string` | HTTPS URL of the repository (e.g. `https://github.com/owner/repo`) |
| `options` | `ConnectOptions` | Optional connection settings |

**Throws** if the URL is invalid, the forge cannot be inferred, cloning fails, or the commitish cannot be resolved.

**Internals:**
1. Infers the forge (GitHub/GitLab) from the hostname, or uses `options.forge`.
2. Clones a bare repo to `workdir/<owner>/<repo>/repo` (or fetches if it already exists).
3. Resolves the commitish to a SHA and creates a git worktree at `workdir/<owner>/<repo>/trees/<short-sha>`.
4. Initialises an LLM context with a system prompt and read-only tools, then returns a `Session`.

Parallel calls to `connect` for the same repository are serialized internally to prevent race conditions during clone.

---

## Types

### `ConnectOptions`

```typescript
interface ConnectOptions {
  token?: string;      // Auth token injected into the clone URL
  forge?: ForgeName;   // Override forge detection ("github" | "gitlab")
  commitish?: string;  // Branch, tag, or SHA to check out (default: "HEAD")
}
```

### `ForgeName`

```typescript
type ForgeName = "github" | "gitlab";
```

### `Forge`

```typescript
interface Forge {
  name: ForgeName;
  buildCloneUrl(repoUrl: string, token?: string): string;
}
```

### `Repo`

Represents a checked-out repository on disk.

```typescript
interface Repo {
  url: string;        // Original repository URL
  localPath: string;  // Absolute path to the worktree on disk
  forge: Forge;       // Forge instance used for this repo
  commitish: string;  // Resolved full SHA
  cachePath: string;  // Absolute path to the bare repo cache
}
```

### `Session`

A stateful conversation session bound to a repository. Serializes concurrent `ask()` calls.

```typescript
interface Session {
  id: string;                                              // UUID
  repo: Repo;                                              // The connected repository
  ask(question: string, options?: AskOptions): Promise<AskResult>;
  replaceMessages(messages: Message[]): void;              // Replace conversation history (for restoration)
  getMessages(): Message[];                                // Read current conversation history
  close(): void;                                           // Clean up worktree
}
```

- **`ask(question, options?)`** sends a user message to the LLM, runs an agentic tool-use loop (up to `MAX_TOOL_ITERATIONS` rounds), and returns the final result. Only one `ask` runs at a time; concurrent calls queue.
- **`replaceMessages(messages)`** overwrites the internal pi-ai `Context.messages` array. Used to restore a session from persisted state.
- **`getMessages()`** returns the current `Message[]` from the pi-ai context. Includes user messages, assistant messages (with tool calls and thinking), and tool result messages.
- **`close()`** removes the git worktree. Idempotent. After closing, `ask()` throws.

### `AskOptions`

```typescript
interface AskOptions {
  onProgress?: OnProgress;
}
```

### `OnProgress` / `ProgressEvent`

Callback for streaming events during an `ask()` call.

```typescript
type OnProgress = (event: ProgressEvent) => void;

type ProgressEvent =
  | { type: "thinking" }                                       // LLM call started
  | { type: "thinking_delta"; delta: string }                  // Extended thinking token
  | { type: "text_delta"; delta: string }                      // Response text token
  | { type: "tool_start"; name: string; arguments: Record<string, unknown> }
  | { type: "tool_delta"; name: string; delta: string }        // Tool argument streaming
  | { type: "tool_end"; name: string; arguments: Record<string, unknown> }
  | { type: "responding" };                                    // Final response ready
```

### `AskResult`

Returned by `session.ask()`.

```typescript
interface AskResult {
  prompt: string;          // The original question
  toolCalls: ToolCall[];   // All tool calls made during this ask
  response: string;        // Final text response (or "[ERROR: ...]" on failure)
  usage: Usage;            // Accumulated token usage across all LLM calls
  inferenceTimeMs: number; // Wall-clock time for the entire ask
}
```

### Re-exported pi-ai Types

These types are re-exported from `@mariozechner/pi-ai` for convenience:

#### `Message`

```typescript
type Message = UserMessage | AssistantMessage | ToolResultMessage;
```

#### `ToolCall`

```typescript
interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
  thoughtSignature?: string;
}
```

#### `Usage`

```typescript
interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

---

## Built-in LLM Tools

The agent has access to four read-only tools for exploring the repository:

| Tool | Description | Parameters |
|------|-------------|------------|
| `rg` | Search file contents using ripgrep | `pattern: string`, `glob?: string` |
| `fd` | Find files by name pattern | `pattern: string`, `type?: "f" \| "d"` |
| `ls` | List directory contents | `path?: string` (relative to repo root) |
| `read` | Read a file's full contents | `path: string` (relative to repo root) |

All tools run against the worktree and cannot modify files.

---

## Configuration

Settings are in `config.ts`:

| Constant | Default | Description |
|----------|---------|-------------|
| `MODEL_PROVIDER` | `"openrouter"` | LLM provider passed to pi-ai's `getModel()` |
| `MODEL_NAME` | `"anthropic/claude-sonnet-4.5"` | Model identifier |
| `MAX_TOOL_ITERATIONS` | `20` | Maximum agentic tool-use rounds per `ask()` call |
| `SYSTEM_PROMPT` | *(see config.ts)* | Instructions given to the LLM |

---

## Error Handling

`ask()` does not throw on LLM errors. Instead, the `response` field in `AskResult` will contain an error string prefixed with `[ERROR: ...]`. Errors are logged to stderr with full context.

Conditions that produce error responses:
- API call failure (network, auth, rate limit)
- API returns `stopReason: "error"`
- Empty response from the model
- Max tool iterations exhausted without a final answer
