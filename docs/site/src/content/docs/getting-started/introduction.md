---
title: Introduction
description: What DownDraft Engine is and what it can do
---

DownDraft Engine is an AI-driven game engine built on **Electron + electron-vite + WebGPU** (TypeScript-first, optional Rust native modules for audio). It includes a built-in MCP server that enables AI agents to design, build, debug, and manage game assets via natural language prompts.

## What can it do?

- **Render** — Deferred WebGPU pipeline with G-Buffer, shadow maps, post-processing, and a Bevy-style render graph with automatic resource aliasing.
- **Simulate** — Archetype-based ECS with change detection, hierarchy, and double-buffered events running in an isolated Web Worker.
- **Physics** — Pluggable physics abstraction with Rapier3D backend, multi-realm support, and character controllers.
- **Audio** — Spatial audio with Kira backend via Rust FFI, mixer, effects, and listener tracking.
- **Animate** — Skeletal animation, GLTF skinning, GPU compute skinning, Mixamo retargeting, and blend trees (1D/2D).
- **Network** — WebSocket transport, state replication, and RPCs via the networking plugin.
- **AI Integration** — MCP server (JSON-RPC over stdio) for AI agents to create scenes, spawn entities, manage assets, and debug.
- **Editor** — DevTools panel, material graph editor, animation state machine editor, asset browser, and performance profiler.

## Platform Support

DownDraft runs on **Linux, macOS, and Windows** via Electron. The WebGPU renderer requires a compatible GPU and browser engine (Chromium-based via Electron).

## Technologies

| Layer | Technology |
|---|---|
| Runtime | Electron + Bun |
| Rendering | WebGPU / WGPU |
| Language | TypeScript (engine), Rust (native modules) |
| Physics | Rapier3D (Rust FFI) |
| Audio | Kira (Rust FFI) |
| Database | SurrealDB (SurrealKV, embedded) |
| UI | React + Tailwind CSS |
| AI | MCP (JSON-RPC over stdio) |

## License

MIT
