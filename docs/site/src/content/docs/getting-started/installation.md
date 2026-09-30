---
title: Installation
description: Prerequisites and setup for DownDraft Engine
---

## Prerequisites

Before installing DownDraft Engine, ensure you have the following tools installed:

### Bun

DownDraft uses [Bun](https://bun.sh) as its package manager and **default** JS runtime — games execute against the native platform library via runtime-adapted FFI (`bun:ffi` under Bun). Node+tsx (`koffi`) and Deno (`Deno.dlopen`) are also supported hosts via `draft dev --runtime=node|deno`, but Bun is required regardless for dependency installation (`bun.lock`), `bun test`, and `draft release` packaging (`bun build --compile`).

```bash
curl -fsSL https://bun.sh/install | bash
```

### Rust (optional, for native modules)

Rust is only needed if you're building the platform or audio native libraries from source.

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

## Get the Source

```bash
git clone https://github.com/knackstedt/downdraft-engine.git
cd downdraft-engine
git submodule update --init --recursive
```

## Install Dependencies

```bash
bun install
bun run link:games
```

This installs all workspace dependencies via Bun workspaces, then links `@downdraft/*` packages into every game's `node_modules`.

## Verify Installation

Run a game to verify everything works:

```bash
cd games/to-the-ocean
draft dev
```

This launches the game on the native runtime via its `src/native-entry.ts` entrypoint. You should see a native window with the WebGPU-rendered scene and devtools overlay.

## Running a Specific Game

```bash
cd games/<game-name> && draft dev
```

## Next Steps

- [Development](/getting-started/development/) — Learn the dev workflow and project structure
- [ECS Guide](/guides/ecs/) — Understand the entity component system
- [CLI Reference](/reference/cli/) — Explore the `draft` CLI commands
