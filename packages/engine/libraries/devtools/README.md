# `@downdraft/engine/libraries/devtools`

DevTools data/transport layer — the transport-neutral backend (providers,
collectors, eval routing, CDP) plus the loopback WS server that remote
viewers attach to. Renders nothing itself.

## Frontend

**`@downdraft/devtools`** — the devtools surface. Embedded as an in-window
overlay (F12; auto-mounted by `bootstrapGame` when the package is installed)
or launched standalone via `draft devtools` to attach to running targets.
The removed Blitz dock and `devtools-web` browser SPA are gone.

## Backend host

`EmbeddedDevtoolsHost` owns `DevtoolsBackend` + `CdpBridge` for a game —
created per game by `bootstrapGame` (`devtools.ui:"devtools"`, the default)
and landed on `renderer.nativeDebugger`. Pumped per frame; providers and
thread evals exist regardless of which frontend is attached.

## Frontends & transports

- **`EmbeddedDevtoolsHost`** — in-process backend owner (`embedded-host.ts`).
- **`WebDevtoolsMirror` + `DevToolsServer`** (`web/`) — JSON-RPC transport
  over loopback WS (`Bun.serve`): the overlay's `attachSelfMirror` and any
  external viewer consume a target's backend through it. Discovery files are
  written to `~/.downdraft/devtools/<pid>.json` (port + token), mirroring
  the MCP `~/.downdraft/port` convention.

All frontends consume the same provider/command model:
`registerEngineProviders(target, ctx)` works on any
`DevtoolsProviderTarget`, and `PanelSnapshot` sections (`kv`, `table`,
`series`, `lines`, `controls`) render everywhere.

## Wire protocol (WS)

- client → `{id, method, params}`; server → `{id, result|error}`
- server → `{event, data}` pushes: `hello`, `console`, `threads`, `scene`,
  `dom`, `gpu`, `metrics`, `snapshot`, `profile`, `console.clear`,
  `devtools.close`/`devtools.focus`
- RPC methods: `ping`, `eval {thread,expr}`, `sceneTree`, `domTree {mode}`,
  `gpuInfo`, `metrics`, `threads`, `snapshot {panel}`, `command
  {panel,action,payload}`, `inspector.call {method,args}` (invokes
  `window.__downdraftDevtools.*`), `profile.start|stop`, `console.clear`,
  `domTree.mode`

## Key exports

- `EmbeddedDevtoolsHost`, `DevtoolsBackend`, `CdpBridge`
- `WebDevtoolsMirror`, `DevToolsServer`
- `registerEngineProviders`, `PANEL`, `SNAP_FLAG`, `SNAP_STATUS`,
  `checkpoint`, `notify`, `verifyPixel`

## Test

```sh
bun test packages/engine/libraries/devtools/src/web/devtools-web.spec.ts
```

Runs fully headless (Bun.serve + in-process WebSocket client) against a
tiny fixture webroot under `web/fixtures/`.
