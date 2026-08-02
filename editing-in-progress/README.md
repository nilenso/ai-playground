# Editing in Progress

A local-first collaborative Markdown editor implemented entirely in
Deno/TypeScript. Deno-WebUI opens the loopback UI in a native WebView window.

## Architecture

- `server/` contains the Deno CLI, HTTP/WebSocket transport, SCRAM-SHA-256, room
  policy, Automerge document handling, local persistence, and recovery.
- `ui/` contains the React 19 + MDXEditor + Automerge interface.
- `server/window.ts` opens the authenticated loopback URL through the pinned
  Deno-WebUI binding. It does not read documents or collaboration traffic.
- Remote collaboration is always coordinator-mediated over the `collab.v1`
  WebSocket protocol. Clients never connect directly to one another.

Each installation owns one writable current document. Online peer documents can
be selected and viewed read-only. Owner updates are pushed live to existing
viewers.

## Requirements

- Deno **2.9.4** to build and test
- Linux: the GTK WebView runtime required by WebUI
- macOS: WKWebView

The installed public command contains the Deno runtime, TypeScript application,
and bundled UI. A checksummed WebUI native library is shipped beside it. An
installed user does not need Deno, Zig, or network access on first launch.

## Build and test

```sh
deno task check
deno task test
deno task build
deno task check:webui
```

`deno task build` bundles the UI, verifies the vendored native library, and
compiles this host-specific package:

```text
dist/
├── editing-in-progress
└── lib/libwebui-2.so       # Linux
```

The macOS package contains `lib/libwebui-2.dylib` instead. Distribute the whole
directory without separating the executable from `lib/`. The application loads
the sidecar by a path relative to its executable. It never downloads native code
at runtime. `EIP_WEBUI_LIBRARY_PATH` is available as a development override.

Cross-compile a supported release package by setting `EIP_TARGET`:

```sh
EIP_TARGET=aarch64-apple-darwin deno task build
```

Supported targets are Linux and macOS on x86-64 and ARM64. Explicit-target
outputs are written beneath `dist/<target>/`.

GitHub Actions runs formatting, type checks, tests, and native-sidecar
initialization, then builds all four supported targets. Each workflow run
publishes a `editing-in-progress-<target>` artifact containing the executable,
its required `lib/` sidecar, documentation, configuration example, and an
archive SHA-256 file. Install or distribute the complete extracted directory.

## Run modes

After building, run the public command:

```sh
dist/editing-in-progress serve
dist/editing-in-progress edit
dist/editing-in-progress edit --serve
```

- `serve` runs the in-memory room coordinator.
- `edit` runs the local application service, connects to the configured
  coordinator, and opens the native window.
- `edit --serve` starts both in one Deno process.

For source-level development, the equivalent entry point is `deno task app`.

The coordinator exposes `GET /health` and `/v1` with WebSocket subprotocol
`collab.v1`.

## Configuration

On first run, Deno creates a private `0600` configuration file at:

```text
~/.config/editing-in-progress/config.toml
```

It contains a random installation UUIDv4, 32-byte room secret, SCRAM salt, and
local defaults. The installation UUID must remain unique and stable. To join a
different coordinator, edit the coordinator URL and copy that room's secret,
salt, and iteration count—but keep your own UUID.

`config.example.toml` is a manually editable template. Every credential in the
example is intentionally `[REDACTED]`.

Use `wss://` through a TLS-terminating reverse proxy for any non-loopback
coordinator. Plain `ws://` is accepted only for loopback hosts.

## Local files and recovery

- Open/save operations occur in Deno, never in the browser or coordinator.
- Only a basename such as `notes.md` crosses the collaboration connection;
  absolute paths remain local.
- MRU paths and owner recovery are stored beneath
  `~/.local/share/editing-in-progress/` using bounded, versioned formats and
  atomic private-file replacement.
- Recovery contains only the local owner's Automerge snapshot and dirty/
  unsynchronized flags. It has no fields for secrets, paths, presence, or remote
  documents.
- Remote snapshots remain in memory and cannot be saved through the editor UI.

## Security and room policy

SCRAM-SHA-256 authentication and client verification of the server signature
complete before either side accepts application data. Frames are binary,
versioned, bounded to 16 MiB, and strictly decoded. The coordinator rejects
duplicate active UUID sessions and binds every write to the authenticated owner
UUID.

SCRAM proves possession of the room secret but does **not** encrypt presence,
filenames, or Markdown; TLS remains mandatory outside localhost. A shared room
secret proves room membership, not individual identity: a holder can claim an
offline UUID in protocol v1.

The coordinator keeps all room state in memory. On disconnect, an owner is no
longer available to new viewers. Existing viewers may retain the already-open
document for up to 30 minutes. Reconnection within that interval restores normal
visibility; expiry removes the retained state and tells existing viewers to
close it.

The local UI service binds only to loopback and protects API and event requests
with a fresh random bearer token included in the native-window URL. It does not
enable cross-origin access.

## Dependencies

The TypeScript application pins React, ReactDOM, MDXEditor, and Automerge in
`deno.json`. Deno-WebUI 2.5.15 is vendored under `vendor/deno-webui/` because
upstream's loader downloads mutable nightly binaries at runtime. Compatible
native WebUI snapshots for every supported target are vendored under `native/`,
checksummed during every package build, and documented in `native/README.md`.
