// ============================================================================
// createGameSaveSystem — batteries-included save lifecycle facade.
//
// createGridSaveSystem covers the store CRUD; games still hand-rolled the
// same lifecycle on top in main.tsx:
//   - module-scope `let autosaveInterval` + setInterval(autosave, 3000)
//   - loadAutosave()-on-start → renderer.loadSave(...) with try/catch
//   - cleanup in onDispose
//   - save/load/delete/list wrappers that snapshot via the renderer
//
// This facade ties the grid system + autosave interval + snapshot/restore
// contract into one object. Games keep their schema mapping (buildState /
// buildBlobs / parseEntry) — everything else is engine-owned.
//
// Usage:
//   const saves = createGameSaveSystem({
//     createStore: () => createDefaultSaveStore(ENGINE_VERSION),
//     autosaveSlot: "autosave",
//     buildState, buildBlobs, parseEntry, extractListMeta,
//     snapshot: () => renderer.snapshotGrids(),
//     restore: (e) => renderer.loadSave(e.grids, e.fields, e.gridW, e.gridH),
//     deterministic: ctx.deterministic,
//   });
//   // in onReady:
//   await saves.start();      // restores autosave, starts the interval
//   // on hot-reload:
//   saves.stop();
// ============================================================================

import { createLogger } from "../util/logger";
import { createGridSaveSystem, type GridSaveSystem, type GridSaveSystemOptions } from "./grid-save-system";

const log = createLogger();

export interface GameSaveSystemOptions<Meta, Entry> extends GridSaveSystemOptions<Meta, Entry> {
  /**
   * Capture the current game state for an autosave tick. Return null to skip
   * this tick (e.g. renderer not ready yet). May be async.
   * Required to enable the autosave interval; without it, `start()` only
   * restores the autosave.
   */
  snapshot?: () => Meta | null | Promise<Meta | null>;
  /**
   * Apply a loaded entry to the game (autosave restore + loadAndRestore).
   * If omitted, `start()` still loads the autosave and reports whether one
   * existed, and `loadAndRestore` returns the entry for the caller to apply.
   */
  restore?: (entry: Entry) => void | Promise<void>;
  /** Autosave interval in ms. Default: 3000. */
  intervalMs?: number;
  /** Skip the autosave interval + autosave writes entirely (test mode). */
  deterministic?: boolean;
  /** Called on autosave errors. Default: logs a warning via the engine logger. */
  onError?: (err: unknown) => void;
  /**
   * Post-process entries returned by `loadGame`/`loadAndRestore` with slot
   * metadata — games whose `parseEntry` produces bare grid/state data use
   * this to stamp the slot id, display name, savedAt timestamp, and JPEG
   * thumbnail without re-fetching properties themselves (previously a ~15
   * line copy-pasted `loadGame` wrapper in every game).
   * Mutate `entry` in place or return a replacement.
   */
  enrichEntry?: (entry: Entry, meta: {
    id: string;
    props: Record<string, unknown>;
    thumbnail: Blob | null;
  }) => Entry | void | Promise<Entry | void>;
}

export interface GameSaveSystem<Meta, Entry> extends GridSaveSystem<Meta, Entry> {
  /**
   * Restore the autosave (via `restore`, if provided), then start the
   * autosave interval (when `snapshot` is provided and not deterministic).
   * Returns the restored entry, or null when no autosave exists.
   */
  start(): Promise<Entry | null>;
  /** Stop the autosave interval. */
  stop(): void;
  /** Whether the autosave interval is running. */
  readonly running: boolean;
  /**
   * Load a named save and apply it via `restore`. Returns the entry (already
   * applied), or null when the slot is missing/invalid.
   */
  loadAndRestore(id: string): Promise<Entry | null>;
}

export function createGameSaveSystem<Meta, Entry>(
  opts: GameSaveSystemOptions<Meta, Entry>,
): GameSaveSystem<Meta, Entry> {
  const system: GridSaveSystem<Meta, Entry> = createGridSaveSystem(opts);
  const intervalMs = opts.intervalMs ?? 3000;
  const onError = opts.onError ?? ((e) => log.warn("save", `autosave failed: ${e}`));
  let interval: ReturnType<typeof setInterval> | null = null;

  const maybeEnrich = async (id: string, entry: Entry | null): Promise<Entry | null> => {
    if (entry === null || !opts.enrichEntry) return entry;
    const store = await system.getStore();
    const [thumbBuf, props] = await Promise.all([
      store.getThumbnail(id),
      store.getProperties(id),
    ]);
    const meta = {
      id,
      props,
      thumbnail: thumbBuf ? new Blob([thumbBuf], { type: "image/jpeg" }) : null,
    };
    return (await opts.enrichEntry(entry, meta)) ?? entry;
  };

  const tick = async () => {
    try {
      const meta = await opts.snapshot?.();
      if (meta !== null && meta !== undefined) await system.autosave(meta);
    } catch (e) {
      onError(e);
    }
  };

  return {
    ...system,

    async start(): Promise<Entry | null> {
      let restored: Entry | null = null;
      if (!opts.deterministic) {
        try {
          restored = await system.loadAutosave();
          if (restored !== null) await opts.restore?.(restored);
        } catch (e) {
          // No autosave / corrupt autosave is normal on first run.
          onError(e);
        }
        if (opts.snapshot && !interval) {
          interval = setInterval(() => { void tick(); }, intervalMs);
        }
      }
      return restored;
    },

    stop(): void {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },

    get running(): boolean {
      return interval !== null;
    },

    async loadGame(id: string): Promise<Entry | null> {
      return maybeEnrich(id, await system.loadGame(id));
    },

    async loadAndRestore(id: string): Promise<Entry | null> {
      const entry = await maybeEnrich(id, await system.loadGame(id));
      if (entry !== null) await opts.restore?.(entry);
      return entry;
    },
  };
}
