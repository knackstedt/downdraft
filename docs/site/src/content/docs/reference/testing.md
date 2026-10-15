---
title: Testing & Automation
description: MCP automation harness, e2e smoke specs, deterministic mode, env vars, gotchas
---

## Game automation & headless testing

### MCP automation harness

Games register a renderer-side MCP automation harness wired to the in-process MCP HTTP endpoint (my-game: `games/my-game/src/mcp/setup.ts`) built on `createStandardAutomationTools()` — exposing the standard tool set plus game-specific tools without importing the Node-only `@downdraft/engine/mcp` server bundle into the renderer. Injected input is merged with real input in `processInput()` so the game loop can't tell human from test.

### Connecting an MCP client to the game

The game's MCP HTTP transport (`packages/engine/mcp/src/http-transport.ts`) supports both Streamable HTTP and HTTP+SSE transports. By default it binds to an **ephemeral OS-assigned port** (port 0) so multiple game instances never collide. **The endpoint is dev/test infrastructure only — `scripts/package-native.mjs` (`draft release`) defines `__DD_MCP_STRIP__` so it's compiled out of distributed binaries; `--mcp` retains it (still runtime-gated by `DOWNDRAFT_MCP=1`).** Local MCP clients (e.g. IDE integrations) typically use stdio, so `draft mcp stdio` forwards JSON-RPC messages from stdin/stdout to the game's HTTP endpoint.

**Instance discovery:** Each running game writes `~/.downdraft/port/<pid>` (content = the bound port number; `<pid>.token` holds the bearer token when auth is required). `GameClient.connect()` / `draft mcp` / the stdio bridge all read this directory, prune dead-PID files, and connect to the newest live instance. A game that registers `createMcpModule({ transport: "http" })` additionally serves the full editor toolset (`MCPServer` — tools + resources + prompts) on a second port via `McpHttpTransport` direct mode, advertised as `<pid>.editor` (+ `<pid>.editor.token`); reach it with `draft mcp --editor` or `GameClient.connect({ endpoint: "editor" })`. Optional env vars:
- `MCP_APP_ID=<appId>` — narrow to instances of a specific game (matches `--user-data-dir=<path>` basename on Linux; e.g. `downdraft-my-game`).
- `MCP_PID=<pid>` — connect to a specific PID.
- `DOWNDRAFT_MCP_URL` / `MCP_HTTP_URL=<url>` — explicit URL override (skips discovery; used by the e2e test harness and `draft mcp run`).
- `DOWNDRAFT_MCP_ENDPOINT=editor` — connect to the instance's editor endpoint instead of the automation endpoint.
- `MCP_EDITOR_PORT=<port>` — pin the editor endpoint's port (createMcpModule http transport; default ephemeral).

To connect:
1. Start the game: `cd games/my-game && DOWNDRAFT_GPU=swiftshader DOWNDRAFT_DETERMINISTIC=1 draft dev`
2. The MCP config (`.devin/mcp_config.json`) runs `bun packages/cli/src/index.ts mcp stdio`.
3. The bridge discovers the port from `~/.downdraft/port/<pid>` and forwards `initialize`, `tools/list`, `tools/call` to `http://localhost:<port>/mcp`.
4. Notifications (messages without an `id` field, like `notifications/initialized`) are silently ignored by the bridge.
5. `resources/list` and `prompts/list` return empty lists (the game doesn't expose resources or prompts).

**Multiple instances:** Launch as many games as you like — each gets its own ephemeral port and PID file. Clients connect to the newest by default; use `--app`/`--pid` (or `MCP_APP_ID`/`MCP_PID`) to target a specific game.

**Programmatic client (`@downdraft/engine/mcp/client`):** the single implementation of discovery + handshake + envelope unwrapping — used by `draft mcp`, the stdio bridge, and the e2e harness. Node- and Bun-compatible.

```ts
import { GameClient, launchGame } from "@downdraft/engine/mcp/client";

const client = await GameClient.connect();          // PID-file discovery
const tools = await client.listTools();
const state = await client.callJson("get_world_state");
await client.screenshot("shot.png");

const game = await launchGame({ game: "my-game", deterministic: true });
await game.client.callText("get_player_state");
await game.kill();                                   // process-tree kill
```

**One-shot shell access:** `draft mcp` calls game MCP tools directly from bash (replaces the old `scripts/mcp-call.mjs`). Output contract: payload on stdout, diagnostics on stderr, text capped at `--max-bytes` (256 KiB), image blocks never inline — `--out <file>` writes them to disk, `--json` prints the raw envelope with `data` elided to `{bytes}`.

```bash
draft mcp instances                              # live instances (pid, port, appId)
draft mcp tools                                  # tools/list (name + description)
draft mcp tools --schema get_world_state         # one tool's inputSchema
draft mcp call get_world_state                   # tools/call, no args
draft mcp call set_test_state '{"weather":1}'    # tools/call with JSON args
draft mcp screenshot shot.png                    # capture_screenshot → file
draft mcp run script.ts --game my-game      # launch game → run script (gets DOWNDRAFT_MCP_URL) → kill
```

Key bridge fixes:
- Notifications (no `id`) must not receive a response — the bridge silently drops them.
- The proxy handler wraps errors in the `result` field; the bridge detects `result.error` and converts it to a proper MCP `error` response.

### Running the smoke test

**No game repo?** The `tests/e2e/<game>-smoke.spec.ts` specs require a local
clone under `games/<name>` (games are separate repositories, not shipped in
this repo). A self-contained e2e path exists for contributors:
`bun test tests/e2e/packaging-smoke-smoke.spec.ts` launches the tracked
`examples/packaging-smoke` fixture headless and asserts its worker/asset
pipeline completes; `.github/workflows/packaging.yml` exercises the full
package matrix against the same fixture. `draft test --game=packaging-smoke`
also resolves it via `examples/`.

The `draft test` CLI command (`packages/cli/src/test.ts`) sets `DOWNDRAFT_DETERMINISTIC=1` (fixed seed, paused render loop, no autosave, no window) and `DOWNDRAFT_GPU=swiftshader` by default, then spawns `bun test <spec>`. It does **not** launch the game or wait for the MCP endpoint itself — that is the spec's job (via the harness). The default smoke specs (`tests/e2e/<game>-smoke.spec.ts`) use the in-game MCP RPC harness to launch and drive the game, but `--spec` can point at any `bun:test` file; the MCP harness is not required.

```bash
# CPU rendering (SwiftShader, headless) — default, for CI
bun run draft:test-cpu

# GPU rendering (hardware Vulkan, headless)
bun run draft:test

# Show the window while testing (useful for debugging)
bun run draft:test -- --headed
bun run draft:test-cpu -- --headed

# Direct CLI usage
draft test --renderer=gpu --headed
draft test --renderer=cpu --spec tests/e2e/my-game.spec.ts
```

**CLI flags:**
- `--renderer <gpu|cpu>` — WebGPU backend. `cpu` = SwiftShader software (default), `gpu` = hardware Vulkan.
- `--headed` — Show the native winit window instead of running headless. Sets `DOWNDRAFT_HEADED=1`.
- `--game <name>` — Game to test. Resolves `games/<name>` or `examples/<name>` from the engine root, or the game dir from cwd. Resolves spec to `tests/e2e/<game>-smoke.spec.ts`.
- `--spec <path>` — Override the spec file path.
- `--port <n>` — MCP port (default: `0` = auto-assign a free port).
- `--no-deterministic` — Disable fixed seed / render loop pause / window hiding.

`draft test` sets the env vars in the consolidated table below (`DOWNDRAFT_DETERMINISTIC`, `DOWNDRAFT_GPU`, `DOWNDRAFT_HEADED`, `MCP_PORT`, `MCP_TIMEOUT_MS`).

**Headless / CI without a display:** The CLI auto-detects missing `DISPLAY` and wraps in `xvfb-run` if available. Install it with `sudo apt install xvfb`. winit still needs an X server even when the window is hidden — wgpu renders to the window surface via SwiftShader when `DOWNDRAFT_GPU=swiftshader`.

**Legacy scripts** (still available, bypass the CLI): `bun run test:e2e` (raw `bun test`, inherits env), `test:e2e:headless` (forces `DOWNDRAFT_GPU=swiftshader`), `test:e2e:local` (hardware GPU).

`tests/e2e/harness.ts` launches `bun games/<game>/src/native-entry.ts`, waits for the native MCP HTTP health endpoint, and drives the game through MCP tool calls. The smoke test (`tests/e2e/<game>-smoke.spec.ts`) verifies that the tool surface exists, the simulation ticks, injected input advances the world, and a screenshot can be captured.

**Build mode:** `draft release --stage=build` (or `--build-only`) compiles the native binary without packaging. Production-build e2e uses `draft release`.

**Dynamic ports:** `draft test` and the harness auto-allocate a free MCP port via `findFreePort()` (binds port 0 — OS-assigned), enabling parallel spec execution. Specs read the port from `process.env.MCP_PORT` (set by `draft test --port` or the auto-allocated default). To run multiple specs simultaneously, omit `--port` and let each spec pick its own.

**Process cleanup:** The harness kills the entire process group (the game process and its worker threads) on test completion. It uses `process.kill(-pid, SIGTERM)` with a SIGKILL fallback after 5s.

**Retry logic:** The harness `callToolWithRetry()` method retries MCP operations on transport errors (connection refused, timeouts) with exponential backoff. Tool-level errors (isError: true) are not retried.

### CLI environment variables — consolidated reference

The CLI reads and sets a number of environment variables. This is the complete list; see `docs/site/src/content/docs/reference/cli.md` for the full CLI flag reference.

**Set by the CLI (`draft test`):**

| Variable | Value | Purpose |
|---|---|---|
| `MCP_PORT` | `<port>` | MCP HTTP transport port (unset = ephemeral, auto-discovered via `~/.downdraft/port/<pid>`; `draft test` auto-allocates a free port via `findFreePort()`) |
| `MCP_TIMEOUT_MS` | `120000` | MCP proxy IPC round-trip timeout (ms) — must exceed the longest `wait_for_condition` call |
| `DOWNDRAFT_GPU` | `swiftshader` \| `hardware` | Read by the native adapter request (`native-rs/src/gpu/mod.rs`): `swiftshader` forces wgpu's fallback/software adapter (SwiftShader/lavapipe), `hardware` keeps the caller's power preference; also forwarded to the game env as the harness's `gpu:` launch option |
| `DOWNDRAFT_DETERMINISTIC` | `1` | Skip autosave, no devtools auto-open/error dialogs, paused render loop (on-demand via `set_test_state`/`capture_screenshot`). Reaches the game as `downdraft.deterministic` on the bridge; sim seed stays game-supplied (`simConfig.seed`) |
| `DOWNDRAFT_HEADED` | `1` | Show the winit window in deterministic mode (without it `window.ts` suppresses `win.show()`) |
| `DOWNDRAFT_TEST_BUILT` | `1` | Launch the built app instead of the dev server |

**Read by the CLI:**

| Variable | Used by | Purpose |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | `assets` | S3 credentials fallback (manifest config wins) |
| `AWS_SECRET_ACCESS_KEY` | `assets` | S3 credentials fallback |
| `DISPLAY` | `test` | When absent, wraps in `xvfb-run` |
| `DOWNDRAFT_STRICT_DIAGNOSTICS` | all commands | `1` → hard-error on unknown CLI flags (warns otherwise) |

**Read by the runtime (set by CLI or user):**

| Variable | Used by | Purpose |
|---|---|---|
| `DOWNDRAFT_STRICT_DIAGNOSTICS` | `packages/engine/core/src/module/diagnostics.ts` | `0`/`1` force-disable/enable module DI validation (else = Vite dev mode) |
| `DOWNDRAFT_MCP` | `packages/engine/core/src/util/logger.ts` | `1` routes logs to stderr (keeps stdout clean for MCP JSON-RPC) |
| `DOWNDRAFT_DISABLE_DEVTOOLS` | `packages/cli/src/debug.ts` | `1` disables the devtools UI entirely — forces `devtools.ui` to `"none"` (set by `draft debug --no-devtools`) |
| `DOWNDRAFT_MULTI_INSTANCE` | `packages/platform-native/src/host-lifecycle.ts` | `1` opts out of the per-game `singleton.lock` |
| `DOWNDRAFT_GPU_TIMESTAMPS` | `packages/platform-native/src/native-host.ts` | `1` enables the extended wgpu timestamp features (`timestamp-query-inside-passes`) on non-CPU adapters — off by default due to device-loss on lavapipe-class rasterizers and some discrete Vulkan drivers |

### E2E test verification — checking for JS errors

**Do NOT rely solely on test pass/fail to verify correctness.** The e2e tests drive the game through MCP tool calls and assert on returned state, but uncaught JS errors in the game process (uncaught Promise rejections, TypeError from polyfill gaps) will NOT cause test failures unless explicitly checked.

The harness (`tests/e2e/harness.ts`) captures console output from the game process and exposes it via `game.getConsoleErrors()`. Tests should include a final assertion that no JS errors occurred:

```ts
it("no uncaught JS errors during the test run", async () => {
  await sleep(500); // wait for pending async errors to surface
  const errors = game!.getConsoleErrors();
  if (errors.length > 0) console.error("Console errors:\n" + errors.join("\n"));
  expect(errors).toEqual([]);
});
```

When verifying changes, always:
1. Run `bun run tsc` — type-check both web and node configs
2. Run the e2e test with `DOWNDRAFT_GPU=swiftshader` (CPU rendering for CI)
3. Grep the full test output for error patterns: `grep -E "Uncaught|TypeError|ReferenceError|WrongDocumentError|is not a function|is not defined" /tmp/downdraft-test-*.log`
4. Do NOT ignore errors that appear "during teardown" — they may indicate real bugs (e.g. uncaught Promise rejections from `requestPointerLock()`)

Common false positives to filter out: GTK module warnings, WebSocket connection failures during teardown, Vulkan/ICD loader chatter.

### E2E test gotchas

- **MCP port conflicts**: Ports are ephemeral by default, so this only bites if you pinned `--port`. Find the stuck instance via `draft mcp instances` / `~/.downdraft/port/`, free it with `fuser -k <port>/tcp`, or kill **only that game instance** as described in "Killing game processes" above — do NOT use a generic `pkill -9 bun` (it will kill unrelated Bun processes).
- **Save store hangs in test environments**: `createSaveStore()` can hang when OPFS is not available (SwiftShader/headless). The MCP harness must be registered BEFORE the save store init so e2e tests can connect.
- **`requestPointerLock()` may return a Promise**: `RenderSurface.requestPointerLock?()` is typed `Promise<void> | void` — when it returns a promise it can reject (detached surface, ESC cooldown). Always `.catch()` the return value to avoid uncaught rejections.

### Why not a WebGL2 fallback?

The engine relies on WebGPU-specific features (bindless `texture_2d_array`, storage buffers, compute passes, GBuffer MRT). A WebGL2 renderer would be a second, incompatible implementation. For testing, we instead use SwiftShader's Vulkan backend to run the unmodified WebGPU pipeline in software, and inject input through the renderer so the MCP harness never has to manipulate pointer lock or raw GPU output.

