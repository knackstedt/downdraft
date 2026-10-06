// ============================================================================
// singleton-lock.ts — per-appId single-instance lock
//
// A lock file at <userData>/singleton.lock holds the owning PID. A live PID
// means another instance is running — the new one exits. Stale locks (dead
// PID) are reclaimed.
//
// Kept slim deliberately (fs + path only): the dev shell's early-boot path
// acquires the lock BEFORE mapping a window, so a refused second instance
// never leaves an orphaned mapped window behind.
// ============================================================================

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveNativeUserDataDir } from "./user-data-dir";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let heldLockPath: string | null = null;

/**
 * Returns true when this process acquired (or already holds) the per-appId
 * instance lock. When false, another live instance owns it and the caller
 * should exit — a second instance simply quits rather than handing off.
 */
export function acquireSingleInstanceLock(appId: string): boolean {
  if (process.env.DOWNDRAFT_MULTI_INSTANCE === "1") return true;
  const dir = resolveNativeUserDataDir(appId);
  const lockPath = join(dir, "singleton.lock");
  try {
    if (existsSync(lockPath)) {
      const pid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
      if (Number.isFinite(pid) && pid !== process.pid && pidAlive(pid)) {
        return false;
      }
    }
  } catch { /* unreadable lock — reclaim it */ }
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(lockPath, String(process.pid));
    heldLockPath = lockPath;
    return true;
  } catch {
    return true; // filesystem failure shouldn't block the game
  }
}

export function releaseSingleInstanceLock(): void {
  if (!heldLockPath) return;
  try {
    // Only remove our own lock — a crashed-and-relaunched pair could race.
    const pid = parseInt(readFileSync(heldLockPath, "utf-8").trim(), 10);
    if (pid === process.pid) rmSync(heldLockPath);
  } catch { /* best-effort */ }
  heldLockPath = null;
}
