// ============================================================================
// host-lifecycle.ts — native equivalents of the Electron main-process
// lifecycle features:
//
//   - single-instance lock (app.requestSingleInstanceLock)
//   - window-state persistence (main/window.ts loadWindowState/saveWindowState)
//   - error dialogs (main/error-dialog.ts → SDL_ShowSimpleMessageBox)
//
// Wired into createNativeHost when appId is set; deterministic/test mode and
// DOWNDRAFT_MULTI_INSTANCE=1 opt out of the single-instance lock so e2e and
// dev workflows can still run concurrent instances.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNativeUserDataDir } from "./bridge/user-data-dir";
import type { NativeWindow } from "./window/native-window";

const log = createLogger("info");

// ── Single-instance lock ─────────────────────────────────────────────────────
// A lock file at <userData>/singleton.lock holds the owning PID. A live PID
// means another instance is running — the new one exits. Stale locks (dead
// PID) are reclaimed, mirroring the stale-lockfile recovery in
// app/src/main/storage.ts.

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
 * should exit — Electron focuses the existing window instead, which has no
 * cross-process native equivalent.
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

// ── Window-state persistence ─────────────────────────────────────────────────

export interface NativeWindowState {
  x: number;
  y: number;
  width: number;
  height: number;
}

function statePath(appId: string): string {
  return join(resolveNativeUserDataDir(appId), "window-state.json");
}

export function loadWindowState(appId: string): NativeWindowState | null {
  try {
    const s = JSON.parse(readFileSync(statePath(appId), "utf-8")) as NativeWindowState;
    if (typeof s.width === "number" && s.width > 0 && typeof s.height === "number" && s.height > 0) return s;
  } catch { /* no saved state */ }
  return null;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function saveWindowState(appId: string, window: NativeWindow): void {
  try {
    const pos = window.getWindowPos();
    const size = window.getWindowSize();
    if (size.width <= 0 || size.height <= 0) return;
    const state: NativeWindowState = { x: pos.x, y: pos.y, width: size.width, height: size.height };
    mkdirSync(resolveNativeUserDataDir(appId), { recursive: true });
    writeFileSync(statePath(appId), JSON.stringify(state));
  } catch { /* best-effort — window may be gone during teardown */ }
}

/** Restore saved bounds and persist them (debounced) on move/resize/close. */
export function installWindowStatePersistence(appId: string, window: NativeWindow): void {
  const saved = loadWindowState(appId);
  if (saved) {
    // Stale local shim builds may predate sdl_shim_set_window_size.
    try {
      window.setWindowSize(saved.width, saved.height);
    } catch { /* best-effort */ }

    // Position restore must wait until the WM has framed the window: an
    // SDL_SetWindowPosition issued earlier is taken as the *frame* origin
    // on X11 (an initial-geometry hint), while SDL_GetWindowPosition always
    // reports the *client-area* origin — restoring immediately shifts the
    // window down by the titlebar height on every launch. Once the frame
    // exists, set/get share client-area coordinates and the restore lands
    // exactly. SDL_GetWindowBordersSize reads _NET_FRAME_EXTENTS and only
    // reports nonzero borders post-framing, so poll it as the "framed"
    // signal; the fallback timer covers WMs that never report extents
    // (Wayland, borderless setups — where the restore is a no-op or the
    // frame==client anyway).
    let applied = false;
    const applyPos = () => {
      if (applied) return;
      applied = true;
      clearInterval(poll);
      clearTimeout(fallback);
      try { window.setWindowPos(saved.x, saved.y); } catch { /* best-effort */ }
    };
    const poll = setInterval(() => {
      try {
        const b = window.getWindowBorders();
        if (b && (b.top | b.left | b.bottom | b.right) !== 0) applyPos();
      } catch { /* best-effort */ }
    }, 25);
    poll.unref?.();
    const fallback = setTimeout(applyPos, 750);
    fallback.unref?.();
  }
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(appId, window), 500);
    saveTimer.unref?.();
  };
  window.addEventListener("moved", scheduleSave);
  window.addEventListener("resize", scheduleSave);
  window.addEventListener("close", () => saveWindowState(appId, window));
}

// ── Error dialogs ────────────────────────────────────────────────────────────
// SDL_ShowSimpleMessageBox is modal + blocking — the nearest native equivalent
// of the Electron HTML error window (main/error-dialog.ts) — but its X11
// fallback renders unselectable text in a barebones window. So the full error
// is mirrored to stderr, the clipboard, and <userData>/crash.log before the
// dialog opens, and on Linux a zenity/kdialog text view (selectable,
// scrollable) is preferred when available. Install once.

let errorHandlersInstalled = false;

function isEpipeError(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    return (err as { code: string }).code === "EPIPE";
  }
  return err instanceof Error && err.message.includes("write EPIPE");
}

/** Modal fatal-error dialog. On Linux, prefer zenity/kdialog showing the crash
 *  log in a selectable text view; fall back to SDL's simple message box. */
function showFatalDialog(window: NativeWindow, title: string, message: string, logPath: string | null): void {
  if (process.platform === "linux" && logPath) {
    const attempts: [string, string[]][] = [
      ["zenity", ["--text-info", "--title", title, "--filename", logPath, "--width", "900", "--height", "600"]],
      ["kdialog", ["--title", title, "--textbox", logPath, "900", "600"]],
    ];
    for (const [cmd, args] of attempts) {
      try {
        const t = Date.now();
        const r = spawnSync(cmd, args, { stdio: "ignore" });
        // A fast nonzero exit means the dialog never appeared (binary
        // missing, can't open display) — fall through to the next option.
        if (!r.error && (r.status === 0 || Date.now() - t > 500)) return;
      } catch { /* not installed — try next */ }
    }
  }
  try { window.showMessageBox(title, message); } catch { /* SDL gone */ }
}

/** uncaughtException/unhandledRejection → fatal report + modal dialog, then exit.
 *  Mirrors the Electron path's "dialog closes → app quits" fatal semantics. */
export function installNativeErrorHandlers(window: NativeWindow, appId?: string): void {
  if (errorHandlersInstalled) return;
  errorHandlersInstalled = true;
  const show = (title: string, detail: string) => {
    // stderr first — `draft dev` pipes it to the terminal, so the error is
    // never trapped inside the unselectable SDL box.
    log.fatal("NativeErrorHandlers", `\n${title}:\n${detail}\n`);

    let logPath: string | null = null;
    try {
      const dir = appId ? resolveNativeUserDataDir(appId) : tmpdir();
      mkdirSync(dir, { recursive: true });
      logPath = join(dir, "crash.log");
      writeFileSync(logPath, `${title} — ${new Date().toISOString()}\n\n${detail}\n`);
    } catch { logPath = null; }

    let copied = false;
    try { window.setClipboardText(detail); copied = true; } catch { /* optional */ }

    const notes = ["printed to stderr"];
    if (copied) notes.push("copied to the clipboard");
    if (logPath) notes.push(`written to ${logPath}`);
    const message = detail.slice(0, 4000) + `\n\n(Full error ${notes.join(", ")}.)`;

    showFatalDialog(window, title, message, logPath);
    process.exit(1);
  };
  process.on("uncaughtException", (err) => {
    if (isEpipeError(err)) return; // test-harness teardown, not a crash
    show("Uncaught Exception", err.stack ?? err.message);
  });
  process.on("unhandledRejection", (reason) => {
    if (isEpipeError(reason)) return;
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    show("Unhandled Rejection", detail);
  });
}
