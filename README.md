# DownDraft Engine

An AI-Driven Game Engine built on Electrobun + Bun + WGPU (TypeScript-first, Rust FFI for hotspots), with a built-in MCP server enabling AI agents to design, build, debug, and manage assets for games via natural language prompts.

## Quick Start

```bash
# Install dependencies
bun install

# Run tests
bun test

# Scaffold a new game
bun run packages/cli/src/index.ts init my-game

# Start dev server
cd my-game
draft dev
```

## Architecture

- **Bun Main Process** — Engine orchestrator, render loop (GpuWindow + WGPU), MCP server
- **Sim Worker** — ECS world, game systems, physics, AI, plugins
- **DB Worker** — Persistence layer with schema versioning
- **BrowserWindow** — React UI overlay (transparent, composites over GpuWindow)

## Packages

| Package | Description |
|---|---|
| `@downdraft/core` | Engine core: ECS, render, SAB, input, telemetry, plugins |
| `@downdraft/ui` | React UI components (editor panels, devtools) |
| `@downdraft/mcp` | MCP server for AI agent interaction |
| `@downdraft/shader-graph` | Material/shader graph compiler |
| `@downdraft/cli` | CLI tool (`draft init/dev/build/export`) |
| `@downdraft/plugin-*` | First-party plugins (water, terrain, physics, audio, networking) |

## License

MIT
