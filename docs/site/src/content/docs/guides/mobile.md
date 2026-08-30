---
title: Mobile (Android & iOS)
description: Build Android and iOS targets via Capacitor — reusing the existing WebGPU renderer, sim workers, and SAB architecture
---

DownDraft Engine supports Android and iOS build targets by wrapping the existing web-portable renderer/sim/worker stack in **Capacitor** (system WebView). The renderer, sim workers, SharedArrayBuffer layout, and libraries are **unchanged** from desktop — they run in the system WebView with the exact same WebGPU + Worker + SharedArrayBuffer code path.

## How it works

The engine is already cleanly split between **web-portable code** (renderer, sim, workers, libraries, plugins) and **Electron-only code** (main process, preload bridge, OSR, build tooling). Capacitor replaces only the Electron-only layer:

```
Desktop (Electron)                    Mobile (Capacitor)
─────────────────                     ──────────────────
Electron Main Process                 Native Shell (Android/iOS)
  createDowndraftApp()                  Embedded HTTP Server (COOP/COEP)
  BrowserWindow                         System WebView
  IPC handlers                          window.downdraft (mobile bridge)
  webGpuSwitches()                      (WebGPU enabled by WebView)
        │                                     │
        ▼                                     ▼
  ┌─────────────────────────────────────────────┐
  │  Renderer (WebGPU Canvas + UI Overlay)      │  ← unchanged
  │  Sim Web Worker (ECS, physics, plugins)     │  ← unchanged
  │  SharedArrayBuffer (zero-copy)              │  ← unchanged
  └─────────────────────────────────────────────┘
```

### Engine-owned native shell

The engine owns a **canonical, pre-wired native shell** at `packages/mobile-shell/` containing complete Android + iOS projects with the embedded HTTP server already wired in. `draft mobile` copies this shell into a per-game **gitignored** directory and patches in game-specific values (appId, appName, port, icons).

**Games commit zero native files.** The `android/` and `ios/` directories in each game are gitignored — regenerated from the shell on each `draft mobile` run. `draft mobile` auto-generates all config files if missing. Games only need to commit:

- `src/mobile.tsx` — mobile entry (auto-generated stub if missing — wire up and commit)
- `capacitor.config.ts` — auto-written if missing (can be customized)
- `icon.png` (optional) — 1024×1024 app icon for auto-generated icon sets
- `mobile-overrides/` (optional) — game-specific native customizations
- `mobile.vite.config.ts` (optional) — only if customizing Vite options (defaulted at build time)

### What runs unchanged

- `packages/core/src/render/*` — WebGPU renderer, device acquisition, input manager
- `packages/core/src/worker/*` — `BaseWorkerHost`, RPC, sim worker base
- `packages/core/src/sab/*` — SharedArrayBuffer layouts (zero-copy sim↔renderer)
- `packages/core/src/input/*`, `packages/core/src/ecs/*` — input state, job system
- All `packages/libraries/*` — water, physics, persistence (OPFS/IndexedDB), etc.
- All `packages/plugins/*` (except `electron-osr`) — camera, devtools, terrain, movement, sailing
- `packages/app/src/renderer/*` — `startGame()`, `GameModule`, `bootstrapGame()`, bridge accessor

### What is replaced/skipped

- `packages/app/src/main/*` (Electron main) → `packages/app/src/mobile/*` (mobile host)
- `packages/app/src/preload/*` (IPC bridge) → mobile bridge (web APIs + Capacitor plugins)
- `packages/plugins/electron-osr/*` → skipped (use DOM overlay for UI)
- `electron.vite.config.ts` → `mobile.vite.config.ts` (web-only Vite build)

## Platform requirements

WebGPU is the gating constraint. The system WebView must support it:

| Platform | Minimum | Notes |
|----------|---------|-------|
| Android | WebView 121+ | WebGPU shipped in Chrome 121 for Android |
| iOS / iPadOS | **26+** (Tahoe) | **Not iOS 18.** Safari-the-browser got WebGPU at iOS 18, but the WKWebView component only enabled it at iOS 26. |

Older devices cannot run DownDraft games via this path. There is no WebGL fallback (that would require a second renderer backend — a major architectural change).

## SharedArrayBuffer & cross-origin isolation

The engine's sim architecture uses `SharedArrayBuffer` for zero-copy renderer↔sim communication. SAB requires **cross-origin isolation** (COOP `same-origin` + COEP `require-corp`) on the top-level document.

Capacitor's default custom-scheme loading (`capacitor://localhost` on iOS) makes COOP/COEP header control unreliable. The reliable fix is an **embedded local HTTP server** inside the native app that serves the web assets with COOP/COEP headers, pointing the WebView at `http://127.0.0.1:<port>`.

The engine-owned native shell has the embedded server **pre-wired**:

- **Android:** `MainActivity.java` starts `EmbeddedServer` (NanoHTTPD) in `onCreate()` before the bridge loads, then overrides the WebView URL. The NanoHTTPD dependency is already in `app/build.gradle`.
- **iOS:** `AppDelegate.swift` starts `EmbeddedServer` (Swift Network framework) in `didFinishLaunchingWithOptions()`. `SceneDelegate.swift` overrides the WebView URL. The ATS exception for `127.0.0.1` is in `Info.plist`.

**No manual native code editing is required.** The shell handles everything.

## Adding mobile support to a game

### Zero-config path

Just run `draft mobile --game=<name>`. The command auto-generates everything you need:

| File | Auto-generated? | Notes |
|---|---|---|
| `capacitor.config.ts` | Written if missing | Correct appId, appName, webDir, server URL |
| `mobile.vite.config.ts` | Defaulted at build time | No file needed unless customizing Vite options |
| `src/mobile.tsx` | Written if missing | Stub with placeholder GameModule — wire up and commit |

The only prerequisite is installing Capacitor deps (see below).

### Full setup

#### 1. Install Capacitor dependencies

```bash
bun add -d @capacitor/cli @capacitor/core @capacitor/android @capacitor/ios
```

#### 2. Run `draft mobile`

```bash
draft mobile --game=my-game --target=all
```

This will:
- Auto-generate `src/mobile.tsx` (stub with placeholder GameModule)
- Auto-generate `capacitor.config.ts` (if missing)
- Copy the engine shell → gitignored `android/` + `ios/`
- Generate icons + splash screens (from `icon.png` or solid-color placeholders)
- Run `cap sync`

#### 3. Wire up the mobile entry

Open the generated `src/mobile.tsx` and replace the placeholder GameModule with your actual renderer factory, sim adapter, and UI mount — copying from your `src/main.tsx`. The key differences from desktop:

```typescript
import { createDowndraftMobileApp } from "@downdraft/app/mobile";
// import your renderer, sim, UI — same as main.tsx

createDowndraftMobileApp({
  appId: "downdraft-my-game",
  module: {
    renderer: (canvas) => new MyRenderer(canvas),  // same as main.tsx
    sim: () => new MySimAdapter(),                  // same as main.tsx
    mountUI: (overlay) => { /* React mount */ },    // same as main.tsx
    onReady: (ctx) => { /* game wiring */ },        // same as main.tsx
  },
  // Mobile-specific sim config overrides (lower entity counts, etc.)
  simConfigOverrides: { maxEntities: 4096 },
  // Touch input scheme: "dual-stick" (3D), "tap-to-move", or "tap" (2D)
  touchInput: { scheme: "dual-stick" },
});
```

No devtools, MCP, or OSR — those are Electron-only.

#### 4. (Optional) Add an app icon

Add a 1024×1024 `icon.png` to your game directory. `draft mobile` will automatically generate:
- **Android:** `ic_launcher.png` + `ic_launcher_round.png` + `ic_launcher_foreground.png` at all 5 mipmap densities (mdpi through xxxhdpi)
- **Android splash screens:** portrait + landscape at all 5 densities + a default (11 total)
- **iOS:** `AppIcon-512@2x.png` (1024×1024, Xcode 14+ single-size format)
- **iOS splash:** 2732×2732 universal set (3 files for @1x/@2x/@3x)

If no `icon.png` is provided, solid-color placeholder images (Downdraft brand dark teal) are generated for all assets. The shell ships **no binary images** — everything is generated at build time via jimp. You can override individual images via `mobile-overrides/` (see below).

### 5. (Optional) Add native customization overrides

If your game needs native permissions, extra dependencies, or custom resources, create a `mobile-overrides/` directory:

```
mobile-overrides/
  android/
    AndroidManifest.xml     # Extra <uses-permission> tags (merged into shell manifest)
    app/build.gradle        # Extra dependencies (appended to shell's dependencies block)
    res/                    # Custom resources (copied into app/src/main/res/, overrides icons)
  ios/
    Info.plist              # Extra keys (merged into shell plist)
    Assets.xcassets/        # Custom icon assets (overrides generated icons)
    App.entitlements        # Copied into App/App/ (configure CODE_SIGN_ENTITLEMENTS in Xcode)
  native-deps.json          # Structured extra deps:
                            #   {"android": ["com.some.sdk:sdk:1.0.0"],
                            #    "ios": ["pod 'SomeSDK', '~> 1.0'"]}
```

The override layer is a **merge**, not a replacement — it adds to the shell's existing configuration. Games that need deeper native customization can `git add -f android/` to force-track the generated project and edit it directly (this defeats the zero-file benefit but is available as an escape hatch).

### 6. Build and scaffold

```bash
draft mobile --target=all
```

This will:
1. Build the web bundle via `createDowndraftMobileViteConfig()` → `dist/mobile/`
2. Copy the engine-owned shell (`packages/mobile-shell/`) → `android/` + `ios/` (gitignored)
3. Patch game-specific values (appId, appName, port) into the native projects
4. Generate app icons from `icon.png` (if provided)
5. Apply `mobile-overrides/` merge layer (if present)
6. Ensure `capacitor.config.ts` exists (write if missing)
7. Run `cap sync` to populate web assets + Capacitor plugin configs

The `android/` and `ios/` directories are **gitignored** — they're regenerated from the shell on each run. Do not commit them.

### 7. Run

```bash
# Android
npx cap open android   # then Run in Android Studio

# iOS
npx cap open ios       # then Run in Xcode
```

## CLI flags

| Flag | Description |
|------|-------------|
| `--game <name>` | Game to build (required; `games/<game>`) |
| `--target <plat>` | `android`, `ios`, or `all` (default: `all`) |
| `--port <n>` | Embedded HTTP server port (default: `8765`) |
| `--skip-build` | Skip web bundle build (use existing `dist/mobile/`) |
| `--skip-gradle` | Skip the Gradle APK build (shell + sync only) |
| `--no-icons` | Skip icon generation (use shell placeholder icons) |
| `--no-overrides` | Skip `mobile-overrides/` merge layer |
| `--verbose`, `-v` | Verbose logging |

## Touch input

Mobile devices have no keyboard, mouse, or pointer lock. The `TouchInputAdapter` translates touch events into the engine's existing `InputBufferWriter` format:

| Scheme | Description | Use case |
|--------|-------------|----------|
| `dual-stick` | Left half = movement joystick (W/A/S/D). Right half = drag-look (camera). Tap = action. Two-finger tap = right-click. | 3D FPS/TPS games |
| `tap-to-move` | Tap = left mouse at position. Drag = mouse movement. | 2D/3D click-to-move games |
| `tap` | Pure tap = left mouse click at position. | 2D click-based games (falling-sand, sandjongg) |

The adapter is additive — it does not alter the existing keyboard/mouse/pointer-lock path. On desktop, it is never instantiated.

```typescript
createDowndraftMobileApp({
  // ...
  touchInput: {
    scheme: "dual-stick",
    joystickDeadZone: 24,    // px (default: 24)
    lookSensitivity: 1.0,    // multiplier (default: 1.0)
  },
});
```

## Electron-only feature strategy

| Electron feature | Mobile strategy |
|---|---|
| OSR (Offscreen Rendering) | Skip — use DOM overlay for UI (`features.osr: false`) |
| MCP automation harness | Skip in production (desktop dev/test only) |
| DevTools extension | Skip — use Safari Web Inspector (iOS) / Chrome Remote Debug (Android) |
| Pointer lock | Replace with `TouchInputAdapter` |
| Save game state via IPC | OPFS / IndexedDB (already supported via `createSaveStore("auto")` fallback) |
| Per-game userData isolation | Handled by OS (each installed app is sandboxed) |
| Chromium GPU switches | N/A — WebGPU is enabled by the WebView itself |
| Display refresh rate / DPR | Web APIs (`requestAnimationFrame` timing, `window.devicePixelRatio`) |
| GPU info / feature log | WebGPU adapter info (`GPUDeviceManager` captures `adapter.info`) |
| Import cache | No-op on mobile (re-import each launch) |
| `quit()` / `openExternal()` | Capacitor plugins (`@capacitor/app`, `@capacitor/browser`) |

## Boot guard

The mobile host runs a boot-time check for WebGPU and SharedArrayBuffer before starting the game. If either is missing, it shows a user-facing error screen instead of a silent hang:

```typescript
// This happens automatically inside createDowndraftMobileApp()
const guard = checkWebGpuAndIsolation();
if (!guard.ok) {
  showUnsupportedDeviceScreen(guard.reason);
  return;
}
```

The guard checks for WebGPU (`navigator.gpu`) directly rather than relying on `self.crossOriginIsolated`. This is because Android WebView uses "logical" cross-origin isolation (not "concrete") — `crossOriginIsolated` is always `false` even with COOP/COEP headers. `SharedArrayBuffer` is optional on mobile: the engine transparently polyfills it (`packages/core/src/sab/sab-polyfill.ts`) when the native constructor is unavailable, so games run regardless. Real SAB can be enabled via the `--enable-features=SharedArrayBuffer` WebView command-line flag for debug builds. See the [Android WebView command-line flags docs](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/android_webview/docs/commandline-flags.md) for details.

## Files

| File | Description |
|---|---|
| `packages/mobile-shell/` | Engine-owned canonical native shell (Android + iOS, pre-wired) |
| `packages/mobile-shell/android/` | Pre-wired Android project (EmbeddedServer + MainActivity + NanoHTTPD) |
| `packages/mobile-shell/ios/` | Pre-wired iOS project (EmbeddedServer + AppDelegate + ATS exception) |
| `packages/app/src/mobile/index.ts` | `createDowndraftMobileApp()` entry point |
| `packages/app/src/mobile/mobile-bridge.ts` | `DowndraftBridge` implementation for mobile |
| `packages/app/src/mobile/touch-input-adapter.ts` | Touch → `InputBufferWriter` mapping |
| `packages/app/src/mobile/webgpu-guard.ts` | Boot-time WebGPU + cross-origin isolation check |
| `packages/app/src/vite/mobile-vite-config.ts` | Web-only Vite build config (no main/preload) |
| `packages/cli/src/mobile.ts` | `draft mobile` CLI command (copy-from-shell + patch) |
| `packages/cli/src/mobile-icons.ts` | jimp-based icon generation from `icon.png` |
