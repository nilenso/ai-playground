# TBD — Leftover Work

Tracked issues and improvements from the sandbox-security branch review.

## Security

- **Route `read` tool through bwrap in the sandbox worker.**
  `handleTool`'s `read` case uses `readFile()` directly in the worker process,
  bypassing bwrap isolation. The other tools (`rg`, `fd`, `ls`) all go through
  `runToolSandboxed`. A malicious repo could plant a symlink
  (`data -> /etc/passwd`) that passes the `resolve()` path validation but
  still reads outside the worktree. Either run reads through bwrap or resolve
  symlinks with `realpath` before validation.

- **Disable `.gitattributes` filter drivers.**
  The security doc flags this as an open item. Add `GIT_ATTR_NOSYSTEM=1` to the
  git env and pass `-c filter.*.process=` to git clone bwrap args to prevent
  arbitrary command execution via filter drivers.

- **Network filtering for git clone.**
  Git clone currently has unrestricted network access. A malicious
  `.gitmodules` could trigger fetches to attacker-controlled URLs. Add
  proxy-based network filtering to allow only the intended git host.

- **Add tool execution timeouts in the sandbox worker.**
  `runToolSandboxed` has no timeout. A malicious rg pattern or deeply nested
  directory tree could cause indefinite execution. Add a per-tool timeout
  (e.g. 30s) via `AbortSignal.timeout` or bwrap's `--timeout` flag (if
  available) or a wrapping `timeout` command.

## Auth

- **Replace hardcoded `userId: 1`.**
  `/connect`, `/restore`, and `/sessions` endpoints all use `userId: 1`.
  Multiple GitHub-authenticated users will share sessions. Wire up the
  actual authenticated user ID from the JWT/session.

## Code Quality

- **Remove unused `shellEscape()` in `worker.ts`.**
  Defined but never called — all commands use array-based `Bun.spawn` which
  doesn't need shell escaping. Remove or add a comment if kept for future use.

- **`fd` tool is misleading — uses `find`, not `fd`.**
  Both `LocalToolExecutor` and the sandbox worker implement the `fd` tool with
  `find . -name *${pattern}*`. Rename to `find` or install actual `fd`
  (`fd-find`) in the container. Also consider sanitizing glob-special characters
  in the pattern.

- **Integration tests test a copy, not the real code.**
  `sandbox.integration.test.ts` re-implements `simulateReadTool` instead of
  importing the actual `executeLocalTool`. If the real code diverges, these
  tests won't catch regressions. Refactor to test the exported function
  directly.

- **Inconsistent error responses in `worker.ts`.**
  Some tool errors return `{ ok: true, output: "Error..." }` while others
  return `{ ok: false, error: "..." }`. The client treats these differently —
  `ok: false` throws, `ok: true` with error text passes through silently.
  Standardize on one pattern.

- **Remove unused `socat` package from Containerfile.**
  Installed in the Alpine image but not used anywhere.

## UX

- **Session restore race condition.**
  `handleRestore` on the client clears UI state optimistically before the
  server responds. If `connect()` fails (e.g. repo unreachable), the user
  loses their previous view. Make the UI update contingent on success.

## Misc

- **Verify `recordCheckout` return value.**
  The `/connect` endpoint now expects `recordCheckout()` to return an object
  with `.id` for `createDbSession`. Confirm the function was updated to return
  the inserted row.
