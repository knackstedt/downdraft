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

## `draft build [path] [options]`

Builds the game for the target platform.

| Flag | Description |
|---|---|
| `--game <name>`, `-g` | Game to build (resolves `games/<game>`; overrides path) |
| `--target=<t>` | Target: `current` / `win` / `linux` / `mac` (default: `current`) |
| `--mode=<m>` | Build mode: `dev` / `debug` / `prod` (default: `prod`) |
| `--out=<dir>` | Output directory (default: `dist`) |
| `--no-minify` | Disable minification |
| `--sourcemap` | Generate source maps (on by default in non-prod modes) |
| `--verbose`, `-v` | Verbose logging |

## `draft build-games [options]`

Builds + packages multiple games for desktop and/or mobile. Used by VSCode tasks.

| Flag | Description |
|---|---|
| `--games=<csv>` | Comma-separated game directory names (required) |
| `--platforms=<csv>` | Comma-separated platform specs (required, e.g. `win:portable,android:all`) |
| `--verbose`, `-v` | Verbose logging |

Platform spec grammar: `win:portable|nsis`, `linux:AppImage|deb|rpm|flatpak`, `mac:dmg|zip`, `android:all`, `ios:all`.

## `draft dist [options]`

Packages a game for distribution via `electron-builder`. Loads the game's `build.config.ts` (factory-based, per-game branding) or falls back to the `build` block in `package.json`.

| Flag | Description |
|---|---|
| `--game <name>`, `-g` | Game to package (required; `games/<game>`) |
| `--target <t>`, `-t` | Target: `win` / `linux` / `mac` / `all` (default: `all`) |
| `--config <path>`, `-c` | Explicit path to a `build.config.ts` / config file |
| `--project-dir <path>` | Override the project directory (default: repo root) |
| `--verbose`, `-v` | Verbose logging |

## `draft export [path] [options]`

Packages a built game for distribution with per-platform launchers. Copies `dist/` and generates platform-specific launcher scripts.

| Flag | Description |
|---|---|
| `--target=<t>` | Target: `win` / `linux` / `mac` / `all` (default: `all`) |
| `--out=<dir>` | Output directory (default: `export`) |
| `--no-compress` | Disable compression |
| `--verbose`, `-v` | Verbose logging |

> Output directory names remain `windows/`, `macos/`, `linux/` for back-compat of the generated layout; only the flag values are normalized to `win`/`mac`/`linux`.

## `draft mobile [options]`

Builds and scaffolds a Capacitor mobile target (Android / iOS) from the engine-owned native shell. See the [Mobile guide](/guides/mobile/) for details.

| Flag | Description |
|---|---|
| `--game <name>`, `-g` | Game to build (required; `games/<game>`) |
| `--target <t>`, `-t` | Target: `android` / `ios` / `all` (default: `all`) |
| `--port <n>` | Embedded HTTP server port (default: `8765`) |
| `--skip-build` | Skip the web bundle build (use existing `dist/mobile/`) |
| `--skip-gradle` | Skip the Gradle APK build (shell + sync only) |
| `--no-icons` | Skip icon generation (use `mobile-overrides/` or fail) |
| `--no-overrides` | Skip `mobile-overrides/` merge layer |
| `--verbose`, `-v` | Verbose logging |

```bash
# Build and scaffold for both platforms
draft mobile --target=all

# Android only, skip rebuild
draft mobile --target=android --skip-build

# Android, skip Gradle (shell + sync only)
draft mobile --target=android --skip-gradle

# iOS with custom port
draft mobile --target=ios --port=9000
```

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

Runs e2e tests via MCP automation. Boots the real Electron app with `DOWNDRAFT_DETERMINISTIC=1`, waits for the MCP HTTP endpoint, and runs the e2e spec via `bun test`.

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
| `DOWNDRAFT_STRICT` | `packages/core/src/plugin/diagnostics.ts` | `0`/`1` force-disable/enable plugin DI validation (else = Vite dev mode) |
| `DOWNDRAFT_OSR_DISABLE_SHARED_TEXTURE` | `packages/plugins/electron-osr/.../osr-renderer.ts` | `1`/`true` disables OSR shared-texture path |
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

# Build + scaffold mobile (Android + iOS)
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
```
