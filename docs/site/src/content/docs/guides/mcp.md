---
title: MCP & AI Agents
description: MCP server for AI-driven game development
---

DownDraft includes a built-in MCP (Model Context Protocol) server that enables AI agents to design, build, debug, and manage game assets via natural language prompts.

## Overview

The MCP server runs as a JSON-RPC server over stdio, providing AI agents with tools, resources, and prompt templates for interacting with the engine.

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
| Script | Game logic scripting (TypeScript) |
| Asset | Import, convert, and manage assets |
| Debug | Inspect state, profile, and visualize |
| Checkpoint | Create/restore checkpoints, undo/redo |
| Inspect | Rich object inspection (deep component dump, hierarchy traversal, query by path) |
| Build | Build, package, and export game |

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
