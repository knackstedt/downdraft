// ============================================================================
// Main Process — Electron window/lifecycle management
// ============================================================================

import { app, BrowserWindow, ipcMain, Menu, screen, session } from "electron";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { startGCProfiler, type GCProfilerHandle, type GCStats } from "../shared/gc-profiler";
import { IPC } from "../shared/messages";
import { getDb, initDb, terminateDb } from "./db";
import { createLogger } from "./util/logger";

const log = createLogger("info");
const isDev = !app.isPackaged;

// --- Error dialog ---

let errorDialogOpen = false;

function showErrorDialog(title: string, detail: string): void {
  if (errorDialogOpen) return;
  errorDialogOpen = true;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${title.replace(/</g, "&lt;")}</title>
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #111; color: #ff6b6b; font-family: monospace; overflow: hidden; }
    .container { display: flex; flex-direction: column; padding: 1.5rem; height: 100%; gap: 1rem; }
    h1 { margin: 0; font-size: 1rem; color: #ff6b6b; }
    pre { flex: 1; margin: 0; padding: 1rem; background: #1a1a1a; border-radius: 8px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-size: 0.8rem; line-height: 1.4; user-select: text; -webkit-user-select: text; cursor: text; }
    .actions { display: flex; gap: 0.75rem; justify-content: flex-end; }
    button { padding: 0.5rem 1rem; border: none; border-radius: 6px; background: #ff6b6b; color: #fff; font-family: monospace; font-size: 0.85rem; cursor: pointer; }
    button.secondary { background: #333; color: #ccc; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${title.replace(/</g, "&lt;")}</h1>
    <pre id="detail">${detail.replace(/</g, "&lt;")}</pre>
    <div class="actions">
      <button class="secondary" onclick="window.close()">Close</button>
      <button onclick="copyText()">Copy</button>
    </div>
  </div>
  <script>
    function copyText() {
      const pre = document.getElementById('detail');
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(pre);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('copy');
      selection.removeAllRanges();
    }
  </script>
</body>
</html>`;

  const win = new BrowserWindow({
    width: 720,
    height: 480,
    title,
    backgroundColor: "#111111",
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: false, nodeIntegration: false, devTools: false },
  });

  win.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  win.once("ready-to-show", () => { win.show(); win.focus(); });
  win.on("closed", () => { errorDialogOpen = false; });
}

process.on("uncaughtException", (err) => {
  log.error("main", `uncaughtException: ${err.stack ?? err.message}`);
  showErrorDialog("Uncaught Exception", err.stack ?? err.message);
});

process.on("unhandledRejection", (reason) => {
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  log.error("main", `unhandledRejection: ${detail}`);
  showErrorDialog("Unhandled Rejection", detail);
});

// GPU command line switches for Linux WebGPU support
// Force NVIDIA Vulkan ICD to prevent llvmpipe (software) fallback
process.env.VK_ICD_FILENAMES = "/usr/share/vulkan/icd.d/nvidia_icd.json";
app.commandLine.appendSwitch("enable-unsafe-webgpu");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");
app.commandLine.appendSwitch("enable-accelerated-video-decode");
app.commandLine.appendSwitch(
  "enable-features",
  "Vulkan,VaapiVideoDecoder,VaapiVideoEncoder",
);
app.commandLine.appendSwitch("js-flags", "--expose-gc");
app.commandLine.appendSwitch("ozone-platform-hint", "auto");

let mainWindow: BrowserWindow | null = null;

interface WindowState {
  displayId: number;
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

function getWindowStatePath(): string {
  return join(app.getPath("userData"), "window-state.json");
}

function loadWindowState(): WindowState | null {
  try {
    const data = readFileSync(getWindowStatePath(), "utf-8");
    return JSON.parse(data) as WindowState;
  } catch {
    return null;
  }
}

function saveWindowState(win: BrowserWindow): void {
  const bounds = win.getBounds();
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
  const state: WindowState = {
    displayId: display.id,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: win.isMaximized(),
  };
  try {
    writeFileSync(getWindowStatePath(), JSON.stringify(state));
  } catch (e) {
    log.error("main", `Failed to save window state: ${e}`);
  }
}

async function createWindow(): Promise<void> {
  // Enable cross-origin isolation for SharedArrayBuffer
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Cross-Origin-Opener-Policy": ["same-origin"],
        "Cross-Origin-Embedder-Policy": ["require-corp"],
      },
    });
  });

  const savedState = loadWindowState();
  let display: Electron.Display;

  if (savedState) {
    const allDisplays = screen.getAllDisplays();
    display = allDisplays.find((d) => d.id === savedState.displayId) ??
      screen.getDisplayNearestPoint({ x: savedState.x, y: savedState.y });
  } else {
    const cursorPoint = screen.getCursorScreenPoint();
    display = screen.getDisplayNearestPoint(cursorPoint);
  }

  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;

  let winWidth: number;
  let winHeight: number;
  let winX: number;
  let winY: number;

  if (savedState) {
    winWidth = Math.min(savedState.width, dw);
    winHeight = Math.min(savedState.height, dh);
    winX = Math.max(dx, Math.min(savedState.x, dx + dw - winWidth));
    winY = Math.max(dy, Math.min(savedState.y, dy + dh - winHeight));
  } else {
    winWidth = Math.min(1920, dw);
    winHeight = Math.min(1080, dh);
    winX = Math.round(dx + (dw - winWidth) / 2);
    winY = Math.round(dy + (dh - winHeight) / 2);
  }

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: winX,
    y: winY,
    minWidth: 1280,
    minHeight: 720,
    show: false,
    title: "Downdraft Engine",
    backgroundColor: "#001a33",
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webgpu: true,
      enableBlinkFeatures: "SharedArrayBuffer",
    } as any,
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    if (savedState?.isMaximized) {
      mainWindow?.maximize();
    }
    if (isDev) {
      mainWindow?.webContents.openDevTools();
    }
  });

  // Load DevTools extension for 3D Scene Inspector
  const devtoolsExtPath = isDev
    ? join(__dirname, "../../devtools-extension")
    : join(process.resourcesPath, "devtools-extension");

  if (existsSync(devtoolsExtPath)) {
    try {
      session.defaultSession.loadExtension(devtoolsExtPath).then(() => {
        log.info("DevTools", "3D Scene Inspector extension loaded");
      }).catch((err) => {
        log.error("DevTools", `Failed to load extension: ${err}`);
      });
    } catch (err) {
      log.error("DevTools", `Extension load error: ${err}`);
    }
  }

  // Forward renderer console to stdout
  mainWindow.webContents.on("console-message", (event) => {
    const { level, message, lineNumber, sourceId } = event;
    if (message.includes("ResizeObserver loop completed with undelivered notifications")) return;
    if (message.includes("Insecure Content-Security-Policy")) return;
    const levelMap: Record<string, "debug" | "info" | "warn" | "error"> = {
      debug: "debug", info: "info", warning: "warn", error: "error",
    };
    const moduleStr = sourceId ? `${sourceId}:${lineNumber}` : `line:${lineNumber}`;
    (log[levelMap[level] ?? "info"])(moduleStr, message);
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    log.error("main", `render-process-gone: ${details.reason} (exitCode=${details.exitCode})`);
    showErrorDialog("Renderer Process Gone", `Reason: ${details.reason}\nExit code: ${details.exitCode}`);
  });

  mainWindow.on("close", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      saveWindowState(mainWindow);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Send display refresh rate to renderer
  let lastDisplayId = display.id;
  const sendDisplayInfo = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const winBounds = mainWindow.getBounds();
    const currentDisplay = screen.getDisplayNearestPoint({ x: winBounds.x, y: winBounds.y });
    if (currentDisplay.id !== lastDisplayId) {
      lastDisplayId = currentDisplay.id;
    }
    mainWindow.webContents.send(IPC.DISPLAY_INFO, { refreshRate: currentDisplay.displayFrequency });
  };

  mainWindow.webContents.once("did-finish-load", () => {
    sendDisplayInfo();
  });

  let moveTimer: NodeJS.Timeout | null = null;
  mainWindow.on("move", () => {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      sendDisplayInfo();
      moveTimer = null;
    }, 200);
  });

  if (isDev) {
    const devServerUrl = process.env.ELECTRON_RENDERER_URL;
    if (devServerUrl) {
      await mainWindow.loadURL(devServerUrl);
    } else {
      await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
    }
  } else {
    await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.SAVE_GAME_STATE, async (_event, slotName: string, stateJson: string) => {
    try {
      const db = await getDb();
      await db.query("UPSERT type::record('save_game', $slot) SET state = $state, updated_at = time::now()", { slot: slotName, state: stateJson });
      log.info("main", `Saved game state to slot '${slotName}'`);
      return true;
    } catch (err) {
      log.error("main", `DB save failed: ${err}`);
      return false;
    }
  });

  ipcMain.handle(IPC.LOAD_GAME_STATE, async (_event, slotName: string) => {
    try {
      const db = await getDb();
      const result = await db.query<any[]>("SELECT state FROM type::record('save_game', $slot)", { slot: slotName });
      if (result && result[0]?.state) {
        log.info("main", `Loaded game state from slot '${slotName}'`);
        return result[0].state as string;
      }
      return null;
    } catch (err) {
      log.error("main", `DB load failed: ${err}`);
      return null;
    }
  });

  ipcMain.on(IPC.RENDERER_LOG, (_event, data: { level: string; message: string }) => {
    const level = data.level as "trace" | "debug" | "info" | "warn" | "error" | "fatal";
    const fn = (log as any)[level] ?? log.info;
    fn.call(log, "renderer", data.message);
  });

  let mainGcHandle: GCProfilerHandle | null = null;
  ipcMain.on(IPC.DEBUG_MODE, (_event, enabled: boolean) => {
    if (enabled) {
      if (!mainGcHandle) {
        mainGcHandle = startGCProfiler('main', (stats: GCStats) => {
          mainWindow?.webContents.send(IPC.GC_STATS, stats);
        });
      }
    } else {
      mainGcHandle?.stop();
      mainGcHandle = null;
    }
  });

  ipcMain.on(IPC.TOGGLE_DEVTOOLS, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
      } else {
        mainWindow.webContents.openDevTools();
      }
    }
  });

  ipcMain.on(IPC.TOGGLE_FULLSCREEN, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
  });

  ipcMain.handle(IPC.QUIT, () => {
    app.quit();
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  registerIpcHandlers();
  await initDb();
  await createWindow();
  mainWindow?.webContents.send(IPC.SIM_READY, { isDev });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", async () => {
  await terminateDb();
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createWindow();
  }
});
