// ============================================================================
// SimWebWorker — manages the simulation Web Worker from the renderer process.
// Thin subclass of EntitySimWorkerHost (SAB allocation, worker spawn, event
// routing, save/load, hot reload all live in the base class).
// ============================================================================

import { EntitySimWorkerHost, type EntitySimApi } from "@downdraft/core";
import type { SandboxSimMessage, SimCommand } from "@sandbox/shared/types";

export type SimEventCallback = (msg: SandboxSimMessage) => void;

export interface SimWebWorkerConfig {
  seed: number;
  isDev?: boolean;
}

type SimApi = EntitySimApi & {
  sendCommand(cmd: SimCommand): Promise<void>;
};

export class SimWebWorker extends EntitySimWorkerHost<SimApi, SimWebWorkerConfig> {
  /**
   * NOTE: `new URL(...)` must be inlined directly inside `new Worker()` —
   * Vite only bundles worker modules when it sees this exact pattern.
   * The cache-bust branch (dev hot reload) may use a variable URL.
   */
  protected spawnWorker(cacheBust?: number): Worker {
    if (cacheBust) {
      const workerUrl = new URL("./sim-worker-web.ts", import.meta.url);
      workerUrl.searchParams.set("t", String(cacheBust));
      return new Worker(workerUrl, { type: "module" });
    }
    return new Worker(new URL("./sim-worker-web.ts", import.meta.url), { type: "module" });
  }

  sendCommand(cmd: SimCommand): void {
    super.sendCommand(cmd);
  }
}
