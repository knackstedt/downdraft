// ============================================================================
// DevTools + display + window control IPC handlers
// ============================================================================

import { startGCProfiler, type GCProfilerHandle, type GCStats } from "@downdraft/core";
import { createLogger } from "@downdraft/core/util/logger";
import { ipcMain, screen } from "electron";
import { IPC } from "../../shared/messages";
import type { MainContext } from "../types";

const log = createLogger("info");

let mainGcHandle: GCProfilerHandle | null = null;
let mainPerfTimer: ReturnType<typeof setInterval> | null = null;
let prevCpuUsage = process.cpuUsage();
let prevPerfTime = performance.now();

export function registerDevtoolsHandlers(ctx: MainContext): void {
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
    const fn = (log as any)[level] ?? log.info;
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
}
