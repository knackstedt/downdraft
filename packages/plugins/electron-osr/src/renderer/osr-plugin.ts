// ============================================================================
// ElectronOSRPlugin — Engine plugin interface for the Electron OSR plugin
// ============================================================================

import type { OSRIPC } from "../types.ts";
import { OSRManager } from "./osr-manager.ts";

export interface PluginContext {
  device: GPUDevice;
  ipc: OSRIPC;
}

export class ElectronOSRPlugin {
  readonly name = "electron-osr";
  readonly version = "0.1.0";
  private manager: OSRManager | null = null;

  register(ctx: PluginContext): OSRManager {
    this.manager = new OSRManager(ctx.device);
    this.manager.init(ctx.ipc);
    return this.manager;
  }

  unregister(): void {
    this.manager?.destroy();
    this.manager = null;
  }

  getManager(): OSRManager | null {
    return this.manager;
  }
}
