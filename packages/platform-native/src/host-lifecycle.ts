// ============================================================================
// host-lifecycle.ts — native host lifecycle features:
//
//   - single-instance lock (per-appId singleton.lock in userData)
//   - window-state persistence (size/position restored across runs)
//   - error dialogs (SDL_ShowSimpleMessageBox + stderr/clipboard mirror)
//
// Wired into createNativeHost when appId is set; deterministic/test mode and
// DOWNDRAFT_MULTI_INSTANCE=1 opt out of the single-instance lock so e2e and
// dev workflows can still run concurrent instances.
// ============================================================================

import { condenseText, encodeFeatureLogLines, formatBytesShort, type FeatureLogData } from "@downdraft/engine";
import { collectHostFeatureLog } from "@downdraft/engine/app/shared/feature-log";
import { createLogger } from "@downdraft/engine/util/logger";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNativeUserDataDir } from "./bridge/user-data-dir";
import { isPackaged } from "./packaged";
import type { NativeWindow } from "./window/native-window";

const log = createLogger("info");

// ── Single-instance lock ─────────────────────────────────────────────────────
// A lock file at <userData>/singleton.lock holds the owning PID. A live PID
// means another instance is running — the new one exits. Stale locks (dead
// PID) are reclaimed.

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
// SDL_ShowSimpleMessageBox is modal + blocking, but its X11 fallback renders
// unselectable text in a barebones window. So the full error is mirrored to
// stderr, the clipboard, and <userData>/crash.log before the dialog opens,
// and on Linux a zenity/kdialog text view (selectable, scrollable) is
// preferred when available. Install once.

let errorHandlersInstalled = false;

// ── Crash-report sections ────────────────────────────────────────────────────
// Feature-log providers register as boot progresses: installNativeErrorHandlers
// registers a GPU-less baseline, the native bridge re-registers once adapter
// info exists, and runNativeGameModule registers the render line (WebGPU
// features/limits) after startGame's bootstrap collects it. Providers are
// deduped by scope at report time — the last registration wins.

const crashFeatureLogProviders: Array<() => FeatureLogData | null> = [];

/** Register a FeatureLogData provider included in fatal crash reports. */
export function addCrashFeatureLog(provider: () => FeatureLogData | null): void {
  crashFeatureLogProviders.push(provider);
}

interface CrashFeatureLogs {
  host: FeatureLogData | null;
  render: FeatureLogData | null;
}

function collectCrashFeatureLogs(): CrashFeatureLogs {
  const byScope = new Map<string, FeatureLogData>();
  crashFeatureLogProviders.forEach((provider) => {
    try {
      const data = provider();
      if (data) byScope.set(data.scope, data);
    } catch { /* provider failed mid-crash — skip it */ }
  });
  // "host" is the single-process native scope.
  return { host: byScope.get("host") ?? null, render: byScope.get("render") ?? null };
}

/** Human-readable rendering of the feature-log data — the dd1| lines are kept
 *  separately below for pasting into bug reports. */
function systemSection(logs: CrashFeatureLogs, window: NativeWindow): string | null {
  const m = logs.host;
  const r = logs.render;
  const rows: Array<[string, string]> = [];

  if (m?.os) rows.push(["os", `${m.os} ${m.osRel ?? ""}${m.arch ? ` (${m.arch})` : ""}`.trim()]);
  if (m?.cpu) rows.push(["cpu", `${m.cpu} · ${m.cpuCores ?? "?"} cores`]);
  if (m?.mem) rows.push(["ram", m.mem]);
  const gpu = m?.gpu ?? (r?.wgpu ? condenseText(r.wgpu, 96) : null);
  if (gpu) rows.push(["gpu", m?.drv ? `${gpu} · drv ${m.drv}` : gpu]);
  const version = m?.v ?? r?.v;
  const mode = m?.mode ?? r?.mode;
  if (version) rows.push(["engine", `v${version}${mode ? ` · ${mode}` : ""}`]);
  const rt = (m as unknown as Record<string, unknown> | null)?.rt as string | undefined;
  const runtimes = [rt, m?.node && `node ${m.node}`, m?.v8 && `v8 ${m.v8}`]
    .filter((s): s is string => !!s);
  if (runtimes.length > 0) rows.push(["runtime", runtimes.join(" · ")]);
  try {
    const { width, height } = window.getWindowSize();
    const disp = window.getDisplayInfo();
    rows.push(["display", `${width}x${height} @${disp.refreshRate}Hz · ×${disp.scaleFactor}`]);
  } catch { /* SDL already torn down */ }
  if (r?.sab !== undefined) rows.push(["sab", r.sab === 1 ? "yes" : "no"]);
  if (r?.plug) rows.push(["plugins", r.plug]);

  if (rows.length === 0) return null;
  const pad = Math.max(...rows.map(([k]) => k.length));
  return `--- System ---\n${rows.map(([k, v]) => `${k.padEnd(pad)}  ${v}`).join("\n")}`;
}

function environmentSection(appId?: string): string {
  const mem = process.memoryUsage();
  const lines = [
    `appId=${appId ?? "(none)"}`,
    `pid=${process.pid} uptime=${process.uptime().toFixed(1)}s`,
    `packaged=${isPackaged()}`,
    `cwd=${process.cwd()}`,
    `exec=${process.execPath}`,
    `argv=${process.argv.join(" ")}`,
    `mem=rss:${formatBytesShort(mem.rss)} heap:${formatBytesShort(mem.heapUsed)}/${formatBytesShort(mem.heapTotal)}`,
  ];
  const ddEnv = Object.keys(process.env).filter((k) => k.startsWith("DOWNDRAFT_")).sort();
  if (ddEnv.length > 0) {
    lines.push(`env=${ddEnv.map((k) => `${k}=${process.env[k]}`).join(" ")}`);
  }
  return `--- Environment ---\n${lines.join("\n")}`;
}

function featureLogSection(logs: CrashFeatureLogs): string | null {
  const encoded = encodeFeatureLogLines(logs.host, logs.render);
  return encoded ? `--- Feature Log ---\n${encoded}` : null;
}

function isEpipeError(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    return (err as { code: string }).code === "EPIPE";
  }
  return err instanceof Error && err.message.includes("write EPIPE");
}

/** Modal fatal-error dialog. On Linux, prefer zenity/kdialog showing the crash
 *  log in a selectable text view (both are Linux-only but always preinstalled
 *  on GTK/KDE desktops — nothing is bundled). Elsewhere SDL's message box is
 *  already the native TaskDialog (Windows) / NSAlert (macOS); those just lack
 *  selectable text, so the crash log is also opened in the OS's built-in text
 *  viewer (notepad / TextEdit). SDL's barebones X11 box is the last resort. */
function showFatalDialog(window: NativeWindow, title: string, message: string, logPath: string | null): void {
  if (process.platform === "linux" && logPath) {
    const attempts: [string, string[]][] = [
      ["zenity", ["--text-info", "--title", title, "--filename", logPath,
        "--font", "Monospace 10", "--width", "960", "--height", "640", "--ok-label", "Quit"]],
      ["kdialog", ["--title", title, "--textbox", logPath, "960", "640"]],
    ];
    // A fast nonzero exit means the dialog never appeared (binary missing,
    // can't open display) — fall through to the next option.
    const shown = attempts.some(([cmd, args]) => {
      try {
        const t = Date.now();
        const r = spawnSync(cmd, args, { stdio: "ignore" });
        return !r.error && (r.status === 0 || Date.now() - t > 500);
      } catch { return false; /* not installed — try next */ }
    });
    if (shown) return;
  }
  if (logPath && process.platform !== "linux") {
    const viewer: [string, string[]] | null = process.platform === "win32"
      ? ["notepad", [logPath]]
      : process.platform === "darwin"
        ? ["open", ["-t", logPath]]
        : null;
    if (viewer) {
      try {
        const child = spawn(viewer[0], viewer[1], { detached: true, stdio: "ignore" });
        child.on("error", () => { /* viewer missing — the SDL box still shows */ });
        child.unref();
      } catch { /* best-effort */ }
    }
  }
  try { window.showMessageBox(title, message); } catch { /* SDL gone */ }
}

/** uncaughtException/unhandledRejection → fatal report + modal dialog, then exit.
 *  "Dialog closes → app quits" fatal semantics. */
export function installNativeErrorHandlers(window: NativeWindow, appId?: string): void {
  if (errorHandlersInstalled) return;
  errorHandlersInstalled = true;

  // Baseline host feature log so pre-bridge crashes (GPU bring-up, services
  // worker spawn) still carry the dd1|... line. The bridge re-registers with
  // GPU identity once it exists — last registration per scope wins.
  addCrashFeatureLog(() => collectHostFeatureLog({
    isDev: !isPackaged(),
    deterministic: false,
    flags: [],
  }));

  const show = (title: string, detail: string) => {
    const logs = collectCrashFeatureLogs();
    const sections = [
      systemSection(logs, window),
      environmentSection(appId),
      featureLogSection(logs),
    ].filter((s): s is string => s !== null);
    const report = sections.length > 0 ? `${detail}\n\n${sections.join("\n\n")}` : detail;

    // stderr first — `draft dev` pipes it to the terminal, so the error is
    // never trapped inside the unselectable SDL box.
    log.fatal("NativeErrorHandlers", `\n${title}:\n${report}\n`);

    let logPath: string | null = null;
    try {
      const dir = appId ? resolveNativeUserDataDir(appId) : tmpdir();
      mkdirSync(dir, { recursive: true });
      logPath = join(dir, "crash.log");
      writeFileSync(logPath, `${title} — ${new Date().toISOString()}\n\n${report}\n`);
    } catch { logPath = null; }

    let copied = false;
    try { window.setClipboardText(`${title}\n\n${report}`); copied = true; } catch { /* optional */ }

    const notes = ["printed to stderr"];
    if (copied) notes.push("copied to the clipboard");
    if (logPath) notes.push(`written to ${logPath}`);
    // Cap the raw error so the feature-log/environment tail still fits in the
    // SDL fallback; zenity/kdialog show the untruncated crash.log instead.
    const cappedDetail = detail.length > 3000 ? `${detail.slice(0, 3000)}\n…(truncated)` : detail;
    const message = `${cappedDetail}\n\n${sections.join("\n\n")}`.slice(0, 4000)
      + `\n\n(Full error ${notes.join(", ")}.)`;

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
