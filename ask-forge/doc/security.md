# Security Threat Model

ask-forge allows an LLM agent to clone and query arbitrary git repositories.
This document describes the threats we defend against and the layers of
protection in place.

## System Overview

```
User → ask-forge-web (Hono server)
         │
         │  HTTP (internal compose network)
         ▼
       sandbox worker (inside gVisor container)
         │
         ├── git clone  →  bwrap (filesystem + PID isolation)
         └── tool calls →  bwrap (filesystem + PID + network isolation)
```

The web server never runs git or tool commands directly in production. It
delegates to the sandbox worker over HTTP. The worker runs each operation
inside a bwrap sandbox within a gVisor container.

---

## Threat: Malicious Repository Content

A repository being cloned may contain payloads designed to execute code or
exfiltrate data.

### Attack vectors

| Vector | Description |
|--------|-------------|
| Git hooks | `post-checkout`, `pre-commit`, etc. execute arbitrary commands |
| `.gitmodules` | Submodule URLs can trigger fetches to attacker-controlled servers |
| `.gitattributes` filter drivers | `filter.*.process` runs arbitrary commands on checkout |
| Symlinks | Files symlinked to paths outside the repo (e.g. `/etc/shadow`) |
| Large files / zip bombs | Resource exhaustion |

### Mitigations

| Layer | Mitigation |
|-------|------------|
| bwrap (clone) | `core.hooksPath=/dev/null` — disables all git hooks |
| bwrap (clone) | `protocol.allow=never` + `protocol.https.allow=always` + `protocol.http.allow=always` — blocks `file://`, `ext://`, `ssh://` submodule protocols |
| bwrap (clone) | Filesystem writes restricted to the specific repo directory only |
| bwrap (clone) | PID namespace isolation — hooks (if somehow executed) can't see/signal other processes |
| bwrap (tools) | Symlinks resolved by `resolve()` and validated against the worktree root before access |
| gVisor | Syscall interception limits what any escaped code can do |
| Container | `cap_drop: ALL`, `no-new-privileges`, non-root user (`forge`) |
| Container | tmpfs storage — all data is ephemeral, wiped on restart |

### Open items

- **Network isolation for git clone**: Currently git clone has network access
  (needed to reach the remote). A malicious `.gitmodules` could trigger fetches
  to attacker-controlled URLs. Future work: proxy-based network filtering to
  allow only the intended git host.
- **`.gitattributes` filter drivers**: Not explicitly disabled. The read-only
  bwrap filesystem and hook disabling reduce risk but a `filter.*.process`
  config could still be triggered during checkout. Consider
  `GIT_ATTR_NOSYSTEM=1` and clearing local `.gitattributes` processing.

---

## Threat: LLM Tool Call Abuse

The LLM agent can invoke tools (rg, find, ls, read) with arbitrary arguments.
It may attempt to read sensitive files, access other users' repos, make
network requests, or write to the filesystem.

### Attack vectors

| Vector | Description |
|--------|-------------|
| Path traversal | `read({ path: "../../other-repo/secrets.env" })` |
| Absolute paths | `read({ path: "/etc/passwd" })` |
| Cross-repo access | Reading another session's cloned repository |
| Network exfiltration | Tool calls attempting outbound connections |
| Command injection | Malicious arguments to rg/find that cause unexpected behavior |
| Process interference | Killing the worker process or reading its `/proc` entries |

### Mitigations

| Layer | Mitigation |
|-------|------------|
| bwrap (tools) | `--tmpfs /home/forge/repos` hides ALL repos, then `--ro-bind <worktree> <worktree>` exposes only the session's worktree. Cross-repo access is impossible. |
| bwrap (tools) | `--unshare-net` — complete network isolation. No outbound connections possible. |
| bwrap (tools) | `--unshare-pid` + `--proc /proc` — PID namespace isolation. Cannot see or signal other processes. |
| bwrap (tools) | `--ro-bind / /` — entire filesystem is read-only. No writes possible. |
| bwrap (tools) | `--tmpfs ~/.ssh`, `--tmpfs ~/.gnupg` — sensitive directories hidden behind empty tmpfs. |
| Path validation | `resolve(worktree, path)` checked to start with `resolve(worktree)`. Blocks `../` traversal and absolute paths outside the worktree. |
| Shell escaping | `shellEscape()` wraps arguments in single quotes with embedded quote escaping. Prevents injection via tool arguments. |
| gVisor | Kernel-level syscall sandboxing as a second boundary. |

---

## Threat: Container Escape

An attacker who has achieved code execution inside the sandbox container
attempts to escape to the host or to the web container.

### Mitigations

| Layer | Mitigation |
|-------|------------|
| gVisor (runsc) | Intercepts all syscalls in userspace. The container never directly interacts with the host kernel. Eliminates entire classes of kernel exploit. |
| Container | `cap_drop: ALL` — no Linux capabilities granted. |
| Container | `no-new-privileges` — cannot gain privileges via setuid/setgid binaries. |
| Container | Non-root user (`forge`) — no root access inside the container. |
| Docker network | Sandbox container is on the `sandbox` network only. Cannot reach the `web` network where the database and API keys live. |
| Ephemeral storage | tmpfs for repos. No persistent data to exfiltrate across restarts. |

---

## Threat: Denial of Service

A malicious repo or LLM loop could exhaust resources.

### Attack vectors

| Vector | Description |
|--------|-------------|
| Large repos | Git clone of a multi-GB repository |
| Zip bombs | Compressed objects that expand massively |
| Infinite tool loops | LLM calling tools repeatedly |
| CPU-intensive patterns | Regex patterns in rg that cause catastrophic backtracking |
| Fork bombs | Spawning processes to exhaust PIDs |

### Mitigations

| Layer | Mitigation |
|-------|------------|
| tmpfs | `/tmp:rw,size=64m` limits temp storage to 64MB |
| Container | Docker/Podman resource limits can be applied (CPU, memory) |
| ask-forge | `MAX_TOOL_ITERATIONS` config limits the LLM tool call loop |
| ask-forge-web | Session TTL (30 min) with automatic cleanup |
| bwrap | PID namespace limits visibility but does not limit fork count |

### Open items

- **No explicit resource limits on the sandbox container** in compose.
  Consider adding `deploy.resources.limits` for CPU and memory.
- **No per-operation timeout** in the sandbox worker. A hung git clone or
  tool call blocks the request indefinitely. Consider request-level timeouts.
- **No repo size limit**. Consider a `--depth 1` shallow clone or checking
  `Content-Length` of the remote before cloning.

---

## Threat: Data Leakage Between Sessions

One user's session should not be able to access another user's data.

### Mitigations

| Layer | Mitigation |
|-------|------------|
| bwrap (tools) | Per-worktree isolation via tmpfs + ro-bind. Each tool call can only see its own worktree. |
| Path validation | Resolved paths must stay within the worktree root. |
| ask-forge-web | Sessions are identified by random UUID. Session IDs are not guessable. |
| Sandbox worker | Repos are keyed by URL slug + commit SHA. Different commits of the same repo get separate worktrees. |

### Open items

- **Bare repo is shared across sessions** for the same repository URL. Two
  sessions querying the same repo at different commits share the same bare
  clone. This is a read-only resource but is worth noting.
- **No authentication on the sandbox worker HTTP API**. Any process on the
  `sandbox` compose network can call it. Currently only the web container is
  on that network.

---

## Defense in Depth Summary

Each operation passes through multiple independent security layers. A failure
in any single layer does not compromise the system.

```
Tool call from LLM
  │
  ├─ Layer 3: Path validation (code)
  │   Resolved path must be within worktree root.
  │
  ├─ Layer 2: bwrap (OS namespaces)
  │   Filesystem: only worktree visible.
  │   Network: completely isolated.
  │   PID: only own process tree visible.
  │
  ├─ Layer 1: gVisor (runsc)
  │   All syscalls intercepted in userspace.
  │   Container cannot interact with host kernel.
  │
  └─ Layer 0: Container hardening
      cap_drop ALL, no-new-privileges, non-root,
      isolated network, ephemeral storage.
```

```
Git clone
  │
  ├─ Layer 3: Git config hardening (code)
  │   Hooks disabled, protocol restricted to http(s).
  │
  ├─ Layer 2: bwrap (OS namespaces)
  │   Filesystem: write access only to repo dir.
  │   PID: isolated.
  │   Network: NOT isolated (TODO).
  │
  ├─ Layer 1: gVisor (runsc)
  │   All syscalls intercepted in userspace.
  │
  └─ Layer 0: Container hardening
      cap_drop ALL, no-new-privileges, non-root,
      isolated network, ephemeral storage.
```
