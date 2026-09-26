// ============================================================================
// AutosaveManager — generic interval-based autosave for any save function.
//
// Extracted from a game's AutosaveManager and generalized to work with
// any save function (not just saveWorld). Skipped in deterministic mode.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger("info");

export interface AutosaveManagerOptions {
  /** Called on each autosave interval to persist the current state. */
  save: () => Promise<void>;
  /**
   * Optional predicate checked before each save — return false to skip the
   * tick cheaply (e.g. game paused, main menu open, nothing to persist).
   * Skipped saves do not fire onSaved callbacks.
   */
  shouldSave?: () => boolean;
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
  private shouldSave?: () => boolean;
  private intervalMs: number;
  private deterministic: boolean;
  private inFlight = false;
  private savedCallbacks: Array<() => void> = [];

  constructor(opts: AutosaveManagerOptions) {
    this.saveFn = opts.save;
    this.shouldSave = opts.shouldSave;
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
      void this.tick();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Interval tick: skip when a save is in-flight or shouldSave() says no. */
  private async tick(): Promise<void> {
    if (this.inFlight) return;
    if (this.shouldSave && !this.shouldSave()) return;
    try {
      await this.runSave();
    } catch (e) {
      log.error("AutosaveManager", `Save failed: ${e}`);
    }
  }

  private async runSave(): Promise<void> {
    this.inFlight = true;
    try {
      await this.saveFn();
      for (let i = 0; i < this.savedCallbacks.length; i++) {
        this.savedCallbacks[i]();
      }
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Manual save (e.g. on exit). Always persists — waits for any in-flight
   * save to finish first so the latest state is written.
   */
  async saveNow(): Promise<void> {
    if (this.deterministic) return;
    while (this.inFlight) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await this.runSave();
  }
}
