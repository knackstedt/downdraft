// ============================================================================
// Per-game userData isolation + stale lock cleanup
// ============================================================================
//
// Each game gets its own userData directory (e.g. `~/.config/downdraft-my-game/`)
// so that Chromium storage subsystems (OPFS, IndexedDB, Service Worker DB, cookies,
// cache) are fully isolated. Without this, concurrent game instances share the
// same LevelDB LOCK files and corrupt each other's storage.
//
// On startup, after acquiring the single-instance lock, stale LOCK files and
// Chromium temp artifacts from a crashed/killed previous run are cleaned up.

import { createLogger } from "@downdraft/engine/util/logger";
import { existsSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const log = createLogger("info");

/**
 * LevelDB `LOCK` file paths (relative to userData) that Chromium uses for its
 * storage subsystems. After a crash these files may be left on disk; while
 * Linux `flock` is released on process death, some filesystems (NFS, Windows
 * mandatory locking) can retain stale locks. Deleting them is safe — LevelDB
 * recreates them on next open.
 */
const STALE_LOCK_REL_PATHS = [
  "File System/Origins/LOCK",
  "Service Worker/LOCK",
  "IndexedDB/LOCK",
  "Local Storage/leveldb/LOCK",
  "Session Storage/LOCK",
  // Electron single-instance lock artifacts (in the userData root).
  // SingletonLock is a symlink pointing at "<host>-<pid>"; SingletonSocket is
  // a Unix domain socket. Both are left behind when a process is killed
  // (SIGKILL/CI timeout) without releasing the lock, and a subsequent launch
  // may fail to reclaim them — causing requestSingleInstanceLock() to return
  // false and the app to quit immediately.
  "SingletonLock",
  "SingletonSocket",
] as const;

/**
 * Glob prefix for Chromium temp/crash-dump files in the userData root.
 * These accumulate across runs and are never cleaned up by Chromium.
 */
const CHROMIUM_TEMP_PREFIX = ".org.chromium.Chromium.";

/**
 * Resolve the per-game userData directory from an `appId`.
 *
 * Returns `join(app.getPath("appData"), appId)` — e.g. on Linux:
 *   `~/.config/downdraft-my-game`
 *
 * Call this BEFORE `app.whenReady()` and before any code that touches
 * `app.getPath("userData")`.
 */
export function resolveUserDataDir(app: { getPath: (name: any) => string }, appId?: string): string {
  if (!appId) return app.getPath("userData");
  return join(app.getPath("appData"), appId);
}

/**
 * Remove stale LevelDB LOCK files and Chromium temp artifacts from a previous
 * run that didn't shut down cleanly.
 *
 * In normal (non-deterministic) mode, MUST only be called after
 * `app.requestSingleInstanceLock()` succeeds — otherwise we might delete
 * locks held by a live process. In deterministic/test mode the single-
 * instance lock is skipped entirely (the test harness guarantees no
 * concurrent instance), so this is called unconditionally and is safe.
 */
export function cleanupStaleStorage(userDataDir: string): void {
  let cleanedLocks = 0;
  let cleanedTemps = 0;

  for (const relPath of STALE_LOCK_REL_PATHS) {
    const lockPath = join(userDataDir, relPath);
    try {
      if (existsSync(lockPath)) {
        unlinkSync(lockPath);
        cleanedLocks++;
      }
    } catch {
      // Lock file is held by a live process (shouldn't happen after
      // single-instance lock) or already removed — ignore.
    }
  }

  // Clean up Chromium temp/crash-dump files (.org.chromium.Chromium.*)
  try {
    const entries = readdirSync(userDataDir);
    for (const entry of entries) {
      if (entry.startsWith(CHROMIUM_TEMP_PREFIX)) {
        try {
          rmSync(join(userDataDir, entry), { recursive: true, force: true });
          cleanedTemps++;
        } catch {
          // In use or permission issue — skip.
        }
      }
    }
  } catch {
    // userData dir doesn't exist yet (first run) — nothing to clean.
  }

  if (cleanedLocks > 0 || cleanedTemps > 0) {
    log.info(
      "storage",
      `Cleaned up stale storage artifacts: ${cleanedLocks} lock file(s), ${cleanedTemps} temp file(s)`,
    );
  }
}
