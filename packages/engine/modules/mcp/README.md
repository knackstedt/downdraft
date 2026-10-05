# `@downdraft/engine/modules/mcp`

MCP server module — hosts the Model Context Protocol automation server inside the engine process.

## Install

```sh
bun add @downdraft/engine/modules/mcp
```

## Key exports

- `EngineContext`
- `MCPServer`
- `McpServerTok`
- `createMcpModule`

`createMcpModule({ transport: "http" })` serves the editor toolset over HTTP on
127.0.0.1 (`McpHttpTransport` direct mode), advertised via
`~/.downdraft/port/<pid>.editor` — reach it with `draft mcp --editor` or
`GameClient.connect({ endpoint: "editor" })`. The default `"stdio"` transport
speaks newline-delimited JSON-RPC on the process's own stdin/stdout.

See the [Downdraft engine repository](https://github.com/knackstedt/downdraft) for architecture docs and examples.
