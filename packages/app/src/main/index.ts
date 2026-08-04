// ============================================================================
// Main Process — Electron window/lifecycle management
// ============================================================================

import { startGCProfiler, type GCProfilerHandle, type GCStats } from "@downdraft/core";
import { createLogger } from "@downdraft/core/util/logger";
import { McpHttpTransport, type McpProxyHandler } from "@downdraft/mcp/http-transport";
import { InputForwarder, OSRRendererManager } from "@downdraft/plugin-electron-osr/main-entry";
import { FileSaveStore } from "@downdraft/plugin-persistence";
import { app, BrowserWindow, ipcMain, Menu, screen, session, shell } from "electron";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "path";
import { IPC } from "../shared/messages";

const log = createLogger("info");
const isDev = !app.isPackaged;

// --- Error dialog ---

let errorDialogOpen = false;
let exitOnDialogClose = false;

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
  win.on("closed", () => {
    errorDialogOpen = false;
    if (exitOnDialogClose) {
      const forceExitTimer = setTimeout(() => process.exit(1), 3000);
      forceExitTimer.unref();
      app.quit();
    }
  });
}

function isEpipeError(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    return (err as { code: string }).code === "EPIPE";
  }
  if (err instanceof Error && err.message.includes("write EPIPE")) return true;
  return false;
}

process.on("uncaughtException", (err) => {
  exitOnDialogClose = true;
  if (isEpipeError(err)) {
    showErrorDialog("Uncaught Exception (EPIPE)", err.stack ?? err.message);
    return;
  }
  log.error("main", `uncaughtException: ${err.stack ?? err.message}`);
  showErrorDialog("Uncaught Exception", err.stack ?? err.message);
});

process.on("unhandledRejection", (reason) => {
  exitOnDialogClose = true;
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  if (isEpipeError(reason)) {
    showErrorDialog("Unhandled Rejection (EPIPE)", detail);
    return;
  }
  log.error("main", `unhandledRejection: ${detail}`);
  showErrorDialog("Unhandled Rejection", detail);
});

// GPU command line switches for WebGPU support
app.commandLine.appendSwitch("enable-unsafe-webgpu");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");
app.commandLine.appendSwitch("enable-accelerated-video-decode");
app.commandLine.appendSwitch("js-flags", "--expose-gc");

if (process.platform === "linux") {
  // Force NVIDIA Vulkan ICD to prevent llvmpipe (software) fallback
  process.env.VK_ICD_FILENAMES = "/usr/share/vulkan/icd.d/nvidia_icd.json";
  app.commandLine.appendSwitch("enable-features", "Vulkan,VaapiVideoDecoder,VaapiVideoEncoder");
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");
} else if (process.platform === "win32") {
  // Windows uses D3D12 backend for WebGPU; enable hardware-accelerated decoding
  app.commandLine.appendSwitch("enable-features", "D3D12VideoDecoder");
}

let mainWindow: BrowserWindow | null = null;
let osrManager: OSRRendererManager | null = null;
let osrInputForwarder: InputForwarder | null = null;

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
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webgpu: true,
      enableBlinkFeatures: "SharedArrayBuffer",
      sharedTexture: true,
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

    // Auto-capture screenshot after 5s for verification
    if (process.env.DOWNDRAFT_GAME === "plugin-tester") {
      setTimeout(async () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        try {
          const img = await mainWindow.webContents.capturePage();
          const outPath = "/tmp/plugin-tester-electron.png";
          writeFileSync(outPath, img.toPNG());
          log.info("screenshot", `Saved to ${outPath}`);
        } catch (e) {
          log.error("screenshot", `Failed: ${(e as Error).message}`);
        }
      }, 5000);
    }
  });

  // Load DevTools extension for 3D Scene Inspector
  const devtoolsExtPath = isDev
    ? join(__dirname, "../../packages/plugins/devtools/extension")
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

  // Initialize OSR manager
  osrManager = new OSRRendererManager();
  osrManager.setTargetWebContents(mainWindow.webContents);
  osrManager.setEventCallback((event) => {
    mainWindow?.webContents.send(IPC.OSR_RENDERER_EVENT, event);
  });
  osrManager.registerDisplayMetricsListener();
  osrInputForwarder = new InputForwarder(osrManager);

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

  // Forward display scale factor (DPR) changes to the renderer
  screen.on("display-metrics-changed", (_event, display, changedMetrics) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (changedMetrics.includes("scaleFactor")) {
      const winBounds = mainWindow.getBounds();
      const currentDisplay = screen.getDisplayNearestPoint({ x: winBounds.x, y: winBounds.y });
      if (currentDisplay.id === display.id) {
        mainWindow.webContents.send(IPC.DISPLAY_METRICS_CHANGED, { scaleFactor: display.scaleFactor });
      }
    }
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

let saveStore: FileSaveStore | null = null;

function getSaveStore(): FileSaveStore {
  if (!saveStore) {
    const saveDir = join(app.getPath("userData"), "saves");
    saveStore = new FileSaveStore({
      saveDir,
      engineVersion: app.getVersion() || "0.1.0",
      skipMigrations: true,
    });
    saveStore.onWarning((w: { kind: string; slot: string; message: string }) => {
      log.warn("save", `[${w.kind}] slot='${w.slot}': ${w.message}`);
    });
  }
  return saveStore;
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.SAVE_GAME_STATE, async (_event, slotName: string, stateJson: string) => {
    try {
      const store = getSaveStore();
      // Parse the state JSON from the renderer, wrap it in a SaveState
      const components = JSON.parse(stateJson);
      const result = await store.save(slotName, {
        components,
        meta: {
          engineVersion: app.getVersion() || "0.1.0",
          timestamp: Date.now() / 1000,
          entityCount: 0,
          playerCount: 0,
        },
      });
      log.info("main", `Saved game state to slot '${slotName}' (${result.bytes} bytes)`);
      return result.success;
    } catch (err) {
      log.error("main", `Save failed: ${err}`);
      return false;
    }
  });

  ipcMain.handle(IPC.LOAD_GAME_STATE, async (_event, slotName: string) => {
    try {
      const store = getSaveStore();
      const result = await store.load(slotName);
      if (result.state) {
        log.info("main", `Loaded game state from slot '${slotName}'`);
        return JSON.stringify(result.state.components);
      }
      log.info("main", `No save found for slot '${slotName}'`);
      return null;
    } catch (err) {
      log.error("main", `Load failed: ${err}`);
      return null;
    }
  });

  ipcMain.handle(IPC.DELETE_GAME_STATE, async (_event, slotName: string) => {
    try {
      const store = getSaveStore();
      return store.deleteSave(slotName);
    } catch (err) {
      log.error("main", `Delete save failed: ${err}`);
      return false;
    }
  });

  ipcMain.handle(IPC.LIST_SAVE_SLOTS, async () => {
    try {
      const store = getSaveStore();
      return store.listSaves();
    } catch (err) {
      log.error("main", `List saves failed: ${err}`);
      return [];
    }
  });

  ipcMain.handle(IPC.GET_DISPLAY_INFO, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { refreshRate: 0 };
    const winBounds = mainWindow.getBounds();
    const currentDisplay = screen.getDisplayNearestPoint({ x: winBounds.x, y: winBounds.y });
    return { refreshRate: currentDisplay.displayFrequency };
  });

  ipcMain.on(IPC.RENDERER_LOG, (_event, data: { level: string; message: string }) => {
    const level = data.level as "trace" | "debug" | "info" | "warn" | "error" | "fatal";
    const fn = (log as any)[level] ?? log.info;
    fn.call(log, "renderer", data.message);
  });

  let mainGcHandle: GCProfilerHandle | null = null;
  let mainPerfTimer: ReturnType<typeof setInterval> | null = null;
  let prevCpuUsage = process.cpuUsage();
  let prevPerfTime = performance.now();
  ipcMain.on(IPC.DEBUG_MODE, (_event, enabled: boolean) => {
    if (enabled) {
      if (!mainGcHandle) {
        mainGcHandle = startGCProfiler('main', (stats: GCStats) => {
          mainWindow?.webContents.send(IPC.GC_STATS, stats);
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
          mainWindow?.webContents.send(IPC.PERF_STATS, {
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

  ipcMain.on(IPC.OPEN_EXTERNAL, (_event, url: string) => {
    shell.openExternal(url);
  });

  // --- GPU System Info (nvidia-smi) ---

  ipcMain.handle(IPC.GPU_SYSTEM_INFO, async () => {
    try {
      const gpuQuery = "utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,clocks.sm,clocks.mem,name,driver_version";
      const output = execSync(
        `nvidia-smi --query-gpu=${gpuQuery} --format=csv,noheader,nounits`,
        { timeout: 3000, encoding: "utf-8" },
      ).trim();

      const labels = gpuQuery.split(",").map(l => l.replace(/\./g, "_"));
      const gpus = output.split("\n").map((line: string) => {
        const vals = line.trim().split(",").map((v: string) => v.trim());
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < labels.length && i < vals.length; i++) {
          const num = parseFloat(vals[i]);
          obj[labels[i]] = isNaN(num) ? vals[i] : num;
        }
        return obj;
      });

      let processes: Array<Record<string, unknown>> = [];
      try {
        const procOutput = execSync(
          "nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits",
          { timeout: 3000, encoding: "utf-8" },
        ).trim();
        if (procOutput) {
          processes = procOutput.split("\n").map((line: string) => {
            const vals = line.trim().split(",").map((v: string) => v.trim());
            return {
              pid: parseInt(vals[0]) || 0,
              processName: vals[1] || "",
              usedMemoryMB: parseFloat(vals[2]) || 0,
            };
          });
        }
      } catch {
        // nvidia-smi process query not available
      }

      return { gpus, processes, source: "nvidia-smi", timestamp: Date.now() };
    } catch {
      return null;
    }
  });

  // --- Electron GPU Info (app.getGPUInfo) ---

  ipcMain.handle(IPC.ELECTRON_GPU_INFO, async () => {
    try {
      const info = await app.getGPUInfo("complete");
      if (info && typeof info === "object") {
        const g = info as any;
        const devices = Array.isArray(g.gpuDevice) ? g.gpuDevice : [];
        const primary = devices[0] ?? {};
        return {
          gpuVendor: g.gpuVendor || primary.vendor || "",
          gpuDevice: primary.device || (devices.length > 0 ? devices.map((d: any) => d.device || d.description || "").join(", ") : ""),
          gpuDriver: g.gpuDriver || "",
          gpuDriverVersion: g.gpuDriverVersion || "",
          gpuActive: g.gpuActive,
          auxAttributes: g.auxAttributes,
          featureStatus: g.featureStatus,
          source: "electron app.getGPUInfo",
        };
      }
      return null;
    } catch {
      return null;
    }
  });

  // --- Vulkan Validation Layer Status ---

  ipcMain.handle(IPC.VULKAN_VALIDATION_STATUS, async () => {
    const enabled = process.env.VK_LAYER_KHRONOS_validation === "1" ||
      process.env.VK_LAYER_KHRONOS_validation === "true" ||
      process.env.ENABLE_VULKAN_VALIDATION === "1";
    return { enabled, envVar: process.env.VK_LAYER_KHRONOS_VALIDATION ?? null };
  });

  // --- Open chrome:// URL in new window ---

  ipcMain.on(IPC.OPEN_CHROME_URL, (_event, url: string) => {
    const win = new BrowserWindow({
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
    app.quit();
  });

  // --- OSR (Offscreen Rendering) ---

  ipcMain.handle(IPC.OSR_CREATE_RENDERER, async (_event, config: any) => {
    if (!osrManager) throw new Error("OSR manager not initialized");
    osrManager.createRenderer(config);
  });

  ipcMain.handle(IPC.OSR_DESTROY_RENDERER, async (_event, id: string) => {
    if (!osrManager) return;
    osrManager.destroyRenderer(id);
  });

  ipcMain.handle(IPC.OSR_ADD_PANEL, async (_event, config: any) => {
    if (!osrManager) return null;
    const renderer = osrManager.getRenderer(config.rendererId);
    if (!renderer) return null;
    const rect = renderer.addPanel(config);
    if (rect) {
      const layout = osrManager.getAtlasLayout(config.rendererId);
      mainWindow?.webContents.send(IPC.OSR_PANEL_LAYOUT, config.rendererId, layout);
    }
    return rect;
  });

  ipcMain.handle(IPC.OSR_REMOVE_PANEL, async (_event, rendererId: string, panelId: string) => {
    if (!osrManager) return null;
    const renderer = osrManager.getRenderer(rendererId);
    if (!renderer) return null;
    renderer.removePanel(panelId);
    const layout = osrManager.getAtlasLayout(rendererId);
    mainWindow?.webContents.send(IPC.OSR_PANEL_LAYOUT, rendererId, layout);
    return layout;
  });

  ipcMain.handle(IPC.OSR_UPDATE_PANEL, async (_event, rendererId: string, panelId: string, html: string) => {
    if (!osrManager) return;
    const renderer = osrManager.getRenderer(rendererId);
    if (!renderer) return;
    renderer.updatePanelContent(panelId, html);
  });

  ipcMain.on(IPC.OSR_UPDATE_DATA, (_event, rendererId: string, panelId: string, values: Record<string, string | number | boolean>) => {
    if (!osrManager) return;
    const renderer = osrManager.getRenderer(rendererId);
    if (!renderer) return;
    renderer.applyDataUpdate({ rendererId, panelId, values });
  });

  ipcMain.handle(IPC.OSR_SET_CONTENT, async (_event, rendererId: string, html: string) => {
    if (!osrManager) return;
    const renderer = osrManager.getRenderer(rendererId);
    if (!renderer) return;
    if (renderer.mode === "dedicated") {
      (renderer as any).setContent(html);
    }
  });

  ipcMain.on(IPC.OSR_INPUT_EVENT, (_event, rendererId: string, eventData: any) => {
    if (!osrInputForwarder) return;
    osrInputForwarder.forward({ rendererId, ...eventData });
  });

  ipcMain.on(IPC.OSR_SET_SOFTWARE_CURSOR, (_event, rendererId: string, enabled: boolean) => {
    if (!osrManager) return;
    const renderer = osrManager.getRenderer(rendererId);
    if (renderer) {
      (renderer as any).setSoftwareCursorEnabled(enabled);
    }
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  registerIpcHandlers();
  await createWindow();
  mainWindow?.webContents.send(IPC.SIM_READY, { isDev });

  // Start MCP HTTP transport in proxy mode
  const mcpPort = parseInt(process.env.MCP_PORT ?? "9876", 10);
  const proxyHandler: McpProxyHandler = async (request: { method: string; params?: Record<string, unknown> }) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error("No renderer window available");
    }
    const requestId = Date.now() + Math.random();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ipcMain.removeAllListeners("mcp-response");
        reject(new Error("MCP request timed out"));
      }, 5000);

      ipcMain.once("mcp-response", (_e, result) => {
        clearTimeout(timeout);
        if (result.error) {
          resolve({ error: result.error });
        } else {
          resolve(result.result);
        }
      });

      mainWindow!.webContents.send(IPC.MCP_REQUEST, {
        id: requestId,
        method: request.method,
        params: request.params,
      });
    });
  };

  try {
    const transport = new McpHttpTransport({ port: mcpPort, proxyHandler });
    await transport.start();
    log.info("MCP", `HTTP transport listening on port ${mcpPort}`);
  } catch (e) {
    log.error("MCP", `Failed to start HTTP transport: ${(e as Error).message}`);
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", async () => {
  osrManager?.destroy();
  osrManager = null;
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createWindow();
  }
});
