---
title: CLI Commands
description: draft CLI tool reference
---

The DownDraft CLI is available via `bun run packages/cli/src/index.ts <command>` or as `draft` if installed globally.

## Global options

| Flag | Description |
|---|---|
| `--help`, `-h` | Show help for a command (`draft <cmd> --help` or `draft help <cmd>`) |
| `--version`, `-V` | Print the CLI version and exit |

Run `draft` with no arguments to see the top-level command list.

## `draft new [path] [options]`

Scaffolds a new app project with directory structure, a `src/native-entry.ts` entry point, and `downdraft.config.json`.

| Flag | Description |
|---|---|
| `--template=<name>` | Project template: `minimal` / `physics` / `full` / `appmodule` (default: `minimal`) |
| `--name=<n>` | Project name (defaults to directory basename) |
| `--description=<d>` | Project description |
| `--author=<a>` | Author name |
| `--version=<v>` | Initial version (default: `0.1.0`) |
| `--ai-companion` | Scaffold `.devin/` config + `engine-prompt.md` |
| `--force` | Scaffold into a non-empty directory |
| `--list-templates` | List available templates and exit |

```bash
draft new my-app
draft new my-app --template=physics --ai-companion
draft new --list-templates
```

## `draft dev [options]`

Starts the app on the native runtime — a JS-runtime process hosting a winit window and the wgpu device, with an embedded Vite dev shell providing tiered HMR. Run from an app directory (the app is inferred by walking up from cwd looking for `downdraft.config.json` or `src/native-entry.ts`).

| Flag | Description |
|---|---|
| `--entry <path>` | App entrypoint file (defaults to `src/native-entry.ts`) |
| `--port <n>` | MCP HTTP port (default: auto-assign) |
| `--runtime <r>` | JS runtime hosting the dev shell: `bun` / `node` / `deno` (default: `DD_RUNTIME` env → `"runtime"` in `downdraft.config.json` → auto-detect) |
| `--watch` | Back-compat no-op — the dev shell always watches |
| `--no-hmr` | Disable HMR — spawn the entry directly (`bun run`), no dev shell |
| `--verbose`, `-v` | Verbose logging |

> **Note:** Each app boots from its own `src/native-entry.ts`. `draft dev` infers the app from the current directory; there is no root dispatcher or `DOWNDRAFT_APP` env var.

## `draft debug [path] [options]`

Runs the engine in debug mode with profiling, debug draw, and visualization tools.

| Flag | Description |
|---|---|
| `--verbose`, `-v` | Verbose logging |
| `--no-devtools` | Disable devtools overlay (sets `DOWNDRAFT_DISABLE_DEVTOOLS=1`) |
| `--inspector` | Enable Node inspector (`chrome://inspect`) |

## `draft release [options]`

Unified build + package pipeline. The legacy `build`, `dist`, `export`, `mobile`, and `build-apps` commands were removed.

| Flag | Description |
|---|---|
| `--app <name>`, `-g` | App to release (name or directory; resolves `apps/<name>` when run from the engine root). For multiple apps, use `--apps`. |
| `--apps=<csv>` | Comma-separated app names (e.g. `my-app,my-app`) |
| `--target <t>`, `-t` | Target: `win` / `linux` / `mac` / `android` / `all` (default: `all`). `android` can't mix with desktop targets in one invocation. |
| `--runtime=<r>` | JS runtime embedded in the package: `bun` (compiled binary) / `node` / `deno` / `all` (default: `build.runtime` in package.json → `"runtime"` in `downdraft.config.json` → `bun`). `node`/`deno` are linux-only today — win/mac targets still embed bun. |
| `--format=<csv>` | Linux package formats: `dir` / `deb` / `appimage` / `flatpak` (default: `build.linux.target` in package.json, else `dir`). |
| `--stage=<s>` | Stage: `build` / `package` / `release` (all compile the same native binary; default: `release`) |
| `--mode=<m>` | Build mode: `dev` / `debug` / `prod` (default: `prod`) |
| `--abi=<csv>` | Android ABI(s): `arm64-v8a` / `x86_64` / `all` (android target only) |
| `--min-sdk=<n>` | Android minimum SDK (default: 30; android target only) |
| `--node-flavor=<f>` | Embedded Node build flavor: `full` (default) / `lite` — lite drops intl/inspector/sqlite/amaro (android target only) |
| `--libs=<csv>` | Force-include optional engine cdylibs, comma-separated (android target only) |
| `--exclude-libs=<csv>` | Exclude optional engine cdylibs, comma-separated (android target only) |
| `--no-strip` | Keep debug info/symtab in packaged `.so`s (android target only) |
| `--out=<dir>` | Artifact output directory (default: `release`) |
| `--skip-build` | Alias for `--stage=package` |
| `--build-only` | Alias for `--stage=build` |
| `--mcp` | Retain the MCP automation endpoint in the packaged binary (stripped by default) |
| `--verbose`, `-v` | Verbose logging |

```bash
# Full release for all desktop platforms
draft release --app=my-app

# Build stage only (compile the native binary)
draft release --app=my-app --stage=build

# Specific targets
draft release --app=my-app --target=win,linux

# Linux .deb + AppImage + Flatpak for every supported JS runtime
draft release --app=my-app --target=linux --runtime=all --format=deb,appimage,flatpak

# Android APK (native winit+wgpu shell with embedded libnode)
draft release --app=my-app --target=android

# Multiple apps at once
draft release --apps=my-app,my-app --target=all
```

### What gets produced

- **win / mac** — a standalone Bun binary (`<out>/<app>-<target>`) via `packages/cli/scripts/package-native.mjs`, plus a sibling `native/` cdylib and `dd-assets/` staging tree. Windows binaries get version-info/icon resource stamping via `resedit`.
- **linux** — `packages/cli/scripts/package-desktop.mjs`, an electron-builder-style packager. The appdir layout is identical across runtimes (`<exe>` + `bundle/` + `native/` + `dd-assets/`, all anchored on `dirname(process.execPath)`); each `--format` then wraps it:
  - `dir` — the staged appdir verbatim
  - `deb` — `dpkg-deb` package (`/usr/lib/<exe>` + `/usr/bin` symlink + desktop file + hicolor icons)
  - `appimage` — AppDir + `appimagetool` (auto-downloaded to `~/.cache/downdraft/tools/`; works without FUSE via `APPIMAGE_EXTRACT_AND_RUN`)
  - `flatpak` — generated manifest + `flatpak-builder` + `build-bundle`
- **android** — `packages/cli/scripts/package-mobile.mjs` assembles the APK directly (no Gradle): bundle + workers emitted as `.mjs`, embedded libnode, `lib/<abi>/` engine + app `.so`s, `.node` addons staged under the bundle's `native/` dir.

See the [Packaging & Distribution guide](/guides/packaging/) for the `build` block in `package.json`, the runtime matrix, and native-module staging.

### Removed commands

The legacy commands were removed; use the equivalent `release` invocation:

| Old command | Equivalent |
|---|---|
| `draft build` | `draft release --stage=build` |
| `draft dist` | `draft release --stage=package` |
| `draft export` | `draft release --stage=package` |
| `draft build-apps` | `draft release --apps=<csv> --target=<csv>` |
| `draft mobile` | `draft release --target=android` |

## `draft assets <command> [project] [options]`

Manages remote asset packs (pull, push, list, init, add, add-store).

| Subcommand | Description |
|---|---|
| `init [project]` | Create an empty `downdraft.assets.json` manifest |
| `add-store <name> [project]` | Add a blob store backend to the manifest |
| `add <pack> [project]` | Add an asset pack to the manifest |
| `pull [project]` | Download all manifest packs to local cache |
| `push [project]` | Upload local `assets/` dir to configured store |
| `list [project]` | Show manifest packs and local cache status |

**`add-store` flags:**

| Flag | Description |
|---|---|
| `--bucket=<name>` | S3 bucket name (required) |
| `--endpoint=<url>` | S3-compatible endpoint URL |
| `--region=<r>` | AWS region (default: `us-east-1`) |
| `--path-style` | Use path-style addressing |

**`add` flags:**

| Flag | Description |
|---|---|
| `--version=<v>` | Pack version (default: `1.0.0`) |
| `--store=<name>` | Store name — must exist in manifest (required) |
| `--path=<p>` | Remote path prefix (defaults to pack name) |

**`push` flags:**

| Flag | Description |
|---|---|
| `--pack=<name>` | Pack name to push (defaults to first pack) |
| `--store=<name>` | Store name to push to |
| `--path=<p>` | Remote path prefix override |

**Global flags:** `--verbose`, `-v` — verbose logging.

## `draft test [options]`

Runs e2e tests via `bun:test`. Sets `DOWNDRAFT_DETERMINISTIC=1` (fixed seed, paused render loop, no autosave) and `DOWNDRAFT_GPU=swiftshader` by default, then spawns `bun test <spec>`. The default smoke specs (`tests/e2e/<app>-smoke.spec.ts`) use the in-app MCP RPC harness to drive the app, but `--spec` can point at any `bun:test` file — the MCP harness is not required.

| Flag | Description |
|---|---|
| `--app <name>`, `-g` | App to test (required; resolves `apps/<name>` from the engine root, or the app dir from cwd) |
| `--spec <path>`, `-s` | Spec file to run (default: `tests/e2e/<app>-smoke.spec.ts`) |
| `--port <n>`, `-p` | MCP port (`0` = auto-assign a free port; default: `0`) |
| `--renderer <r>`, `-r` | WebGPU backend: `cpu` (SwiftShader) / `gpu` (hardware) (default: `cpu`) |
| `--no-deterministic` | Disable fixed seed / render loop pause |
| `--headed` | Show the window instead of running headless |
| `--verbose`, `-v` | Verbose logging |

```bash
# Default: SwiftShader + deterministic
draft test --app=my-app

# Hardware GPU
draft test --app=my-app --renderer=gpu

# Headed (show window)
draft test --app=my-app --headed

```

## Environment variables

### Set by the CLI (`draft test`)

| Variable | Value | Purpose |
|---|---|---|
| `MCP_PORT` | `<port>` | MCP HTTP transport port |
| `MCP_TIMEOUT_MS` | `120000` | MCP proxy IPC round-trip timeout (ms) |
| `DOWNDRAFT_GPU` | `swiftshader` \| `hardware` | WebGPU adapter selection (`auto` = hardware-first with software failover) |
| `DOWNDRAFT_DETERMINISTIC` | `1` | Fixed seed, paused render loop, no autosave |
| `DOWNDRAFT_HEADED` | `1` | Show the window in deterministic mode |

### Read by the CLI

| Variable | Used by | Purpose |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | `assets` | S3 credentials fallback (manifest config wins) |
| `AWS_SECRET_ACCESS_KEY` | `assets` | S3 credentials fallback |
| `DISPLAY` | `test` | When absent, wraps in `xvfb-run` |
| `DOWNDRAFT_STRICT_DIAGNOSTICS` | all commands | `1` → hard-error on unknown flags (warns otherwise) |

### Read by the runtime (set by CLI or user)

| Variable | Used by | Purpose |
|---|---|---|
| `DOWNDRAFT_STRICT_DIAGNOSTICS` | `packages/engine/core/src/module/diagnostics.ts` | `0`/`1` force-disable/enable module DI validation (else = Vite dev mode) |
| `DOWNDRAFT_MCP` | `packages/engine/core/src/util/logger.ts` | `1` routes logs to stderr (keeps stdout clean for MCP JSON-RPC) |
| `DOWNDRAFT_DISABLE_DEVTOOLS` | `packages/cli/src/debug.ts` | `1` disables the devtools UI entirely — forces `devtools.ui` to `"none"` (set by `draft debug --no-devtools`) |
| `DOWNDRAFT_GPU` | `packages/platform-native/src/gpu/adapter-policy.ts` | `swiftshader` (software only) \| `hardware` (real adapter only) \| `auto` (hardware-first, software failover — default) |
| `DOWNDRAFT_GPU_MODE` | `packages/platform-native/src/gpu/adapter-policy.ts` | `performance` \| `stability` — preset matching `downdraft.config.json` `"gpu": { "mode": … }`: `performance` (apps) = hardware-only, never silently degrade; `stability` (desktop apps) = graceful chain vulkan → gl(virgl) → software |
| `DOWNDRAFT_GPU_BACKEND` | `packages/platform-native/src/gpu/adapter-policy.ts` | `auto` \| `vulkan` \| `gl` \| `metal` \| `dx12` — restrict the wgpu instance to one backend (`gl`/virgl is experimental — presents on Wayland with reduced features, no screenshots) |
| `DOWNDRAFT_GPU_FALLBACK` | `packages/platform-native/src/gpu/adapter-policy.ts` | `0`/`1` — toggle the automatic software-adapter failover (default `1`) |
| `DOWNDRAFT_GPU_DENY` | `packages/platform-native/src/gpu/adapter-policy.ts` | Comma-separated substrings extending the built-in adapter denylist (`venus`, `gfxstream`) |

## Examples

```bash
# Scaffold a new app
draft new my-app
draft new my-app --template=physics --ai-companion

# Run in dev mode (from the app directory)
cd my-app && draft dev

# Build for production
draft release --app=my-app --target=win
draft release --app=my-app --target=all --out=release

# Run e2e tests
draft test --app=my-app
draft test --app=my-app --renderer=gpu --headed

# Manage assets
draft assets init
draft assets add-store s3 --bucket=my-bucket --region=us-east-1
draft assets add textures --store=s3 --version=1.0.0
draft assets push
draft assets list

# Manage app plugins/mods (runtime extensions under <app>/plugins/)
draft plugin list                                    # list discovered plugin.json/mod.json
draft plugin new my-plugin --app=my-app            # scaffold plugin.json (worker-js)
draft plugin new my-plugin --app=my-app --format=wasm
draft mod new my-mod --app=my-app                  # alias — scaffolds mod.json (asset)
```
