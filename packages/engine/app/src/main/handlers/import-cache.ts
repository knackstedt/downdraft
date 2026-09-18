// ============================================================================
// Import Cache IPC Handler — SQLite-backed cache for resolved ImportSettings
// ============================================================================
// Uses node:sqlite (stable in Node 24+ / Electron 43+, no flag required).
// Opens downdraft-import-cache.db in the game's userData directory.
//
// If node:sqlite is unavailable (older Node/Electron), falls back to an
// in-memory Map (no persistence across restarts).
//

import { createLogger } from "@downdraft/core/util/logger";
import { app, ipcMain } from "electron";
import { join } from "path";
import { IPC } from "../../shared/messages";

const log = createLogger("info");

interface CacheRow {
  path: string;
  source_mtime: number;
  sidecar_mtime: number;
  settings_json: string;
  updated_at: number;
}

/** Minimal shape of `node:sqlite`'s `DatabaseSync` used by this handler. */
interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): { get(...params: unknown[]): unknown; run(...params: unknown[]): void };
  close(): void;
}

let db: DatabaseSyncLike | null = null;
let memoryFallback: Map<string, CacheRow> | null = null;
let useMemoryFallback = false;

function openDatabase(): void {
  if (db || memoryFallback) return;

  try {
    // Use dynamic require to avoid bundler issues with node:sqlite
    const { DatabaseSync } = require("node:sqlite");
    const dbPath = join(app.getPath("userData"), "downdraft-import-cache.db");
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
    // Use a prepared statement cache for performance
    log.info("import-cache", `SQLite cache opened at ${dbPath}`);
  } catch (err) {
    log.warn("import-cache", `node:sqlite unavailable, using in-memory fallback: ${err}`);
    useMemoryFallback = true;
    memoryFallback = new Map();
  }
}

export function registerImportCacheHandlers(): void {
  openDatabase();

  ipcMain.handle(IPC.IMPORT_CACHE_GET, (_event, modelPath: string) => {
    try {
      if (useMemoryFallback && memoryFallback) {
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
  });

  ipcMain.handle(
    IPC.IMPORT_CACHE_SET,
    (_event, modelPath: string, entry: { settings: unknown; sourceMtime: number; sidecarMtime: number; updatedAt: number }) => {
      try {
        const settingsJson = JSON.stringify(entry.settings);
        if (useMemoryFallback && memoryFallback) {
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
  );

  ipcMain.handle(IPC.IMPORT_CACHE_INVALIDATE, (_event, modelPath: string) => {
    try {
      if (useMemoryFallback && memoryFallback) {
        memoryFallback.delete(modelPath);
        return;
      }
      if (!db) return;
      const stmt = db.prepare("DELETE FROM import_cache WHERE path = ?");
      stmt.run(modelPath);
    } catch (err) {
      log.error("import-cache", `INVALIDATE failed for ${modelPath}: ${err}`);
    }
  });
}

/** Close the database connection. Called on app shutdown. */
export function closeImportCache(): void {
  if (db) {
    try {
      db.close();
    } catch {
      // ignore
    }
    db = null;
  }
  if (memoryFallback) {
    memoryFallback.clear();
    memoryFallback = null;
  }
}
