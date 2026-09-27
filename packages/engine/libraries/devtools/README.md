# `@downdraft/engine/libraries/devtools`

DevTools bridge — mirrors profiling and inspection data to a developer UI.

## Two frontends

**Web DevTools (current)** — `WebDevtoolsHost` runs a development-only loopback
server (`DevToolsServer`, `Bun.serve`: HTTP static + WebSocket JSON-RPC) and
serves the browser frontend in `packages/devtools-web`. Pressing **F12** in a
native game opens the devtools in a desktop browser (`--app` window on
Chromium-family browsers, falling back through brave → vivaldi → firefox →
chrome → edge → `xdg-open`). Discovery files are written to
`~/.downdraft/devtools/<pid>.json` (port + token), mirroring the MCP
`~/.downdraft/port` convention.

**egui overlay (legacy)** — `NativeDebuggerHost` + `DevtoolsMirror` render the
Rust egui crate's PaintJobs into a GPU texture composited over the frame.
Kept in-tree while the web path is verified on real hardware; slated for
removal.

Both frontends consume the same provider/command model:
`registerEngineProviders(mirror, ctx)` works on either mirror
(`DevtoolsProviderTarget`), and `PanelSnapshot` sections (`kv`, `table`,
`series`, `lines`, `controls`) render in both.

## Wire protocol (WS)

- client → `{id, method, params}`; server → `{id, result|error}`
- server → `{event, data}` pushes: `hello`, `console`, `threads`, `scene`,
  `dom`, `gpu`, `metrics`, `snapshot`, `profile`, `console.clear`,
  `devtools.close`/`devtools.focus`
- RPC methods: `ping`, `eval {thread,expr}`, `sceneTree`, `domTree {mode}`,
  `gpuInfo`, `metrics`, `threads`, `snapshot {panel}`, `command
  {panel,action,payload}`, `inspector.call {method,args}` (invokes
  `window.__sceneInspector.*`), `profile.start|stop`, `console.clear`,
  `domTree.mode`

## Key exports

- `WebDevtoolsHost`, `WebDevtoolsMirror`, `DevToolsServer`, `openDevToolsUrl`
- `NativeDebuggerHost`, `DevtoolsMirror` (legacy egui path)
- `CdpBridge`, `registerEngineProviders`, `PANEL`, `SNAP_FLAG`, `SNAP_STATUS`,
  `encodeSnapshot`, `checkpoint`, `notify`, `verifyPixel`

## Test

```sh
bun test packages/engine/libraries/devtools/src/web/devtools-web.spec.ts
```

Runs fully headless (Bun.serve + in-process WebSocket client).
