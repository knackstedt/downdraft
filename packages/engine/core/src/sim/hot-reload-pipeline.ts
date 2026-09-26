// ============================================================================
// HotReloadPipeline — framework-owned hot-reload lifecycle manager.
//
// Owns the full save→stop→start→restore cycle from the main thread.
// Games provide an IWorkerManager; the pipeline handles state preservation
// with transient flag stripping and system reset.
// ============================================================================

import { createLogger } from "../util/logger";
import type { IWorkerManager } from "./types";

const log = createLogger();

export class HotReloadPipeline {
  private workerManager: IWorkerManager;

  constructor(workerManager: IWorkerManager) {
    this.workerManager = workerManager;
  }

  async hotReload(config: unknown, preserveState: boolean): Promise<void> {
    let stateJson: string | null = null;

    // 1. Save state if preserving
    if (preserveState) {
      try {
        const result = await this.workerManager.save("hot-reload");
        if (result?.stateJson) stateJson = result.stateJson;
      } catch (err) {
        log.warn("HotReloadPipeline", `State save failed, reloading without preservation: ${err}`);
      }
    }

    // 2. Stop current worker
    await this.workerManager.stop();

    // 3. Start new worker
    await this.workerManager.start(config);

    // 4. Restore state if preserving
    if (preserveState && stateJson) {
      try {
        await this.workerManager.restoreFromState(stateJson);
      } catch (err) {
        log.error("HotReloadPipeline", `State restore failed: ${err}. Starting fresh.`);
      }
    }
  }
}
