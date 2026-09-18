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

Scaffolds a new game project with directory structure, `main.ts` entry point, `downdraft.config.json`, and `electron.vite.config.ts`.

| Flag | Description |
|---|---|
| `--template=<name>` | Project template: `minimal` / `physics` / `full` / `gamemodule` (default: `minimal`) |
| `--name=<n>` | Project name (defaults to directory basename) |
| `--description=<d>` | Project description |
| `--author=<a>` | Author name |
| `--version=<v>` | Initial version (default: `0.1.0`) |
| `--ai-companion` | Scaffold `.devin/` config + `engine-prompt.md` |
| `--force` | Scaffold into a non-empty directory |
| `--list-templates` | List available templates and exit |

```bash
draft new my-game
draft new my-game --template=physics --ai-companion
draft new --list-templates
```

## `draft dev [options]`

Starts the engine in dev mode via `electron-vite dev` with HMR, loading the game's own `games/<game>/electron.vite.config.ts` entrypoint directly.

| Flag | Description |
|---|---|
| `--game <name>`, `-g` | Game to run (required; loads `games/<game>/electron.vite.config.ts`) |
| `--entry <path>` | Game entrypoint file (reserved for future mobile support) |
| `--port <n>` | MCP HTTP port (default: `9876`) |
| `--watch` | Accepted for back-compat (HMR is always on) |
| `--no-hmr` | Disable hot-module replacement |
| `--verbose`, `-v` | Verbose logging |

> **Note:** Each game owns its own `electron.vite.config.ts` entrypoint. `draft dev --game=<name>` loads it directly — there is no root dispatcher or `DOWNDRAFT_GAME` env var. You can also run `npx electron-vite dev --config games/<game>/electron.vite.config.ts` directly.

## `draft debug [path] [options]`

Runs the engine in debug mode with profiling, debug draw, and visualization tools.

| Flag | Description |
|---|---|
| `--verbose`, `-v` | Verbose logging |
| `--no-devtools` | Disable devtools overlay (sets `DOWNDRAFT_DISABLE_DEVTOOLS=1`) |
| `--inspector` | Enable Node inspector (`chrome://inspect`) |

## `draft release [options]`

Unified build + package + sign pipeline for desktop and mobile. Replaces the separate `build`, `dist`, `export`, `mobile`, and `build-games` commands (which remain as deprecated backward-compat aliases).

| Flag | Description |
|---|---|
| `--game <name>`, `-g` | Game to release (`games/<game>`). For multiple games, use `--games`. |
| `--games=<csv>` | Comma-separated game names (e.g. `sandjongg,to-the-ocean`) |
| `--target <t>`, `-t` | Target: `win` / `linux` / `mac` / `android` / `ios` / `all` (default: `all`) |
| `--format=<csv>` | Per-platform format (e.g. `win:portable,linux:AppImage`). Use `launcher` for bun-launcher folders. |
| `--stage=<s>` | Stage: `build` (Vite only) / `package` (package existing build) / `release` (build+package+sign, default) |
| `--mode=<m>` | Build mode: `dev` / `debug` / `prod` (default: `prod`) |
| `--out=<dir>` | Artifact output directory (default: `release`) |
| `--config <path>`, `-c` | Explicit path to an electron-builder config file |
| `--project-dir <path>` | Override the project directory (default: repo root) |
| `--port <n>` | Embedded HTTP server port (mobile, default: `8765`) |
| `--skip-build` | Alias for `--stage=package` |
| `--build-only` | Alias for `--stage=build` |
| `--skip-gradle` | Skip Gradle APK build (mobile) |
| `--no-icons` | Skip icon generation (mobile) |
| `--no-overrides` | Skip `mobile-overrides/` merge layer (mobile) |
| `--no-minify` | Disable minification (build stage) |
| `--sourcemap` | Generate source maps |
| `--verbose`, `-v` | Verbose logging |

```bash
# Full release for all platforms (desktop + mobile)
draft release --game=my-game

# Build only (Vite bundle, no packaging)
draft release --game=my-game --stage=build

# Package only (skip build, use existing dist/)
draft release --game=my-game --stage=package --target=win

# Windows portable + Linux AppImage
draft release --game=my-game --target=win,linux --format=win:portable,linux:AppImage

# Mobile only (Android + iOS) — experimental
draft release --game=my-game --target=android,ios

# Multiple games at once
draft release --games=sandjongg,to-the-ocean --target=all

# Launcher folders (lightweight bun-based distribution)
draft release --game=my-game --format=launcher
```

### Stages

| Stage | Desktop | Mobile (experimental) |
|---|---|---|
| `build` | `electron-vite build` → `dist/` | `vite build` (mobile config) → `dist/mobile/` |
| `package` | electron-builder → `release/` (or launcher folders if `--format=launcher`) | Capacitor shell + patch + sync + Gradle + sign → `release/` |
| `release` | build → package → collect | build → package → sign → collect |

### Deprecated commands (backward-compat aliases)

The old commands still work but emit a deprecation warning and delegate to `release`:

| Old command | Equivalent |
|---|---|
| `draft build` | `draft release --stage=build` |
| `draft dist` | `draft release --stage=package` |
| `draft export` | `draft release --stage=package --format=launcher` |
| `draft mobile` | `draft release --target=android,ios` |
| `draft build-games` | `draft release --games=<csv> --target=<csv>` |

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

Runs e2e tests via `bun:test`. Sets `DOWNDRAFT_DETERMINISTIC=1` (fixed seed, paused render loop, no autosave) and `DOWNDRAFT_GPU=swiftshader` by default, then spawns `bun test <spec>`. The default smoke specs (`tests/e2e/<game>-smoke.spec.ts`) use the in-game MCP RPC harness to drive the game, but `--spec` can point at any `bun:test` file — the MCP harness is not required.

| Flag | Description |
|---|---|
| `--game <name>`, `-g` | Game to test (required; `games/<game>`) |
| `--spec <path>`, `-s` | Spec file to run (default: `tests/e2e/<game>-smoke.spec.ts`) |
| `--port <n>`, `-p` | MCP port (default: `9976`) |
| `--renderer <r>`, `-r` | WebGPU backend: `cpu` (SwiftShader) / `gpu` (hardware) (default: `cpu`) |
| `--no-deterministic` | Disable fixed seed / render loop pause |
| `--headed` | Show the window instead of running headless |
| `--build` | Build the game with `electron-vite` before testing |
| `--build-only` | Only test the built app (skip dev server; requires prior build) |
| `--verbose`, `-v` | Verbose logging |

```bash
# Default: SwiftShader + deterministic
draft test

# Hardware GPU
draft test --renderer=gpu

# Headed (show window)
draft test --headed

# Test the built app
draft test --build
```

## Environment variables

### Set by the CLI (`draft test`)

| Variable | Value | Purpose |
|---|---|---|
| `MCP_PORT` | `<port>` | MCP HTTP transport port |
| `MCP_TIMEOUT_MS` | `120000` | MCP proxy IPC round-trip timeout (ms) |
| `DOWNDRAFT_GPU` | `swiftshader` \| `hardware` | WebGPU backend selection |
| `DOWNDRAFT_DETERMINISTIC` | `1` | Fixed seed, paused render loop, no autosave |
| `DOWNDRAFT_HEADED` | `1` | Show the window in deterministic mode |
| `DOWNDRAFT_TEST_BUILT` | `1` | Launch the built app instead of the dev server |

### Read by the CLI

| Variable | Used by | Purpose |
|---|---|---|
| `DD_RELEASE_KEYSTORE` | `mobile` | Release keystore path |
| `DD_RELEASE_KEYSTORE_PASS` | `mobile` | Keystore password |
| `DD_RELEASE_KEY_ALIAS` | `mobile` | Key alias |
| `DD_RELEASE_KEY_PASS` | `mobile` | Key password (falls back to store pass) |
| `AWS_ACCESS_KEY_ID` | `assets` | S3 credentials fallback (manifest config wins) |
| `AWS_SECRET_ACCESS_KEY` | `assets` | S3 credentials fallback |
| `ANDROID_HOME` | `mobile` | Android SDK path (build-tools + `local.properties`) |
| `ANDROID_SDK_ROOT` | `mobile` | Android SDK path (fallback) |
| `HOME` | `mobile` | `~/Android/Sdk`, `~/.android/debug.keystore`, `~/.downdraft/keystore.properties` |
| `DISPLAY` | `test` | When absent, wraps in `xvfb-run` |
| `ELECTRON_RUN_AS_NODE` | `test` | **Deleted** before spawning Electron |
| `DOWNDRAFT_STRICT` | all commands | `1` → hard-error on unknown flags (warns otherwise) |

### Read by the runtime (set by CLI or user)

| Variable | Used by | Purpose |
|---|---|---|
| `DOWNDRAFT_STRICT` | `packages/core/src/module/diagnostics.ts` | `0`/`1` force-disable/enable module DI validation (else = Vite dev mode) |
| `DOWNDRAFT_OSR_DISABLE_SHARED_TEXTURE` | `packages/modules/electron-osr/.../osr-renderer.ts` | `1`/`true` disables OSR shared-texture path |
| `DOWNDRAFT_MCP` | `packages/core/src/util/logger.ts` | `1` routes logs to stderr (keeps stdout clean for MCP JSON-RPC) |
| `DOWNDRAFT_DISABLE_DEVTOOLS` | `packages/app/src/main/handlers/devtools.ts` | `1` disables devtools auto-open (set by `draft debug --no-devtools`) |

## Examples

```bash
# Scaffold a new game
draft new my-game
draft new my-game --template=physics --ai-companion

# Run in dev mode
draft dev --game=my-game
# or directly:
npx electron-vite dev --config games/my-game/electron.vite.config.ts

# Build for production
draft build --mode=prod --out=dist
draft build --game=to-the-ocean --target=win

# Package for distribution
draft dist --target=all
draft export --target=all --out=export

# Build + scaffold mobile (Android + iOS) — experimental
draft mobile --target=all

# Run e2e tests
draft test
draft test --renderer=gpu --headed

# Manage assets
draft assets init
draft assets add-store s3 --bucket=my-bucket --region=us-east-1
draft assets add textures --store=s3 --version=1.0.0
draft assets push
draft assets list

# Manage game plugins/mods (runtime extensions under <game>/plugins/)
draft plugin list                                    # list discovered plugin.json/mod.json
draft plugin new my-plugin --game=my-game            # scaffold plugin.json (worker-js)
draft plugin new my-plugin --game=my-game --format=wasm
draft mod new my-mod --game=my-game                  # alias — scaffolds mod.json (asset)
```
