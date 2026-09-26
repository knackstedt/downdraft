// ============================================================================
// native-restart.ts — process-restart recovery for unrecoverable GPU failures
//
// Browser games recover from unrecoverable GPU/renderer failures with
// window.location.reload() — the whole JS context is rebuilt and the page
// re-initializes WebGPU. The native host has no reload; the equivalent is a
// detached self-respawn: spawn a fresh copy of this process and exit. This
// works identically for `bun run src/native-entry.ts` (dev, where argv[1] is
// the entry script) and `bun build --compile` binaries (release, where
// argv[0] is the binary and argv[1..] are game args).
//
// createNativeHost() installs the hook as globalThis.__ddRequestRestart —
// GameRenderer's device-loss fallback, window.location.reload(), and bespoke
// render loops all funnel through it. Restarts are capped (env-tracked
// counter) so a persistently dead GPU doesn't respawn-loop forever; callers
// that get `false` should fall back to a dialog + clean quit.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { spawn } from "node:child_process";
import { releaseSingleInstanceLock } from "./host-lifecycle";
import type { NativeWindow } from "./window/native-window";

const log = createLogger("info");

export interface RestartHookOptions {
  /** Max respawns before giving up (default 2). The attempt count survives
   *  across respawns via the DOWNDRAFT_RESTART_COUNT env var. */
  maxAttempts?: number;
}

/**
 * Request a process restart. Returns true when a replacement process was
 * spawned (this process then exits shortly); false when the request was
 * refused (restart budget exhausted, deterministic/test mode, or spawn
 * failure) — callers should then fall back to a dialog + clean quit.
 */
export function requestGameRestart(reason: string): boolean {
  const fn = (globalThis as any).__ddRequestRestart;
  return typeof fn === "function" ? !!fn(reason) : false;
}

/**
 * Install globalThis.__ddRequestRestart. `window` is used for the
 * give-up path's modal dialog before the clean quit.
 */
export function installRestartHook(window: NativeWindow, opts: RestartHookOptions = {}): void {
  const maxAttempts = opts.maxAttempts ?? 2;
  let restarting = false;

  (globalThis as any).__ddRequestRestart = (reason: string): boolean => {
    if (restarting) return true; // already on the way out
    // Test/deterministic runs own their process lifecycle — a detached
    // respawn would escape the harness and leak orphaned game instances.
    if (process.env.DOWNDRAFT_DETERMINISTIC === "1" || process.env.DOWNDRAFT_NO_RESTART === "1") {
      return false;
    }
    const prior = parseInt(process.env.DOWNDRAFT_RESTART_COUNT ?? "0", 10) || 0;
    if (prior >= maxAttempts) {
      log.error("native-restart", `restart suppressed — budget exhausted (${prior}/${maxAttempts}). Last reason: ${reason}`);
      try {
        window.showMessageBox(
          "GPU failure",
          `The renderer crashed and automatic recovery failed (${reason}).\n\nPlease restart the application.`,
        );
      } catch { /* window may be gone */ }
      try { window.requestQuit(); } catch { /* best-effort */ }
      return false;
    }

    restarting = true;
    log.warn("native-restart", `restarting process — ${reason} (attempt ${prior + 1}/${maxAttempts})`);

    // Release the per-app singleton lock BEFORE spawning — the replacement
    // races our exit, and a still-held lock (or our still-live PID) would
    // make it self-quit as a "second instance".
    try { releaseSingleInstanceLock(); } catch { /* best-effort */ }

    try {
      const child = spawn(process.execPath, process.argv.slice(1), {
        cwd: process.cwd(),
        env: { ...process.env, DOWNDRAFT_RESTART_COUNT: String(prior + 1) },
        detached: true,
        stdio: "inherit",
      });
      child.unref();
    } catch (e) {
      restarting = false;
      log.error("native-restart", `respawn failed: ${e}`);
      return false;
    }

    // Exit on a short delay so the spawn is safely detached and pending log
    // lines flush. The dead surface/window is abandoned — the OS reclaims it.
    const t = setTimeout(() => process.exit(0), 50);
    (t as unknown as { unref?: () => void }).unref?.();
    return true;
  };
}
