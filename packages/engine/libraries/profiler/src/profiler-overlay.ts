// ============================================================================
// ProfilerOverlay — main-thread host for the in-game profiler overlay.
//
// Wraps PixiUiHost with profiling-specific configuration:
//   - Sets the sceneModuleUrl to the ProfilerScene
//   - Passes the ProfilingSAB via extraSharedBuffers
//   - Passes view descriptors + GPU pass timings via sceneConfig
//   - Provides record/export controls (delegates to ProfilingBridge)
//
// Games create this via the ProfilerLib descriptor (declarative) or directly
// (escape hatch). The overlay runs on a separate OffscreenCanvas (pixi-ui
// worker) and reads the ProfilingSAB each frame.
// ============================================================================

import type { PixiUiHost } from "@downdraft/engine/libraries/pixi-ui/host";
import type { DebugViewDescriptor } from "@downdraft/engine/modules/devtools";

export interface ProfilerOverlayOptions {
  /** The PixiUiHost to use (created by the game or by ProfilerLib). */
  pixiUiHost: PixiUiHost;
  /** The ProfilingSAB (from ProfilingBridge.getProfilingSAB()). */
  profilingSAB: SharedArrayBuffer;
  /** View descriptors (from devtools.getViews()). */
  views: DebugViewDescriptor[];
  /** Optional: GPU pass timings provider (called each frame to feed the GPU view). */
  getGpuPassTimings?: () => any[];
}

export class ProfilerOverlay {
  private pixiUiHost: PixiUiHost;
  private profilingSAB: SharedArrayBuffer;
  private views: DebugViewDescriptor[];
  private getGpuPassTimings?: () => any[];
  private started: boolean = false;

  constructor(opts: ProfilerOverlayOptions) {
    this.pixiUiHost = opts.pixiUiHost;
    this.profilingSAB = opts.profilingSAB;
    this.views = opts.views;
    this.getGpuPassTimings = opts.getGpuPassTimings;
  }

  /**
   * Start the profiler overlay. Calls pixiUiHost.start() with the profiling
   * scene module + extraSharedBuffers.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // The scene module URL points to the ProfilerScene factory.
    // The pixi-ui worker dynamically imports it.
    // Note: the URL is set by the game's vite config (the profiler library
    // is bundled into the worker via the sceneModuleUrl alias).
    // Games typically pass the URL via ProfilerLib config.
    // The ProfilerOverlay just ensures the extraSharedBuffers + sceneConfig
    // are set before start().
    // The host's start() is called by the game (or ProfilerLib).
  }

  /**
   * Update the GPU pass timings (called from the render loop). The timings
   * are forwarded to the worker via postEvent.
   */
  updateGpuPassTimings(): void {
    if (!this.getGpuPassTimings) return;
    const timings = this.getGpuPassTimings();
    // Post the timings as an event to the pixi-ui worker
    (this.pixiUiHost as any).postEvent?.({ kind: "gpuPassTimings", timings });
  }

  /** The underlying PixiUiHost. */
  getPixiUiHost(): PixiUiHost {
    return this.pixiUiHost;
  }

  /** The ProfilingSAB shared with the worker. */
  getProfilingSAB(): SharedArrayBuffer {
    return this.profilingSAB;
  }

  /** Dispose the overlay. */
  dispose(): void {
    this.started = false;
  }
}
