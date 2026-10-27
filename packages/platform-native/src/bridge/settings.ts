// ============================================================================
// settings.ts — typed key/value app settings over <configDir>/settings.json
//
// File shape: { "schemaVersion": 1, "values": { ... } } — the version field
// leaves room for future migrations. Writes are debounced and atomic
// (tmp + rename) so a crash mid-write never truncates the store.
//
// watch() semantics are same-process: watchers fire when THIS process calls
// set(). Cross-process observation (another instance rewriting the file)
// isn't watched — singleton apps don't need it and fs-watching every write
// would thrash.
// ============================================================================

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppSettings } from "@downdraft/engine/app/shared/types";
import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger("info");

const SCHEMA_VERSION = 1;
/** Debounce window — batches rapid set() calls into one disk write. */
const FLUSH_DELAY_MS = 200;

export function createAppSettings(configDir: string): AppSettings {
  const filePath = join(configDir, "settings.json");
  let values: Record<string, unknown> = load();
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const watchers = new Map<string, Set<(value: unknown) => void>>();

  function load(): Record<string, unknown> {
    try {
      if (!existsSync(filePath)) return {};
      const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
      if (parsed && typeof parsed === "object" && parsed.values && typeof parsed.values === "object") {
        return parsed.values;
      }
    } catch (e) {
      log.warn("settings", `unreadable settings.json (starting empty): ${(e as Error).message}`);
    }
    return {};
  }

  /** Atomic write — tmp file + rename so readers never see a torn file. */
  function write(): void {
    try {
      mkdirSync(configDir, { recursive: true });
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ schemaVersion: SCHEMA_VERSION, values }));
      renameSync(tmp, filePath);
      dirty = false;
    } catch (e) {
      log.warn("settings", `settings.json write failed: ${(e as Error).message}`);
    }
  }

  function scheduleWrite(): void {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (dirty) write();
    }, FLUSH_DELAY_MS);
    timer.unref?.();
  }

  return {
    get<T>(key: string, fallback?: T): T {
      const v = values[key];
      return (v === undefined ? fallback : v) as T;
    },

    set(key: string, value: unknown): void {
      if (value === undefined) {
        if (!(key in values)) return;
        delete values[key];
      } else {
        values[key] = value;
      }
      scheduleWrite();
      const set = watchers.get(key);
      if (set) {
        set.forEach((cb) => {
          try { cb(value); } catch { /* listener errors don't wedge set() */ }
        });
      }
    },

    getAll(): Record<string, unknown> {
      return { ...values };
    },

    watch(key: string, cb: (value: unknown) => void): () => void {
      let set = watchers.get(key);
      if (!set) { set = new Set(); watchers.set(key, set); }
      set.add(cb);
      return () => set.delete(cb);
    },

    flush(): void {
      if (timer) { clearTimeout(timer); timer = null; }
      if (dirty) write();
    },
  };
}
