---
title: Introduction
description: What DownDraft Engine is and what it can do
---

DownDraft Engine is an AI-driven game engine built on a **native runtime — winit + wgpu, hosted by Bun, Node, or Deno** (TypeScript-first, Rust native modules for platform and audio). Games run as a single JS-runtime process driving a native window and the GPU directly — no browser, no renderer process, no IPC boundary. It includes a built-in MCP server that enables AI agents to design, build, debug, and manage game assets via natural language prompts.

## What can it do?

- **Render** — Deferred WebGPU pipeline with G-Buffer, shadow maps, post-processing, and a Bevy-style render graph with automatic resource aliasing.
- **Simulate** — Archetype-based ECS with change detection, hierarchy, and double-buffered events running in an isolated worker thread.
- **Physics** — Pluggable physics abstraction with Rapier3D backend, multi-realm support, and character controllers.
- **Audio** — Spatial audio with Kira backend via Rust FFI, mixer, effects, and listener tracking.
- **Animate** — Skeletal animation, GLTF skinning, GPU compute skinning, Mixamo retargeting, and blend trees (1D/2D).
- **Network** — WebSocket transport, state replication, and RPCs via the networking plugin.
- **AI Integration** — MCP server (in-process, JSON-RPC) for AI agents to create scenes, spawn entities, manage assets, and debug.
- **Editor** — Native DevTools overlay, material graph editor, animation state machine editor, asset browser, and performance profiler.

## Platform Support

DownDraft runs on **Linux, macOS, and Windows** via the native runtime (winit for windowing, wgpu translating WebGPU to Vulkan, Metal, or D3D12). A compatible GPU is required; SwiftShader is available for headless testing.

## Technologies

| Layer | Technology |
|---|---|
| Runtime | Bun (default) / Node+tsx / Deno + winit (native windowing) |
| Rendering | WebGPU / wgpu |
| Language | TypeScript (engine), Rust (platform + native modules) |
| Physics | Rapier3D (Rust FFI) |
| Audio | Kira (Rust FFI) |
| Database | SurrealDB (SurrealKV, embedded) |
| UI | imui (immediate-mode WebGPU UI) + PixiJS |
| AI | MCP (JSON-RPC) |

## License

MIT
