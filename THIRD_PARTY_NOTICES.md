# Third-Party Notices

DownDraft embeds or distributes components under the following licenses.
This file summarizes the notable ones; it is not a substitute for the
upstream license texts, which ship inside each component's distribution.

## JavaScript runtimes (embedded in packaged apps)

| Component | License | Notes |
|---|---|---|
| **Bun** (incl. JavaScriptCore/WebKit) | MIT (Bun); LGPL-2.1 / BSD / Apple public licenses (JSC) | Compiled binaries produced by `bun build --compile` embed Bun and therefore JavaScriptCore. Bun's own third-party notice list: <https://bun.sh/docs/project/licensing> |
| **Node.js** (libnode / `node` host) | MIT (Node); bundled deps under MIT/BSD/ISC/OpenSSL/etc. (libuv, llhttp, c-ares, zlib, brotli, simdjson, nghttp2, uvwasi, openssl) | Full notices: <https://github.com/nodejs/node/blob/main/LICENSE> |
| **Deno** | MIT | <https://github.com/denoland/deno/blob/main/LICENSE.md> |

## Rust crates (linked into cdylibs)

| Component | License | Notes |
|---|---|---|
| **winit** | Apache-2.0 | Windowing / event loop |
| **wgpu / naga** | MIT OR Apache-2.0 | WebGPU implementation |
| **rapier3d** (`@dimforge/rapier3d`, rapier crates) | Apache-2.0 | Physics |
| **kira** | MIT OR Apache-2.0 | Spatial audio |
| **blitz / stylo / parley** | MIT OR Apache-2.0 | HTML/CSS rasterization for html-ui |
| **android-activity**, **ndk** (Android shell) | MIT OR Apache-2.0 | Android `NativeActivity` glue |
| **freetype-sys** | FTL (FreeType License, GPL-compatible) or MIT/Apache-2 | Text rasterization |

The complete Rust dependency license set is auditable with
[`cargo-deny`](https://embarkstudios.github.io/cargo-deny/) — see
[`deny.toml`](./deny.toml), run in CI.

## npm packages of note

| Package | License | Notes |
|---|---|---|
| **koffi** | MIT | FFI adapter for the Node host |
| **xxh3-ts** | BSD-2-Clause | Save-integrity hashing |
| **quickjs** bindings | MIT | QuickJS VM plugin format |

## Optional heavyweight UI backends (downloaded, not vendored)

| Component | License | Notes |
|---|---|---|
| **CEF (Chromium Embedded Framework)** | BSD-3-Clause + Chromium notices | Optional `--webui=cef` backend |
| **WPE WebKit** | LGPL-2.1 / BSD | Optional `--webui=wpe` backend |

## Verifying

- Rust: `cargo deny check` (see `deny.toml`)
- npm: `bun run licenses` / `license-checker` step in CI
- Distributables: run the license check before `draft release` publishes.
