// ============================================================================
// @downdraft/engine/app/renderer — typed accessor for globalThis.downdraft
// ============================================================================
//
// Import `downdraft` from this module in game/bootstrap code instead of
// casting `(globalThis as any).downdraft`. The host installs the HostAPI
// object on `globalThis.downdraft`; this module provides a typed view.
//
// When no host bridge is installed (pure browser, headless test), the
// accessor returns a stub that no-ops / returns null. Callers that need
// real values should guard with `downdraft?.isAvailable`.

import { getNativeHost, type RenderSurface } from "@downdraft/engine";
import { OpfsSaveStore } from "@downdraft/engine/libraries/persistence/browser";
import type {
    HostAPI,
    HostOsrAPI
} from "../shared/types";
import { createSaveStore as _createSaveStore } from "./save-store-factory";

export type HostOsr = HostOsrAPI;

export interface Host extends Omit<HostAPI, "osr"> {
  isAvailable: boolean;
  isDev?: boolean;
  osr?: HostOsr;
}

function noop(): void {}

const stubBridge: Host = {
  isAvailable: false,
  saveGameState: () => Promise.resolve(false),
  loadGameState: () => Promise.resolve(null),
  deleteGameState: () => Promise.resolve(false),
  listSaveSlots: () => Promise.resolve([]),
  listSaveGenerations: () => Promise.resolve([]),
  deleteSaveGeneration: () => Promise.resolve(false),
  setThumbnail: () => Promise.resolve(),
  getThumbnail: () => Promise.resolve(null),
  setSaveProperties: () => Promise.resolve(),
  getSaveProperties: () => Promise.resolve({}),
  quit: () => Promise.resolve(),
  setDebugMode: noop,
  toggleDevtools: noop,
  toggleFullscreen: noop,
  getDisplayInfo: () => Promise.resolve({ refreshRate: 0 }),
  openExternal: noop,
  getGPUSystemInfo: () => Promise.resolve(null),
  getGpuInfo: () => Promise.resolve(null),
  getFeatureLog: () => Promise.resolve(null),
  captureFrame: () => Promise.resolve(null),
  getProcessStats: () => Promise.reject(new Error("Process stats not available on this host")),
  importCacheGet: () => Promise.resolve(null),
  importCacheSet: () => Promise.resolve(),
  importCacheInvalidate: () => Promise.resolve(),
  onSimReady: () => noop,
  onDisplayInfo: () => noop,
  onDisplayMetricsChanged: () => noop,
  onPerfStats: () => noop,
  onDebugMode: () => noop,
  onDevtoolsToggle: () => noop,
  deterministic: false,
  onMcpRequest: noop,
};

/**
 * Typed accessor for the `globalThis.downdraft` host bridge.
 *
 * On the native runtime this is the real HostAPI. In a host-less context
 * (e.g. model-viewer running standalone in a browser), it returns a stub
 * with `isAvailable: false`.
 *
 * The accessor is lazy: the bridge may be installed AFTER this module is
 * evaluated (the native host installs `globalThis.downdraft` once its
 * window/device exist — after static imports have already run). Reads go
 * through a Proxy so `downdraft.isAvailable` flips live when a bridge
 * appears. Callers that need a stable snapshot should read it at use time,
 * not module-eval time (all engine consumers already do).
 */
function currentBridge(): Host {
  const raw = (globalThis as unknown as { downdraft?: HostAPI }).downdraft;
  if (raw) {
    return { ...raw, isAvailable: true } as Host;
  }
  return stubBridge;
}

export const downdraft: Host = new Proxy({} as Host, {
  get(_target, prop) {
    return (currentBridge() as unknown as Record<string | symbol, unknown>)[prop];
  },
  has(_target, prop) {
    return prop in currentBridge();
  },
});

// Import cache adapter — host-backed with memory fallback
export { createHostImportCache } from "./import-cache";

// Bootstrap orchestrator + composable hooks
export { bootstrapGame } from "./bootstrap";
export type { BootstrapAutosaveOptions, BootstrapDevToolsOptions, BootstrapGameOptions } from "./bootstrap";
export { startGame } from "./game-module";
export type {
    GameContext,
    GameModule,
    GameSaveConfig,
    GameSaveSource,
    GameSimWorker,
    GameUiHandle,
    PluginRuntimeConfig,
    RendererFactory,
    SimEventMap,
    SimWorkerFactory,
    SimWorkerSeed
} from "./game-module";
export { useDeterministicRenderPause, useDisplayInfo, useFpsPolling, useHotReloadDispose } from "./hooks";
export { installSimHotReload, restoreHotReloadState } from "./hot-reload";
export type { HotReloadableSim, SimHotReloadDeps } from "./hot-reload";
export { createSimBridge } from "./sim-bridge";
export type { SimBridge, SimBridgeDeps, SimBridgeWorker } from "./sim-bridge";

// Save store factory + host save-store bridge type
export { createInlineSaveStore, createSaveStore, type CreateSaveStoreOptions, type CreateSaveStoreResult, type SaveBridge, type SaveStoreMode } from "./save-store-factory";

/**
 * Create the default ISaveStore for a game.
 *
 * When the host exposes a typed save store (`downdraft.saveStore` — the
 * native host's HostSaveStore over FileSaveStore), defaults to "host" mode —
 * disk persistence, stable across sessions, not origin-scoped.
 *
 * In a pure browser (no bridge), falls back to "auto" (OPFS worker → inline
 * OPFS), since there is no host save path available.
 *
 * Games that want a specific backend should call `createSaveStore` directly
 * with an explicit `mode` rather than relying on this default.
 */
export async function createDefaultSaveStore(engineVersion: string): Promise<import("@downdraft/engine").ISaveStore> {
  const mode = downdraft.saveStore ? "host" : "auto";
  const { store } = await _createSaveStore({
    mode,
    opfsOptions: { engineVersion },
    bridge: downdraft,
  });
  if (!store) {
    const fallback = new OpfsSaveStore({ engineVersion });
    await fallback.init();
    return fallback;
  }
  return store;
}

// AutosaveManager (re-exported from @downdraft/engine/libraries/persistence)
export { AutosaveManager, type AutosaveManagerOptions } from "@downdraft/engine/libraries/persistence/browser";

// MCP automation harness factory + shared tool helpers
export { blobToBase64, createMcpHarness, errorResult, jsonResult } from "./mcp-harness";
export type { McpHarnessOptions, McpRequest, McpResponse, McpToolDef, McpToolRegistration } from "./mcp-harness";
export { createStandardAutomationTools } from "./standard-automation-tools";
export type {
    InjectedInputFrame,
    StandardAutomationContext,
    StandardInputInjector,
    StandardToolName
} from "./standard-automation-tools";

// Feature log (renderer collector + combined accessor + MCP tool factory)
export {
    collectRendererFeatureLog,
    createFeatureLogMcpTool,
    getCombinedFeatureLog,
    getRendererFeatureLog
} from "./feature-log";
export type { CombinedFeatureLog, RendererFeatureLogOptions } from "./feature-log";

// --- Render surface ---

/**
 * Get the renderer-facing surface for a given layer index.
 *
 * This is the canonical accessor — it returns the host-owned `RenderSurface`
 * on the native runtime (the SDL-windowed wgpu surface installed by
 * `createNativeHost`) and the DOM `<canvas>` element on browser hosts (which
 * satisfies `RenderSurface` structurally).
 *
 * Layer 0 is the primary game surface. On native, layer 0 is the only
 * surface — requesting any other layer throws (multi-canvas layering is a
 * DOM-host concept).
 */
export function getSurface(layer: number = 0): RenderSurface {
  if (layer !== 0) {
    throw new Error(`No surface for layer ${layer} — the native host exposes exactly one RenderSurface (layer 0).`);
  }
  // The boundary cast: NativeSurface's WebGPU context returns the wgpu
  // wrapper types (WgpuTexture), not @webgpu/types' branded GPUTexture.
  // The contract is honored at runtime; the cast bridges the two type
  // universes.
  const surface = getNativeHost()?.surface;
  if (!surface) {
    throw new Error("No native surface — the host has not installed __nativeHost.surface yet");
  }
  return surface as RenderSurface;
}
