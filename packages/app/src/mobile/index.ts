// ============================================================================
// @downdraft/app/mobile — mobile host SDK for Capacitor (Android + iOS)
// ============================================================================
//
// `createDowndraftMobileApp()` is the mobile equivalent of
// `createDowndraftApp()` (Electron main process). It:
//   1. Injects the mobile `window.downdraft` bridge (OPFS saves, web-API
//      display info, Capacitor plugins for quit/external, no-ops for OSR/MCP).
//   2. Runs the WebGPU + cross-origin isolation guard.
//   3. Calls `startGame()` with the game's shared `GameModule`, applying
//      mobile-specific simConfig overrides.
//   4. Attaches the touch input adapter (if configured).
//
// The renderer, sim workers, SAB layout, and libraries are unchanged from
// desktop — they run in the system WebView (Android System WebView / iOS
// WKWebView) with the exact same WebGPU + Worker + SharedArrayBuffer code path.
//
// Usage (from a game's `src/mobile.ts`):
//
//   import { createDowndraftMobileApp } from "@downdraft/app/mobile";
//   import { gameModule } from "./game-module";
//
//   createDowndraftMobileApp({
//     appId: "downdraft-my-game",
//     module: gameModule,
//     simConfigOverrides: { maxEntities: 4096 },
//     touchInput: { scheme: "dual-stick" },
//   });
//

// Import the SAB polyfill FIRST — it must execute before any code that
// references SharedArrayBuffer. On desktop/Electron this is a no-op.
// On Android WebView (where SAB is unavailable), it polyfills SAB as an
// ArrayBuffer subclass and shims Atomics.wait. See sab-polyfill.ts.
import "@downdraft/core/sab/sab-polyfill";

import type { InputBufferWriter } from "@downdraft/core";
import { createLogger } from "@downdraft/core/util/logger";
import type { GameContext } from "../renderer/game-module";
import { startGame, type GameModule, type GameSimWorker } from "../renderer/game-module";
import { createMobileBridge } from "./mobile-bridge";
import { TouchInputAdapter, type TouchInputScheme } from "./touch-input-adapter";
import { InputBufferWriterSink, NullTouchInputSink, type TouchInputSink } from "./touch-input-sink";
import { TouchOsd, type TouchOsdButtonId } from "./touch-osd";
import { checkWebGpuAndIsolation, showUnsupportedDeviceScreen } from "./webgpu-guard";

const log = createLogger("info");

export { createMobileBridge } from "./mobile-bridge";
export { TouchInputAdapter, type TouchInputScheme } from "./touch-input-adapter";
export { InputBufferWriterSink, NullTouchInputSink, type MovementState, type TouchInputSink } from "./touch-input-sink";
export { TouchOsd, type TouchOsdButtonId } from "./touch-osd";
export { checkWebGpuAndIsolation, showUnsupportedDeviceScreen } from "./webgpu-guard";

/**
 * Features that can be toggled on mobile. All default to off/false since
 * they are Electron-only (OSR, MCP, DevTools extension).
 */
export interface MobileFeatures {
  /** Offscreen Rendering (Electron-only). Always false on mobile. */
  osr?: boolean;
  /** MCP automation harness (Electron dev/test only). Always false on mobile. */
  mcp?: boolean;
  /** DevTools extension (Electron only). Always false on mobile. */
  devtools?: boolean;
}

/**
 * Touch input configuration.
 */
export interface TouchInputConfig {
  /** Input scheme: "dual-stick" (3D games), "tap-to-move" (2D/3D), or "tap" (2D click-based). */
  scheme: TouchInputScheme;
  /** Dead zone radius for virtual joysticks (in px). Default: 24. */
  joystickDeadZone?: number;
  /** Sensitivity multiplier for drag-look. Default: 1.0. */
  lookSensitivity?: number;
  /** Game-provided custom sink (writes to game-specific input state instead
   *  of the engine InputBufferWriter). Bypasses the default
   *  `tryGetInputWriter` lookup. Use this when the sink can be constructed
   *  without the game context. */
  sink?: TouchInputSink;
  /** Game-provided sink factory (deferred until `onReady`, when `ctx.renderer`
   *  is available). Preferred over `sink` for games whose sink needs the
   *  renderer (e.g. overburden's `BlockheadsInputSink`). */
  sinkFactory?: (ctx: GameContext) => TouchInputSink;
  /** Enable the on-screen display (joystick + action buttons).
   *  - `true`: render the joystick + a default button set (jump, mine, place,
   *    zoom-in, zoom-out).
   *  - `TouchOsdButtonId[]`: render the joystick + the specified buttons.
   *  - omitted/`false`: no OSD (joystick + buttons handled by touch alone). */
  osd?: boolean | TouchOsdButtonId[];
}

/**
 * Configuration for `createDowndraftMobileApp()`.
 */
export interface DowndraftMobileAppConfig<Sim extends GameSimWorker = GameSimWorker> {
  /** Unique app identifier (e.g. "downdraft-to-the-ocean"). Used for Capacitor appId. */
  appId: string;
  /** The shared GameModule (same one used by the desktop Electron build). */
  module: GameModule<Sim>;
  /** Mobile-specific simConfig overrides merged into module.simConfig.
   *  Ignored for renderer-only games (no simConfig). */
  simConfigOverrides?: Record<string, unknown>;
  /** Touch input configuration. If omitted, no touch adapter is attached. */
  touchInput?: TouchInputConfig;
  /** Feature toggles (all default to off on mobile). */
  features?: MobileFeatures;
  /**
   * Called after the game context is ready (after startGame's onReady).
   * Use for game-specific mobile wiring (e.g. hide loading screen).
   */
  onReady?: (ctx: GameContext<Sim>) => void | Promise<void>;
}

/**
 * Boot a Downdraft game on a mobile device (Android / iOS via Capacitor).
 *
 * This is the mobile entry point, called from a game's `src/mobile.ts`.
 * It mirrors `createDowndraftApp()` (Electron) but uses the system WebView
 * instead of an Electron BrowserWindow.
 *
 * The game's `GameModule` is shared between desktop and mobile — only the
 * host wrapper and config differ.
 */
export async function createDowndraftMobileApp<Sim extends GameSimWorker>(
  config: DowndraftMobileAppConfig<Sim>,
): Promise<void> {
  // 1. Inject the mobile bridge BEFORE the renderer boots so that
  //    `@downdraft/app/renderer`'s `downdraft` accessor picks it up.
  if (!(globalThis as any).downdraft) {
    (globalThis as any).downdraft = createMobileBridge();
  }

  // 2. WebGPU + cross-origin isolation guard.
  const guard = checkWebGpuAndIsolation();
  if (!guard.ok) {
    log.error("mobile", `Boot guard failed: ${guard.reason}`);
    showUnsupportedDeviceScreen(guard.reason ?? "Unsupported device");
    return;
  }

  // 3. Merge mobile simConfig overrides into the module (sim-worker games only).
  //    Renderer-only games don't have simConfig, so overrides are ignored.
  const module: GameModule<Sim> = config.simConfigOverrides && config.module.simConfig
    ? {
        ...config.module,
        simConfig: {
          ...config.module.simConfig,
          ...config.simConfigOverrides,
        },
      }
    : config.module;

  // 4. Wrap the module's onReady to attach touch input + OSD + call the
  //    mobile onReady. Also wrap onDispose to tear down the OSD.
  const originalOnReady = module.onReady;
  const originalOnDispose = module.onDispose;
  let touchAdapter: TouchInputAdapter | null = null;
  let touchOsd: TouchOsd | null = null;

  module.onReady = async (ctx: GameContext<Sim>) => {
    await originalOnReady?.(ctx);

    // Attach touch input adapter if configured.
    if (config.touchInput) {
      touchAdapter = new TouchInputAdapter(ctx.canvas, config.touchInput);

      // Resolve the sink in priority order:
      //   1. config.touchInput.sinkFactory(ctx)  — deferred, needs ctx.renderer
      //   2. config.touchInput.sink              — static, constructed early
      //   3. tryGetInputWriter(ctx) → InputBufferWriterSink  — engine SAB games
      //   4. NullTouchInputSink                  — no-op (warn)
      let sink: TouchInputSink | null = null;
      if (config.touchInput.sinkFactory) {
        sink = config.touchInput.sinkFactory(ctx);
      } else if (config.touchInput.sink) {
        sink = config.touchInput.sink;
      } else {
        const writer = tryGetInputWriter(ctx);
        if (writer) {
          sink = new InputBufferWriterSink(writer);
        }
      }

      if (sink) {
        touchAdapter.attachSink(sink);
      } else {
        log.warn(
          "mobile",
          "TouchInputAdapter: could not find an input sink. Provide `touchInput.sink`/" +
            "`sinkFactory`, or ensure the game exposes an InputBufferWriter via " +
            "ctx.renderer.getInputWriter() / .inputWriter / .inputHandler?.inputWriter. " +
            "Falling back to a no-op sink — touch will not control the game.",
        );
        touchAdapter.attachSink(new NullTouchInputSink());
      }

      // Attach the on-screen display if configured.
      if (config.touchInput.osd) {
        const buttons: TouchOsdButtonId[] = config.touchInput.osd === true
          ? ["jump", "mine", "place", "zoom-in", "zoom-out"]
          : config.touchInput.osd;
        touchOsd = new TouchOsd({ adapter: touchAdapter, buttons });
      }
    }

    await config.onReady?.(ctx);
  };

  module.onDispose = async (ctx) => {
    // Tear down mobile-only resources first (before the game's onDispose
    // shuts down the renderer the adapter listens to).
    if (touchOsd) { touchOsd.dispose(); touchOsd = null; }
    if (touchAdapter) { touchAdapter.detach(); touchAdapter = null; }
    await originalOnDispose?.(ctx);
  };

  // 5. Start the game.
  await startGame(module);

  // 6. Return the touch adapter for games that need custom control.
  //    (Stored on the module for games that want to access it later.)
  if (touchAdapter) {
    (module as any).__touchAdapter = touchAdapter;
  }
}

/**
 * Attempt to locate the InputBufferWriter from the game context.
 *
 * Games expose the input writer in different ways. We try the common patterns:
 *   - ctx.renderer.getInputWriter()
 *   - ctx.renderer.inputWriter
 *   - ctx.renderer.inputHandler?.inputWriter
 *
 * Games that use a different pattern should pass the writer directly to
 * TouchInputAdapter.attach() in their onReady hook.
 */
function tryGetInputWriter(ctx: GameContext): InputBufferWriter | null {
  const r = ctx.renderer as any;
  if (typeof r?.getInputWriter === "function") {
    return r.getInputWriter() ?? null;
  }
  if (r?.inputWriter) {
    return r.inputWriter;
  }
  if (r?.inputHandler?.inputWriter) {
    return r.inputHandler.inputWriter;
  }
  return null;
}
