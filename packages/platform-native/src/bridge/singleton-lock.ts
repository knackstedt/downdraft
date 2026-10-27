// ============================================================================
// singleton-lock.ts — per-appId single-instance lock + second-instance
// forwarding
//
// A lock file at <userData>/singleton.lock holds the owning PID. A live PID
// means another instance is running — the newcomer forwards {argv, cwd} to
// the primary over a per-app socket and exits (returns false). Stale locks
// (dead PID) are reclaimed.
//
// Transport: unix socket <userData>/instance.sock on POSIX, named pipe
// \\.\pipe\downdraft-<appId> on Windows. The primary listens only while it
// holds the lock; payloads dispatch to onSecondInstance subscribers plus an
// optional focus hook (set by runNativeAppModule — primary window raises
// unless the app opts out).
//
// Kept slim deliberately (fs + path + net only): the dev shell's early-boot
// path acquires the lock BEFORE mapping a window, so a refused second
// instance never leaves an orphaned mapped window behind.
// ============================================================================

import type { AppSecondInstanceData } from "@downdraft/engine/app/shared/types";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { resolveNativeUserDataDir } from "./user-data-dir";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = alive but owned by another user; ESRCH = dead.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Socket the primary listens on — unix path, or named pipe on Windows. */
function instanceSockPath(appId: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\downdraft-${appId}`;
  }
  return join(resolveNativeUserDataDir(appId), "instance.sock");
}

// ── Primary side ──────────────────────────────────────────────────────────

let heldLockPath: string | null = null;
let server: Server | null = null;
let serverSockPath: string | null = null;
let focusHook: (() => void) | null = null;
const listeners = new Set<(data: AppSecondInstanceData) => void>();
// Payloads received before the bridge subscribes — replayed to the first
// listener so a fast second launch can't drop its argv on the floor.
const pending: AppSecondInstanceData[] = [];

function dispatchSecondInstance(data: AppSecondInstanceData): void {
  // Default behavior: raise the primary window (set by the app module;
  // absent in bespoke hosts). Runs even with no subscribers.
  try { focusHook?.(); } catch { /* best-effort */ }
  if (listeners.size === 0) {
    if (pending.length < 16) pending.push(data);
    return;
  }
  listeners.forEach((cb) => {
    try { cb(data); } catch { /* listener errors must not wedge the server */ }
  });
}

function startInstanceListener(appId: string): void {
  if (server) return;
  const sockPath = instanceSockPath(appId);
  let srv: Server;
  try {
    srv = createServer((conn) => {
      let buf = "";
      conn.on("data", (chunk) => {
        buf += chunk.toString("utf-8");
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        conn.destroy();
        try {
          const data = JSON.parse(buf.slice(0, nl)) as AppSecondInstanceData;
          if (Array.isArray(data?.argv) && typeof data?.cwd === "string") {
            dispatchSecondInstance(data);
          }
        } catch { /* malformed payload — drop */ }
      });
      conn.on("error", () => conn.destroy());
    });
    // A crashed prior instance can leave the socket file behind — the lock
    // already proved no live owner, so reclaim the path before listen.
    if (process.platform !== "win32") {
      try { rmSync(sockPath); } catch { /* absent — fine */ }
    }
    srv.on("error", () => {
      // Listen failure (permissions, sandboxed runtime without node:net
      // socket support) degrades to the old silent-exit behavior.
      try { srv.close(); } catch { /* no-op */ }
      if (server === srv) { server = null; serverSockPath = null; }
    });
    srv.listen(sockPath);
    srv.unref?.();
    server = srv;
    serverSockPath = sockPath;
  } catch {
    server = null;
    serverSockPath = null;
  }
}

/** Subscribe to second-instance payloads — returns an unsubscribe fn.
 *  Queued payloads (arrived before the bridge existed) flush on the first
 *  subscription. */
export function onSecondInstance(
  cb: (data: AppSecondInstanceData) => void,
): () => void {
  listeners.add(cb);
  while (pending.length > 0) {
    try { cb(pending.shift()!); } catch { /* drop */ }
  }
  return () => listeners.delete(cb);
}

/** Set/clear the default action on a forwarded second instance — the app
 *  module wires this to "focus the primary window", or null when
 *  `focusOnSecondInstance: false`. */
export function setSecondInstanceFocus(fn: (() => void) | null): void {
  focusHook = fn;
}

// ── Second-instance side ─────────────────────────────────────────────────

/** Push {argv,cwd} to the primary's socket. Bounded — a wedged primary
 *  mustn't hang the exiting newcomer; a failed hand-off just reverts to
 *  the old silent exit. */
function forwardToPrimary(sockPath: string): Promise<void> {
  return new Promise((resolve) => {
    let conn: Socket | null = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { conn?.destroy(); } catch { /* no-op */ }
      resolve();
    };
    const timer = setTimeout(finish, 500);
    conn = createConnection(sockPath, () => {
      const payload = JSON.stringify({ argv: process.argv, cwd: process.cwd() }) + "\n";
      conn?.end(payload, () => {
        clearTimeout(timer);
        finish();
      });
    });
    conn.on("error", () => {
      clearTimeout(timer);
      finish();
    });
    conn.unref?.();
  });
}

/**
 * Acquire (or re-affirm) the per-appId instance lock. Resolves true when
 * this process owns the lock — the primary then listens for forwarded
 * second instances. Resolves false when a live primary owns it — the
 * caller should exit; this process already pushed its {argv,cwd} to the
 * primary (best-effort, bounded).
 */
export async function acquireSingleInstanceLock(appId: string): Promise<boolean> {
  if (process.env.DOWNDRAFT_MULTI_INSTANCE === "1") return true;
  const dir = resolveNativeUserDataDir(appId);
  const lockPath = join(dir, "singleton.lock");
  try {
    if (existsSync(lockPath)) {
      const pid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
      if (Number.isFinite(pid) && pid !== process.pid && pidAlive(pid)) {
        // A live primary owns the lock — hand off and decline.
        await forwardToPrimary(instanceSockPath(appId));
        return false;
      }
    }
  } catch { /* unreadable lock — reclaim it */ }
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(lockPath, String(process.pid));
    heldLockPath = lockPath;
    startInstanceListener(appId);
    return true;
  } catch {
    return true; // filesystem failure shouldn't block the app
  }
}

export function releaseSingleInstanceLock(): void {
  if (server) {
    try { server.close(); } catch { /* no-op */ }
    server = null;
    if (serverSockPath && process.platform !== "win32") {
      try { rmSync(serverSockPath); } catch { /* no-op */ }
    }
    serverSockPath = null;
  }
  if (!heldLockPath) return;
  try {
    // Only remove our own lock — a crashed-and-relaunched pair could race.
    const pid = parseInt(readFileSync(heldLockPath, "utf-8").trim(), 10);
    if (pid === process.pid) rmSync(heldLockPath);
  } catch { /* best-effort */ }
  heldLockPath = null;
}
