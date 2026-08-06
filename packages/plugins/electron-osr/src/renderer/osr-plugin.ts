// ============================================================================
// ElectronOSRPlugin — RendererPlugin for Electron offscreen render (OSR)
//
// Implements the core `RendererPlugin` interface. The `ipc` (Electron IPC
// bridge) is passed via the constructor since it's not part of the
// `RendererPluginContext` surface. The GPU device comes from
// `ctx.getDevice()`.
//
// Replaces the previous ad-hoc local `PluginContext { device, ipc }` with the
// engine's standard renderer-plugin surface.
// ============================================================================

import type { RendererPlugin, RendererPluginContext } from "@downdraft/core";
import type { OSRIPC } from "../types";
import { OSRManager } from "./osr-manager";

export interface ElectronOSRPluginOptions {
  /** Electron IPC bridge for OSR panel/texture events. */
  ipc: OSRIPC;
  /** Surface format (defaults to bgra8unorm, should match the renderer). */
  surfaceFormat?: GPUTextureFormat;
  /** Depth format (defaults to depth24plus). */
  depthFormat?: GPUTextureFormat;
}

export class ElectronOSRPlugin implements RendererPlugin {
  readonly name = "electron-osr";
  readonly version = "0.1.0";

  private ipc: OSRIPC;
  private surfaceFormat: GPUTextureFormat;
  private depthFormat: GPUTextureFormat;
  private manager: OSRManager | null = null;

  constructor(options: ElectronOSRPluginOptions) {
    this.ipc = options.ipc;
    this.surfaceFormat = options.surfaceFormat ?? "bgra8unorm";
    this.depthFormat = options.depthFormat ?? "depth24plus";
  }

  register(ctx: RendererPluginContext): void {
    this.manager = new OSRManager(ctx.getDevice(), this.surfaceFormat, this.depthFormat);
    this.manager.init(this.ipc);

    ctx.onDispose(() => {
      this.manager?.destroy();
      this.manager = null;
    });
  }

  getManager(): OSRManager | null {
    return this.manager;
  }
}
