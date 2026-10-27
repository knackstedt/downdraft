---
title: Installation
description: Prerequisites and setup for DownDraft Engine
---

## Prerequisites

Before installing DownDraft Engine, ensure you have the following tools installed:

### Bun

DownDraft uses [Bun](https://bun.sh) as its package manager and **default** JS runtime — apps execute against the native platform library via runtime-adapted FFI (`bun:ffi` under Bun). Node+tsx (`koffi`) and Deno (`Deno.dlopen`) are also supported hosts via `draft dev --runtime=node|deno` and as packaged runtimes via `draft release --runtime=node|deno` (linux), but Bun is required regardless for dependency installation (`bun.lock`), `bun test`, and as the packager's own host.

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
git clone https://github.com/knackstedt/downdraft.git
cd downdraft
```

## Install Dependencies

```bash
bun install
```

This installs all workspace dependencies via Bun workspaces. Apps are separate repos — if you develop an app alongside the engine under `apps/`, run `bun run link:apps` to link `@downdraft/*` packages into each app's `node_modules`.

## Verify Installation

Scaffold an app and run it to verify everything works:

```bash
draft new my-app
cd my-app
draft dev
```

This launches the app on the native runtime via its `src/native-entry.ts` entrypoint. You should see a native window with the WebGPU-rendered scene and devtools overlay.

## Running an Existing App

```bash
cd <app-directory> && draft dev
```

## Next Steps

- [Development](/getting-started/development/) — Learn the dev workflow and project structure
- [ECS Guide](/guides/ecs/) — Understand the entity component system
- [CLI Reference](/reference/cli/) — Explore the `draft` CLI commands
