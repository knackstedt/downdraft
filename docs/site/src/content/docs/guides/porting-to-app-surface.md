---
title: Porting to the App Surface
description: Migrate a DownDraft project from the Game* vocabulary to the neutral App* APIs, and adopt the desktop-app features (windows, menus, tray, dialogs, settings, damage-driven rendering).
---

DownDraft's public surface was renamed from `Game*` to `App*` in a single breaking release (no compatibility aliases). This guide is the migration path: a rename map for the mechanical part, then a checklist for adopting the new desktop-app capabilities.

## Rename map

### App model & boot

| Old | New |
| --- | --- |
| `GameModule` | `AppModule` |
| `GameContext` | `AppContext` |
| `GameSimWorker` | `SimWorker` |
| `GameUiHandle` | `UiHandle` |
| `GameSaveConfig` / `GameSaveSource` | `SaveConfig` / `SaveSource` |
| `startGame` | `startApp` |
| `bootstrapGame` / `BootstrapGameOptions` | `bootstrapApp` / `BootstrapAppOptions` |
| `createGameMcp` / `GameMcpOptions` | `createAppMcp` / `AppMcpOptions` |
| `runNativeGameModule` / `RunNativeGameModuleOptions` | `runNativeAppModule` / `RunNativeAppModuleOptions` |
| `startNativeGame` / `NativeGameOptions` | **deleted** — use `runNativeAppModule` or `createNativeHost` |
| `app/src/main/game-module.ts` | `app/src/main/app-module.ts` |
| `native-game-module.ts` | `native-app-module.ts` |
| `src/game-module.ts` (in projects) | `src/app-module.ts` |

### Renderer & loop

| Old | New |
| --- | --- |
| `GameRenderer` | `AppRenderer` |
| `GameRendererLike` | `AppRendererLike` |
| `GameRendererConfig` | `AppRendererConfig` |
| `GameLoop` / `GameLoopConfig` / `GameLoopStats` | `UpdateLoop` / `UpdateLoopConfig` / `UpdateLoopStats` |
| `GameWorld` | `AppWorld` |
| `GameBridge` (blitz-ui native) | `AppBridge` |
| `IGameDevToolsExtension` | `IAppDevToolsExtension` |

### Stores & saves

| Old | New |
| --- | --- |
| `BaseGameStoreState` / `GameStoreState` | `BaseAppStoreState` / `AppStoreState` |
| `createBaseGameStoreState` / `BaseGameStore` | `createBaseAppStoreState` / `BaseAppStore` |
| `createGameSaveSystem` / `GameSaveSystem(Options)` | `createSaveSystem` / `SaveSystem(Options)` |
| `HostAPI.saveGameState` / `loadGameState` / `deleteGameState` | `saveState` / `loadState` / `deleteState` |
| `SimBridge.pauseGame` / `resumeGame` / `resetGame` | `pauseSim` / `resumeSim` / `resetSim` |
| `hostServices.api.saveGame` / `loadGame` | `save` / `load` |
| `stores/game-store.ts`, `save/game-save-system.ts` | `stores/app-store.ts`, `save/save-system.ts` |

### Controller (was gamepad)

| Old | New |
| --- | --- |
| `@downdraft/engine/libraries/gamepad` | `@downdraft/engine/libraries/controller` |
| `GamepadLib` / `GamepadHub` / `GamepadSource` | `ControllerLib` / `ControllerHub` / `ControllerSource` |
| `GamepadDevice*` / `GamepadSnapshot` | `ControllerDevice*` / `ControllerSnapshot` |
| `SabGamepadSource` / `SysfsGamepadEnricher` | `SabControllerSource` / `SysfsControllerEnricher` |
| `GamepadDevicesChannel` / `Reader` / `HostMetaWriter` | `ControllerDevices*` |
| SAB channel `"gamepad-devices"` | `"controller-devices"` |
| `platform-native/src/gamepad` | `platform-native/src/controller` |
| `native-gamepad` crate (`downdraft_gamepad`) | `native-controller` (`downdraft_controller`) |
| `__ddGamepad` / `DOWNDRAFT_NO_GAMEPAD` | `__ddController` / `DOWNDRAFT_NO_CONTROLLER` |

The `dd_pad_*` FFI symbol names are unchanged.

### MCP client & tooling

| Old | New |
| --- | --- |
| `GameClient` / `GameInstance` / `GameClientOptions` | `AppClient` / `AppInstance` / `AppClientOptions` |
| `LaunchGameOptions` / `LaunchedGame` | `LaunchAppOptions` / `LaunchedApp` |
| `launchGame` / `listGameInstances` / `discoverGameInstance` | `launchApp` / `listAppInstances` / `discoverAppInstance` |
| `EngineContextFromGameOptions` | `EngineContextFromAppOptions` |
| `getGameInfo` / `formatGamesList` | `getAppInfo` / `formatAppsList` |

### CLI

| Old | New |
| --- | --- |
| `--game` / `-g` | `--app` / `-a` |
| `--games` | `--apps` |
| `draft mcp --app <name>` | `draft mcp --app-id <id>` (the launch name took over `--app`) |
| `scripts/link-games.mjs` | `scripts/link-apps.mjs` (`bun run link:apps`) |
| `draft new --template gamemodule` | `draft new --template appmodule` |
| `DD_GAME_DIR` | `DD_APP_DIR` |
| `resolveGameDir` / `findGameDirUpward` / `isGameDir` / `readGameConfig` | `resolveAppDir` / `findAppDirUpward` / `isAppDir` / `readAppConfig` |

Project dirs resolve `apps/<name>` → `games/<name>` → `examples/<name>`.

### Preserved on purpose

`navigator.getGamepads`, `XRInputSource.gamepad`, `GamepadEvent`, gilrs/winit type names, `GameCube`/`GameActivity`, game-domain data fields (`gameOver`, `gameplay`), and the MCP *tool* names (`get_player_state`, `inject_input`, …) kept their vocabulary — they're web/platform names, not ours.

## Adoption checklist

Renames get the project compiling; these adopt the new capabilities. Check `apps/desktop-demo` — the tracked reference app — for a working example of every row, driven end-to-end by `tests/e2e/desktop-demo-smoke.spec.ts`.

| App | Neutral rename | `appId` + `downdraft.paths`/`settings` | Window model (`AppWindow`, close veto) | `setMenu` + in-window fallback | Tray (`downdraft.tray`) | `onSecondInstance` | `damageOnly` render | `DD_DIALOGS_MOCK` in tests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| anableps | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| salticus | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| cruiser | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |

### 1. Lifecycle & windows

- `runNativeAppModule(module, { title, appId })` — `appId` (e.g. `downdraft-myapp`) is required for per-app storage, the singleton lock, and window-state persistence.
- `closePolicy: "lastWindow"` (default) quits when the last window closes; `"explicit"` hides the window so tray-resident apps stay alive until `downdraft.quit()`.
- `onCloseRequest: (win) => boolean | Promise<boolean>` — return `false` to veto (unsaved-changes prompts). Lower level: `window.setCloseIntercept(true)` + a cancelable `"closerequest"` event.
- `AppWindow.primary()` / `list()` / `create(opts)` — uniform runtime controls (`setTitle`, `setSize`, `minimize`, `maximize`, `setAlwaysOnTop`, `setFullscreen`, `requestAttention`, …) on the primary (handle 0) and secondary windows.

### 2. Menus, tray, dialogs, notifications, theme

- `downdraft.setMenu(model)` → `"native" | "inwindow" | "unavailable"`. On `"inwindow"` (Linux/Android, or `DD_MENU=inwindow`) mount the kit `menuBar({ model })` inside your html-ui doc — picks arrive through `onMenuAction` either way.
- `downdraft.tray?.create({ icon, tooltip, menu })` — Windows/macOS native, Linux via StatusNotifierItem/DBus (`false` when no SNI watcher). Tray picks arrive on `onMenuAction` as `"tray:<id>"` and stripped via `tray.onAction`. Pair with `closePolicy:"explicit"` for background apps.
- `downdraft.showOpenDialog` / `showSaveDialog` / `showMessageBox` — real `rfd` dialogs; `DD_DIALOGS_MOCK=1` resolves them synchronously in tests.
- `downdraft.notify({ title, body })` — desktop notifications where a backend exists.
- `downdraft.getTheme()` / `onThemeChanged(cb)` — `"light" | "dark" | "unknown"`.

### 3. Second-instance forwarding

- With `appId` set, a second launch forwards `{argv, cwd}` to the primary over `<configDir>/instance.sock` (named pipe on Windows) instead of silently dying — handle file-open-on-relaunch via `downdraft.onSecondInstance(({ argv, cwd }) => …)`. The primary raises/focuses itself by default (`focusOnSecondInstance:false` opts out). `DOWNDRAFT_MULTI_INSTANCE=1` and deterministic mode bypass the lock.

### 4. Settings & paths

- `downdraft.paths` → `{ configDir, dataDir, cacheDir }` (XDG split on Linux, `%APPDATA%`/`%LOCALAPPDATA%` on Windows, `~/Library` on macOS).
- `downdraft.settings` → typed KV persisted to `<configDir>/settings.json`: `get<T>(key, fallback)`, `set(key, value)`, `watch(key, cb)`, `flush()`.

### 5. Damage-driven rendering

- `new AppRenderer(canvas, { mode: "2d", damageOnly: true })` — skips surface acquire/submit/present on undamaged ticks and parks rAF on a keepalive (`damageIdleFps`, default 20Hz, `0` = full sleep). UI apps idle near zero CPU; `renderer.requestFrame()` and every input/damage source re-arm immediately.
- For UI-only apps: `renderer.setViewportCount(0)` after construction — the html-ui panels are the whole picture.

## Testing

`draft test --app=<name>` runs `tests/e2e/<name>-smoke.spec.ts` through the standard MCP harness (`launchApp`). The desktop-demo spec is the canonical example: menu backend, close veto, second-instance forwarding, idle pump counters, theme, settings, and `DD_DIALOGS_MOCK` dialogs — see `tests/e2e/desktop-demo-smoke.spec.ts`.
