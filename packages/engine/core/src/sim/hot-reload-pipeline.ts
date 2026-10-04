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

// Per-step bounds. A wedged worker must not hang the pipeline forever — the
// dev shell escalates unresponsive swaps to a session restart, and an
// unbounded hotReload promise keeps the dying session (worker host, SABs,
// module graph) pinned. `start` gets the largest budget: dev cold-transform
// of a cache-busted worker module can legitimately take tens of seconds.
const SAVE_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 90_000;
const RESTORE_TIMEOUT_MS = 30_000;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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
        const result = await withTimeout(this.workerManager.save("hot-reload"), SAVE_TIMEOUT_MS, "save");
        if (result?.stateJson) stateJson = result.stateJson;
      } catch (err) {
        log.warn("HotReloadPipeline", `State save failed, reloading without preservation: ${err}`);
      }
    }

    // 2. Stop current worker
    await withTimeout(this.workerManager.stop(), STOP_TIMEOUT_MS, "worker stop");

    // 3. Start new worker
    await withTimeout(this.workerManager.start(config), START_TIMEOUT_MS, "worker start");

    // 4. Restore state if preserving
    if (preserveState && stateJson) {
      try {
        await withTimeout(this.workerManager.restoreFromState(stateJson), RESTORE_TIMEOUT_MS, "state restore");
      } catch (err) {
        log.error("HotReloadPipeline", `State restore failed: ${err}. Starting fresh.`);
      }
    }
  }
}
