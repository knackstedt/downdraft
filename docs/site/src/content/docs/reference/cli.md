---
title: CLI Commands
description: draft CLI tool reference
---

The DownDraft CLI is available via `bun run packages/cli/src/index.ts <command>` or as `draft` if installed globally.

## `draft init [path]`

Scaffolds a new game project with directory structure, `main.ts` entry point, and `downdraft.config.json`.

```bash
draft init my-game
```

## `draft dev [options]`

Starts the engine in dev mode via `electron-vite dev`.

| Flag | Description |
|---|---|
| `--watch` | Enable hot reload |

> **Note:** The primary dev workflow is `bun run dev` (which runs `electron-vite dev`). To run a specific game, set `DOWNDRAFT_GAME=<game-name>`.

## `draft debug [options]`

Runs the engine in debug mode with profiling, debug draw, and visualization tools.

| Flag | Description |
|---|---|
| `--verbose, -v` | Verbose logging |
| `--no-devtools` | Disable devtools overlay |
| `--inspector` | Enable Node inspector |

## `draft build [options]`

Builds the game for the target platform.

| Flag | Description |
|---|---|
| `--target=<platform>` | Target: `current` / `windows` / `macos` / `linux` |
| `--mode=<mode>` | Build mode: `dev` / `debug` / `prod` |
| `--out=<dir>` | Output directory (default: `dist`) |
| `--no-minify` | Disable minification |
| `--sourcemap` | Generate source maps |

## `draft export [options]`

Packages the built game for distribution.

| Flag | Description |
|---|---|
| `--target=<platform>` | Target: `all` / `windows` / `macos` / `linux` |
| `--out=<dir>` | Output directory (default: `export`) |
| `--no-compress` | Disable compression |

## Examples

```bash
# Initialize a new game
draft init my-game

# Run in dev mode
bun run dev

# Run a specific game
DOWNDRAFT_GAME=my-game bun run dev

# Build for production
draft build --mode=prod --out=dist

# Package for all platforms
draft export --target=all --out=export
```
