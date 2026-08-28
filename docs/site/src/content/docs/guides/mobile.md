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

This mirrors what the Electron host already does via `buildCrossOriginIsolationHeaders()` — the mobile host just does it from a native embedded server instead of Electron's `session.webRequest`.

The `draft mobile` CLI command injects server templates into the native projects:

- **Android:** NanoHTTPD-based `EmbeddedServer.java` (single-file Java HTTP server)
- **iOS:** Swift Network framework `EmbeddedServer.swift` (dependency-free TCP server)

See the template README files for native wiring instructions:
- `packages/cli/templates/mobile/android/README.md`
- `packages/cli/templates/mobile/ios/README.md`

## Adding mobile support to a game

### 1. Create a mobile entry

Create `src/mobile.ts` in your game directory:

```typescript
import { createDowndraftMobileApp } from "@downdraft/app/mobile";
import { gameModule } from "./game-module"; // the shared GameModule

createDowndraftMobileApp({
  appId: "downdraft-my-game",
  module: gameModule,
  // Mobile-specific sim config overrides (lower entity counts, etc.)
  simConfigOverrides: { maxEntities: 4096 },
  // Touch input scheme: "dual-stick" (3D), "tap-to-move", or "tap" (2D)
  touchInput: { scheme: "dual-stick" },
});
```

The `GameModule` is shared between desktop and mobile — only the host wrapper and config differ.

### 2. Install Capacitor dependencies

```bash
bun add -d @capacitor/cli @capacitor/core @capacitor/android @capacitor/ios
```

### 3. Build and scaffold

```bash
draft mobile --target=all
```

This will:
1. Build the web bundle via `createDowndraftMobileViteConfig()` → `dist/mobile/`
2. Initialize Capacitor (`npx cap add android/ios`)
3. Sync the web bundle to native projects (`npx cap sync`)
4. Inject the embedded HTTP server native code (COOP/COEP)

### 4. Wire the embedded server

Follow the platform-specific README to wire the embedded HTTP server into the native project (MainActivity for Android, AppDelegate for iOS).

### 5. Run

```bash
# Android
npx cap open android   # then Run in Android Studio

# iOS
npx cap open ios       # then Run in Xcode
```

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

The mobile host runs a boot-time check for WebGPU and cross-origin isolation before starting the game. If either is missing, it shows a user-facing error screen instead of a silent hang:

```typescript
// This happens automatically inside createDowndraftMobileApp()
const guard = checkWebGpuAndIsolation();
if (!guard.ok) {
  showUnsupportedDeviceScreen(guard.reason);
  return;
}
```

## Files

| File | Description |
|---|---|
| `packages/app/src/mobile/index.ts` | `createDowndraftMobileApp()` entry point |
| `packages/app/src/mobile/mobile-bridge.ts` | `DowndraftBridge` implementation for mobile |
| `packages/app/src/mobile/touch-input-adapter.ts` | Touch → `InputBufferWriter` mapping |
| `packages/app/src/mobile/webgpu-guard.ts` | Boot-time WebGPU + cross-origin isolation check |
| `packages/app/src/vite/mobile-vite-config.ts` | Web-only Vite build config (no main/preload) |
| `packages/cli/src/mobile.ts` | `draft mobile` CLI command |
| `packages/cli/templates/mobile/android/` | NanoHTTPD embedded server template + README |
| `packages/cli/templates/mobile/ios/` | Swift embedded server template + README |
