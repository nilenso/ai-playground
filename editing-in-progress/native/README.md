# Vendored WebUI native libraries

These release-mode native libraries are bundled so `editing-in-progress` never
downloads executable code at runtime.

- Binding: `webui-dev/deno-webui` 2.5.15, vendored from commit
  `eeb43ac3dc86d11b2e97fd146a4582fc81455b2e`.
- Native snapshot: WebUI nightly assets downloaded 2026-07-30 while repository
  HEAD was `b08e7b8b0732316c8f0d543091ee4c7b4904f4dc`.
- Source asset base:
  `https://github.com/webui-dev/webui/releases/download/nightly/`.
- License: `LICENSE.webui`.

The build verifies each library before packaging:

| Target       | File                                      | SHA-256                                                            |
| ------------ | ----------------------------------------- | ------------------------------------------------------------------ |
| Linux x86-64 | `x86_64-unknown-linux-gnu/libwebui-2.so`  | `ecca096b65f7733db44dfaa28f35bd98da6e2d1aadcfcb2e2368981aee20ad57` |
| Linux ARM64  | `aarch64-unknown-linux-gnu/libwebui-2.so` | `fef75489a44ab85730b4285dc8cefda389a4c44ddaf5abb244759df249cace82` |
| macOS x86-64 | `x86_64-apple-darwin/libwebui-2.dylib`    | `fbdc419f49d63b30360019199d2a67cfb160675e8939a7ba28b484181c31e222` |
| macOS ARM64  | `aarch64-apple-darwin/libwebui-2.dylib`   | `5dff107cc17a1aa683c945dda74b79027df1836035e0c0b055c304c99ddb7fc8` |

To update this snapshot, review the corresponding WebUI source and Deno binding
together, replace every target library, update all hashes, and rerun
`deno task check:webui` plus the full test/build matrix.
