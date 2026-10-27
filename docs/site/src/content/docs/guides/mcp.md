---
title: MCP & AI Agents
description: MCP server for AI-driven app development
---

DownDraft includes a built-in MCP (Model Context Protocol) server that enables AI agents to design, build, debug, and manage app assets via natural language prompts.

## Overview

The MCP server speaks JSON-RPC over two transports: newline-delimited **stdio** (`MCPServer.start()` — the classic spawn-as-an-MCP-process mode) and **HTTP** on 127.0.0.1 (`McpHttpTransport`, used by the in-app endpoints below). Both expose the same tools, resources, and prompt templates for interacting with the engine.

## Tools

MCP tools allow AI agents to perform actions:

| Tool | Description |
|---|---|
| Scene | Create, modify, and remove scenes |
| Entity | Spawn, modify, and remove entities |
| Component | Add/remove components on entities |
| Material | Create/modify materials and shaders |
| Mesh | Import, generate, and modify meshes |
| Animation | Create and modify animation clips |
| Lighting | Set up lights, shadows, and GI |
| Camera | Camera placement and framing |
| Physics | Configure physics, colliders, and forces |
| Audio | Audio sources, listeners, and mixing |
| Script | App logic scripting (TypeScript) |
| Asset | Import, convert, and manage assets |
| Debug | Inspect state, profile, and visualize |
| Checkpoint | Create/restore checkpoints, undo/redo |
| Inspect | Rich object inspection (deep component dump, hierarchy traversal, query by path) |
| Build | Build, package, and export app |

## Resources

Resources provide read-only data to AI agents:

| Resource | Description |
|---|---|
| Scene Tree | Live scene hierarchy (parent/child tree) |
| Entity State | Entity component dump (rich, recursive) |
| Performance | Frame timings, system timings |
| GPU Info | Adapter info, buffer sizes, draw calls |
| Asset List | Asset inventory |
| Checkpoint List | Available checkpoints and undo/redo history |

## Prompt Templates

Pre-defined prompt templates guide AI agents through common tasks:

- **Create Scene** — Scaffold a new scene with entities and components
- **Add Entity** — Add an entity to an existing scene
- **Debug Frame** — Diagnose rendering or performance issues

## Telemetry via MCP

In dev mode or with `--debug` flag, telemetry is exposed via MCP tools:

- `profile_frame()` — Profile a single frame
- `get_telemetry(duration)` — Get telemetry for a duration

All threads and processes report GC pause duration, memory usage, and CPU time. Telemetry has zero overhead in prod mode (instrumentation is compiled out).

## App automation endpoint (running apps)

Separate from the editor server above, every running app exposes an in-process MCP automation endpoint (JSON-RPC over HTTP on `127.0.0.1`) for testing and scripted verification: `capture_screenshot`, `inject_input`, `wait_for_condition`, `get_player_state`, `get_world_state`, `set_test_state`, and app-specific tools. Each instance writes `~/.downdraft/port/<pid>` with its bound port; clients discover the newest live instance automatically.

The endpoint is dev/test infrastructure — `draft release` / `scripts/package-native.mjs` compile it out of distributed binaries (`--mcp` retains it, still runtime-gated by `DOWNDRAFT_MCP=1`).

Three ways to talk to it:

```bash
draft mcp instances                      # list live app instances
draft mcp tools                          # list tools (name + description)
draft mcp call get_world_state           # call a tool, JSON args optional
draft mcp screenshot shot.png            # capture_screenshot → file
draft mcp run verify.ts --app my-app   # launch app → run script → kill
draft mcp stdio                          # stdio→HTTP bridge for MCP clients
```

```ts
import { AppClient, launchApp } from "@downdraft/engine/mcp/client";

const app = await launchApp({ app: "my-app", deterministic: true });
const state = await app.client.callJson("get_world_state");
await app.client.screenshot("shot.png");
await app.kill();
```

`draft mcp` prints tool text output to stdout (capped at `--max-bytes`, default 256 KiB); image/binary blocks are never inlined — pass `--out <file>` or `--json`.

## Editor endpoint (createMcpModule)

`@downdraft/engine/modules/mcp`'s `createMcpModule` hosts the full editor toolset above (tools + resources + prompts) inside a running app, backed by the live world via `EngineContext.fromApp`. With `transport: "http"` it serves JSON-RPC on a second loopback port through `McpHttpTransport` direct mode — alongside, and independent of, the automation endpoint. It advertises `~/.downdraft/port/<pid>.editor` (+ `<pid>.editor.token`), so the same clients reach it with one selector:

```bash
draft mcp --editor tools                          # editor toolset
draft mcp --editor call get_scene_info            # live-world scene info
draft mcp --editor stdio                          # stdio→HTTP bridge to the editor endpoint
draft mcp --editor instances                      # only instances advertising an editor endpoint
```

```ts
const client = await AppClient.connect({ endpoint: "editor" }); // or DOWNDRAFT_MCP_ENDPOINT=editor
```

`MCP_EDITOR_PORT` pins the port (default: ephemeral OS-assigned). With the default `transport: "stdio"`, the module instead speaks newline-delimited JSON-RPC on the process's own stdin/stdout.
