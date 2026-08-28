// ============================================================================
// AutosaveManager — generic interval-based autosave for any save function.
//
// Extracted from a game's AutosaveManager and generalized to work with
// any save function (not just saveWorld). Skipped in deterministic mode.
// ============================================================================

export interface AutosaveManagerOptions {
  /** Called on each autosave interval to persist the current state. */
  save: () => Promise<void>;
  /** Autosave interval in milliseconds. Default: 3000. */
  intervalMs?: number;
  /** If true, autosave is skipped entirely (e.g. deterministic/test mode). */
  deterministic?: boolean;
}

/**
 * Runs a save function on a fixed interval. Skipped when deterministic mode
 * is active. Provides a `saveNow()` method for manual saves (e.g. on exit).
 *
 * @example
 * const autosave = new AutosaveManager({
 *   save: async () => { await store.save("autosave", buildState()); },
 *   intervalMs: 3000,
 *   deterministic: downdraft?.deterministic === true,
 * });
 * autosave.start();
 * // On exit:
 * await autosave.saveNow();
 * autosave.stop();
 */
export class AutosaveManager {
  private interval: ReturnType<typeof setInterval> | null = null;
  private saveFn: () => Promise<void>;
  private intervalMs: number;
  private deterministic: boolean;
  private savedCallbacks: Array<() => void> = [];

  constructor(opts: AutosaveManagerOptions) {
    this.saveFn = opts.save;
    this.intervalMs = opts.intervalMs ?? 3000;
    this.deterministic = opts.deterministic ?? false;
  }

  /** Register a callback to be called after each successful save. */
  onSaved(cb: () => void): void {
    this.savedCallbacks.push(cb);
  }

  start(): void {
    if (this.deterministic) return;
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.saveNow().catch((e) => console.error("[AutosaveManager] Save failed:", e));
    }, this.intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async saveNow(): Promise<void> {
    if (this.deterministic) return;
    await this.saveFn();
    for (let i = 0; i < this.savedCallbacks.length; i++) {
      this.savedCallbacks[i]();
    }
  }
}
