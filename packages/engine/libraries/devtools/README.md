# `@downdraft/engine/libraries/devtools`

DevTools bridge — mirrors profiling and inspection data to a developer UI.

## Frontends

**Blitz devtools (docked, in-window)** — an html-ui/Blitz document rendered
inside the game window with Chrome-DevTools-style tabs. Lives in
`@downdraft/engine/modules/devtools` (`blitz/`). Toggled with **F12**.

**Web DevTools (separate browser window)** — `WebDevtoolsHost` runs a
development-only loopback server (`DevToolsServer`, `Bun.serve`: HTTP static
+ WebSocket JSON-RPC) and serves the browser frontend in
`packages/devtools-web`. Pressing **F12** opens the devtools in a desktop
browser (`--app` window on Chromium-family browsers, falling back through
brave → vivaldi → firefox → chrome → edge → `xdg-open`). Discovery files are
written to `~/.downdraft/devtools/<pid>.json` (port + token), mirroring the
MCP `~/.downdraft/port` convention.

Both frontends consume the same provider/command model:
`registerEngineProviders(target, ctx)` works on either
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
- `CdpBridge`, `registerEngineProviders`, `PANEL`, `SNAP_FLAG`, `SNAP_STATUS`,
  `checkpoint`, `notify`, `verifyPixel`

## Test

```sh
bun test packages/engine/libraries/devtools/src/web/devtools-web.spec.ts
```

Runs fully headless (Bun.serve + in-process WebSocket client).
