// ============================================================================
// Import cache store — SQLite-backed cache for resolved ImportSettings
// ============================================================================
//
// Storage layer used by the native host bridge. Uses node:sqlite (stable in
// Node 24+, implemented by Bun ≥1.1). If node:sqlite is unavailable, falls
// back to an in-memory Map (no persistence across restarts).
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import type { ImportCacheEntry } from "./types";

const log = createLogger("info");

interface CacheRow {
  path: string;
  source_mtime: number;
  sidecar_mtime: number;
  settings_json: string;
  updated_at: number;
}

/** Minimal shape of `node:sqlite`'s `DatabaseSync` used by this store. */
interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): { get(...params: unknown[]): unknown; run(...params: unknown[]): void };
  close(): void;
}

export interface ImportCacheStore {
  get(modelPath: string): ImportCacheEntry | null;
  set(modelPath: string, entry: ImportCacheEntry): void;
  invalidate(modelPath: string): void;
  close(): void;
}

/**
 * Open (or create) the import cache at `dbPath`. Falls back to an in-memory
 * store when node:sqlite is unavailable.
 */
export function createImportCacheStore(dbPath: string): ImportCacheStore {
  let db: DatabaseSyncLike | null = null;
  let memoryFallback: Map<string, CacheRow> | null = null;

  try {
    // Dynamic require to avoid bundler issues with node:sqlite
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite");
    const database: DatabaseSyncLike = new DatabaseSync(dbPath);
    db = database;
    database.exec(`
      CREATE TABLE IF NOT EXISTS import_cache (
        path TEXT PRIMARY KEY,
        source_mtime INTEGER NOT NULL,
        sidecar_mtime INTEGER NOT NULL,
        settings_json TEXT NOT NULL,
        updated_at REAL NOT NULL
      )
    `);
    log.info("import-cache", `SQLite cache opened at ${dbPath}`);
  } catch (err) {
    log.warn("import-cache", `node:sqlite unavailable, using in-memory fallback: ${err}`);
    memoryFallback = new Map();
  }

  return {
    get(modelPath: string): ImportCacheEntry | null {
      try {
        if (memoryFallback) {
          const row = memoryFallback.get(modelPath);
          if (!row) return null;
          return {
            settings: JSON.parse(row.settings_json),
            sourceMtime: row.source_mtime,
            sidecarMtime: row.sidecar_mtime,
            updatedAt: row.updated_at,
          };
        }
        if (!db) return null;
        const stmt = db.prepare("SELECT * FROM import_cache WHERE path = ?");
        const row = stmt.get(modelPath) as CacheRow | undefined;
        if (!row) return null;
        return {
          settings: JSON.parse(row.settings_json),
          sourceMtime: row.source_mtime,
          sidecarMtime: row.sidecar_mtime,
          updatedAt: row.updated_at,
        };
      } catch (err) {
        log.error("import-cache", `GET failed for ${modelPath}: ${err}`);
        return null;
      }
    },

    set(modelPath: string, entry: ImportCacheEntry): void {
      try {
        const settingsJson = JSON.stringify(entry.settings);
        if (memoryFallback) {
          memoryFallback.set(modelPath, {
            path: modelPath,
            source_mtime: entry.sourceMtime,
            sidecar_mtime: entry.sidecarMtime,
            settings_json: settingsJson,
            updated_at: entry.updatedAt,
          });
          return;
        }
        if (!db) return;
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO import_cache (path, source_mtime, sidecar_mtime, settings_json, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `);
        stmt.run(modelPath, entry.sourceMtime, entry.sidecarMtime, settingsJson, entry.updatedAt);
      } catch (err) {
        log.error("import-cache", `SET failed for ${modelPath}: ${err}`);
      }
    },

    invalidate(modelPath: string): void {
      try {
        if (memoryFallback) {
          memoryFallback.delete(modelPath);
          return;
        }
        if (!db) return;
        const stmt = db.prepare("DELETE FROM import_cache WHERE path = ?");
        stmt.run(modelPath);
      } catch (err) {
        log.error("import-cache", `INVALIDATE failed for ${modelPath}: ${err}`);
      }
    },

    close(): void {
      if (db) {
        try { db.close(); } catch { /* ignore */ }
        db = null;
      }
      memoryFallback?.clear();
      memoryFallback = null;
    },
  };
}
