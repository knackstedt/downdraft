// ============================================================================
// DevTools + display + window control IPC handlers
// ============================================================================

import { startGCProfiler, type GCProfilerHandle, type GCStats } from "@downdraft/engine";
import { createLogger } from "@downdraft/engine/util/logger";
import { ipcMain, screen } from "electron";
import { IPC } from "../../shared/messages";
import type { DevtoolsConfig, MainContext } from "../types";

const log = createLogger("info");

let mainGcHandle: GCProfilerHandle | null = null;
let mainPerfTimer: ReturnType<typeof setInterval> | null = null;
let prevCpuUsage = process.cpuUsage();
let prevPerfTime = performance.now();

/**
 * Resolved DevTools configuration after applying defaults.
 * `enabled` is false only when the feature is explicitly disabled.
 */
export interface ResolvedDevtoolsConfig {
  enabled: boolean;
  autoOpen: boolean;
  keybind: string;
  debugPort: number | null;
}

const DISABLED: ResolvedDevtoolsConfig = { enabled: false, autoOpen: false, keybind: "", debugPort: null };

/**
 * Normalize the `features.devtools` value (boolean | object | undefined) into a
 * fully-resolved config. Defaults: enabled `true`, autoOpen `true`, keybind `"F12"`.
 *
 * In deterministic/test mode (DOWNDRAFT_DETERMINISTIC=1), autoOpen defaults to
 * `false` and keybind defaults to `""` (disabled) — the DevTools panel steals
 * focus from the canvas and interferes with headless testing. Games no longer
 * need to plumb `devtools: { autoOpen: !deterministic, keybind: deterministic ? "" : "F12" }`
 * themselves; this is the engine default.
 */
export function resolveDevtoolsConfig(
  feature: DevtoolsConfig | boolean | undefined,
): ResolvedDevtoolsConfig {
  if (feature === false) return DISABLED;
  const cfg: DevtoolsConfig = feature === true || feature === undefined ? {} : feature;
  if (cfg.enabled === false) return DISABLED;
  const deterministic = process.env.DOWNDRAFT_DETERMINISTIC === "1";
  return {
    enabled: true,
    autoOpen: cfg.autoOpen ?? !deterministic,
    keybind: cfg.keybind ?? (deterministic ? "" : "F12"),
    debugPort: cfg.debugPort ?? null,
  };
}

export function registerDevtoolsHandlers(ctx: MainContext, devtools: ResolvedDevtoolsConfig): void {
  // --- Global keybind toggle (main-process before-input-event) ---
  // Handled in the main process so it works regardless of renderer code.
  // preventDefault() also suppresses the matching keydown in the page,
  // avoiding double-toggle.
  if (devtools.keybind && ctx.window && !ctx.window.isDestroyed()) {
    ctx.window.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || (input as { repeat?: boolean }).repeat) return;
      if (input.key === devtools.keybind) {
        event.preventDefault();
        if (ctx.window && !ctx.window.isDestroyed()) {
          if (ctx.window.webContents.isDevToolsOpened()) {
            ctx.window.webContents.closeDevTools();
          } else {
            ctx.window.webContents.openDevTools();
          }
        }
      }
    });
  }

  ipcMain.on(IPC.DEBUG_MODE, (_event, enabled: boolean) => {
    if (enabled) {
      if (!mainGcHandle) {
        mainGcHandle = startGCProfiler('main', (stats: GCStats) => {
          ctx.window?.webContents.send(IPC.GC_STATS, stats);
        });
      }
      if (!mainPerfTimer) {
        prevCpuUsage = process.cpuUsage();
        prevPerfTime = performance.now();
        mainPerfTimer = setInterval(() => {
          const now = performance.now();
          const wallMs = now - prevPerfTime;
          const cpu = process.cpuUsage(prevCpuUsage);
          const cpuPercent = ((cpu.user + cpu.system) / 1000) / wallMs * 100;
          const mem = process.memoryUsage();
          ctx.window?.webContents.send(IPC.PERF_STATS, {
            process: "main",
            cpuPercent: Math.min(100, cpuPercent),
            memUsedMB: mem.rss / 1048576,
            heapUsedMB: mem.heapUsed / 1048576,
            heapTotalMB: mem.heapTotal / 1048576,
            externalMB: mem.external / 1048576,
            timestamp: now,
          });
          prevCpuUsage = process.cpuUsage();
          prevPerfTime = now;
        }, 2000);
      }
    } else {
      mainGcHandle?.stop();
      mainGcHandle = null;
      if (mainPerfTimer) { clearInterval(mainPerfTimer); mainPerfTimer = null; }
    }
  });

  ipcMain.on(IPC.TOGGLE_DEVTOOLS, () => {
    if (ctx.window && !ctx.window.isDestroyed()) {
      if (ctx.window.webContents.isDevToolsOpened()) {
        ctx.window.webContents.closeDevTools();
      } else {
        ctx.window.webContents.openDevTools();
      }
    }
  });

  ipcMain.on(IPC.TOGGLE_FULLSCREEN, () => {
    if (ctx.window && !ctx.window.isDestroyed()) {
      ctx.window.setFullScreen(!ctx.window.isFullScreen());
    }
  });

  ipcMain.on(IPC.OPEN_EXTERNAL, (_event, url: string) => {
    ctx.shell.openExternal(url);
  });

  ipcMain.handle(IPC.GET_DISPLAY_INFO, () => {
    if (!ctx.window || ctx.window.isDestroyed()) return { refreshRate: 0 };
    const winBounds = ctx.window.getBounds();
    const currentDisplay = screen.getDisplayNearestPoint({ x: winBounds.x, y: winBounds.y });
    return { refreshRate: currentDisplay.displayFrequency };
  });

  ipcMain.on(IPC.RENDERER_LOG, (_event, data: { level: string; message: string }) => {
    const level = data.level as "trace" | "debug" | "info" | "warn" | "error" | "fatal";
    const fn = (log as Record<typeof level, (module: string, msg: string) => void>)[level] ?? log.info;
    fn.call(log, "renderer", data.message.replace(/\n+$/, ""));
  });

  ipcMain.on(IPC.OPEN_CHROME_URL, (_event, url: string) => {
    const win = new ctx.BrowserWindow({
      width: 1200,
      height: 800,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.loadURL(url);
  });

  ipcMain.handle(IPC.QUIT, () => {
    ctx.app.quit();
  });

  // --- Full-page screenshot (canvas + DOM overlay) ---
  // Uses webContents.capturePage() which composites the WebGPU canvas and
  // all DOM overlay layers into a single NativeImage. Returns the PNG-encoded
  // buffer so the renderer can base64-encode it for MCP tool responses.
  ipcMain.handle(IPC.CAPTURE_PAGE, async () => {
    if (!ctx.window || ctx.window.isDestroyed()) return null;
    const image = await ctx.window.webContents.capturePage();
    if (image.isEmpty()) return null;
    return image.toPNG();
  });
}
