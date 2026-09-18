---
title: Installation
description: Prerequisites and setup for DownDraft Engine
---

## Prerequisites

Before installing DownDraft Engine, ensure you have the following tools installed:

### Bun

DownDraft uses [Bun](https://bun.sh) as its package manager and runtime.

```bash
curl -fsSL https://bun.sh/install | bash
```

### Node.js

Node.js is required by Electron's tooling. Install via your system package manager or [nvm](https://github.com/nvm-sh/nvm):

```bash
# Via nvm
nvm install --lts
nvm use --lts
```

### Rust (optional, for native modules)

Rust is only needed if you're building the native audio or physics libraries from source.

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

## Get the Source

```bash
git clone https://github.com/knackstedt/downdraft-engine.git
cd downdraft-engine
```

## Install Dependencies

```bash
bun install
```

This installs all workspace dependencies via Bun workspaces, including `@downdraft/engine`, `@downdraft/engine/app`, `@downdraft/engine/ui`, `@downdraft/cli`, and all first-party plugins.

## Verify Installation

Run a game to verify everything works:

```bash
draft dev --game=to-the-ocean
```

This launches `electron-vite dev` against that game's own `games/<game>/electron.vite.config.ts` entrypoint. You should see an Electron window with the WebGPU canvas and React UI overlay.

## Running a Specific Game

```bash
draft dev --game=<game-name>
```

## Next Steps

- [Development](/getting-started/development/) — Learn the dev workflow and project structure
- [ECS Guide](/guides/ecs/) — Understand the entity component system
- [CLI Reference](/reference/cli/) — Explore the `draft` CLI commands
