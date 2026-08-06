// ============================================================================
// Window creation — placement, state persistence, console forwarding
// ============================================================================

import { createLogger } from "@downdraft/core/util/logger";
import type { app as App, BrowserWindow, screen as Screen, session as Session } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "path";
import { showErrorDialog } from "./error-dialog";
import type { DowndraftWindowConfig, WindowPlacement } from "./types";

const log = createLogger("info");

interface WindowState {
  displayId: number;
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

function resolveWindowStatePath(app: typeof App, stateFile: string | undefined): string {
  return join(app.getPath("userData"), stateFile ?? "window-state.json");
}

function loadWindowState(app: typeof App, stateFile: string | undefined): WindowState | null {
  try {
    const data = readFileSync(resolveWindowStatePath(app, stateFile), "utf-8");
    return JSON.parse(data) as WindowState;
  } catch {
    return null;
  }
}

function saveWindowState(
  app: typeof App,
  win: BrowserWindow,
  screen: typeof Screen,
  stateFile: string | undefined,
): void {
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
    writeFileSync(resolveWindowStatePath(app, stateFile), JSON.stringify(state));
  } catch (e) {
    log.error("main", `Failed to save window state: ${e}`);
  }
}

// --- Console forwarding (throttled) ---

const consoleThrottle = new Map<string, { count: number; lastLogged: number; suppressed: number }>();
const CONSOLE_THROTTLE_MS = 1000;
const WEBGPU_CASCADE_RE = /is invalid due to a previous error|While (encoding|validating|finishing|calling|creating)/;

function normalizeConsoleMessage(msg: string): string {
  return msg
    .replace(/\b0x[0-9a-fA-F]+\b/g, "0xADDR")
    .replace(/\[\d+\]/g, "[N]")
    .trim()
    .slice(0, 200);
}

function attachConsoleForwarding(win: BrowserWindow): void {
  win.webContents.on("console-message", (event) => {
    const { level, message: rawMessage, lineNumber, sourceId } = event;
    const message = rawMessage.replace(/\n+$/, "");
    if (message.includes("ResizeObserver loop completed with undelivered notifications")) return;
    if (message.includes("Insecure Content-Security-Policy")) return;
    if (message.includes("[vite]") || message.includes("[@vitejs/")) return;
    if (message.includes("Download the React DevTools")) return;
    if (message.includes("enableBlinkFeatures") || message.includes("blinkFeatures")) return;

    const logMatch = message.match(
      /^\d{2}:\d{2}:\d{2}\s+(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s+\[([A-Z]\d+)\/([^\]]+)\]\s*(.*)$/s,
    );

    let rendererTag = "R0";
    let moduleStr: string;
    let stripped: string;

    if (logMatch) {
      rendererTag = logMatch[1];
      moduleStr = logMatch[2];
      stripped = logMatch[3];
    } else {
      stripped = message.replace(
        /^\d{2}:\d{2}:\d{2}\s+(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s+/,
        "",
      );
      moduleStr = sourceId ? `${sourceId}:${lineNumber}` : `line:${lineNumber}`;
    }

    const levelMap: Record<string, "debug" | "info" | "warn" | "error"> = {
      debug: "debug", info: "info", warning: "warn", error: "error",
    };
    const logLevel = levelMap[level] ?? "info";

    const savedTag = (globalThis as any).__ddThreadTag;
    (globalThis as any).__ddThreadTag = rendererTag;

    if (logLevel !== "warn" && logLevel !== "error") {
      log[logLevel](moduleStr, stripped);
      (globalThis as any).__ddThreadTag = savedTag;
      return;
    }

    const isCascade = WEBGPU_CASCADE_RE.test(stripped);
    const key = isCascade
      ? `webgpu-cascade:${normalizeConsoleMessage(stripped).split("\n")[0]}`
      : `msg:${logLevel}:${normalizeConsoleMessage(stripped)}`;
    const now = Date.now();
    const state = consoleThrottle.get(key);

    if (!state) {
      consoleThrottle.set(key, { count: 1, lastLogged: now, suppressed: 0 });
      log[logLevel](moduleStr, stripped);
      (globalThis as any).__ddThreadTag = savedTag;
      return;
    }
    state.count++;
    const elapsed = now - state.lastLogged;
    if (elapsed < CONSOLE_THROTTLE_MS) {
      state.suppressed++;
      (globalThis as any).__ddThreadTag = savedTag;
      return;
    }
    const suppressed = state.suppressed + 1;
    const summary = isCascade
      ? `${stripped.split("\n")[0]} (repeated ${suppressed}× in ${elapsed}ms, full cascade suppressed)`
      : `${stripped} (repeated ${suppressed}× in ${elapsed}ms)`;
    log[logLevel](moduleStr, summary);
    state.lastLogged = now;
    state.suppressed = 0;
    (globalThis as any).__ddThreadTag = savedTag;
  });
}

// --- Placement resolution ---

function resolvePlacement(
  placement: WindowPlacement | undefined,
  screen: typeof Screen,
  savedState: WindowState | null,
  winWidth: number,
  winHeight: number,
): { x: number; y: number; display: Electron.Display } {
  const cursorPoint = screen.getCursorScreenPoint();
  const cursorDisplay = screen.getDisplayNearestPoint(cursorPoint);

  if (placement && typeof placement === "object") {
    const display = screen.getDisplayNearestPoint({ x: placement.x, y: placement.y });
    return { x: placement.x, y: placement.y, display };
  }

  switch (placement) {
    case "remember": {
      if (savedState) {
        const allDisplays = screen.getAllDisplays();
        const display = allDisplays.find((d) => d.id === savedState.displayId) ??
          screen.getDisplayNearestPoint({ x: savedState.x, y: savedState.y });
        return { x: savedState.x, y: savedState.y, display };
      }
      // Fall through to cursor if no saved state
      return {
        x: Math.round(cursorDisplay.workArea.x + (cursorDisplay.workArea.width - winWidth) / 2),
        y: Math.round(cursorDisplay.workArea.y + (cursorDisplay.workArea.height - winHeight) / 2),
        display: cursorDisplay,
      };
    }
    case "cursor": {
      return {
        x: Math.round(cursorDisplay.workArea.x + (cursorDisplay.workArea.width - winWidth) / 2),
        y: Math.round(cursorDisplay.workArea.y + (cursorDisplay.workArea.height - winHeight) / 2),
        display: cursorDisplay,
      };
    }
    case "center":
    default: {
      const primary = screen.getPrimaryDisplay();
      return {
        x: Math.round(primary.workArea.x + (primary.workArea.width - winWidth) / 2),
        y: Math.round(primary.workArea.y + (primary.workArea.height - winHeight) / 2),
        display: primary,
      };
    }
  }
}

export interface CreateWindowOptions {
  config: DowndraftWindowConfig;
  isDev: boolean;
  app: typeof App;
  BrowserWindow: typeof BrowserWindow;
  screen: typeof Screen;
  session: typeof Session;
  consoleForwarding: boolean;
  windowStatePersistence: boolean;
  preloadPath: string;
}

export async function createWindow(opts: CreateWindowOptions): Promise<BrowserWindow> {
  const { config, isDev, app, BrowserWindow, screen, session, consoleForwarding, windowStatePersistence, preloadPath } = opts;

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

  const savedState = windowStatePersistence ? loadWindowState(app, config.stateFile) : null;
  const winWidth = Math.min(config.width ?? 1280, 99999);
  const winHeight = Math.min(config.height ?? 720, 99999);

  const placement = config.placement ?? "remember";
  const { x: winX, y: winY, display } = resolvePlacement(
    placement,
    screen,
    savedState,
    winWidth,
    winHeight,
  );

  // Clamp to display work area
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;
  const clampedX = Math.max(dx, Math.min(winX, dx + dw - winWidth));
  const clampedY = Math.max(dy, Math.min(winY, dy + dh - winHeight));

  const win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: clampedX,
    y: clampedY,
    minWidth: config.minWidth ?? 1280,
    minHeight: config.minHeight ?? 720,
    show: false,
    title: config.title,
    backgroundColor: config.backgroundColor ?? "#000000",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webgpu: true,
      enableBlinkFeatures: "SharedArrayBuffer",
      sharedTexture: true,
      ...config.webPreferences,
    } as any,
  });

  win.once("ready-to-show", () => {
    win.show();
    if (savedState?.isMaximized) {
      win.maximize();
    }
    if (isDev) {
      win.webContents.openDevTools();
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

  if (consoleForwarding) {
    attachConsoleForwarding(win);
  }

  win.webContents.on("render-process-gone", (_event, details) => {
    log.error("main", `render-process-gone: ${details.reason} (exitCode=${details.exitCode})`);
    showErrorDialog("Renderer Process Gone", `Reason: ${details.reason}\nExit code: ${details.exitCode}`);
  });

  if (windowStatePersistence) {
    win.on("close", () => {
      if (!win.isDestroyed()) {
        saveWindowState(app, win, screen, config.stateFile);
      }
    });
  }

  // Send display refresh rate to renderer
  let lastDisplayId = display.id;
  const sendDisplayInfo = () => {
    if (win.isDestroyed()) return;
    const winBounds = win.getBounds();
    const currentDisplay = screen.getDisplayNearestPoint({ x: winBounds.x, y: winBounds.y });
    if (currentDisplay.id !== lastDisplayId) {
      lastDisplayId = currentDisplay.id;
    }
    win.webContents.send("display-info", { refreshRate: currentDisplay.displayFrequency });
  };

  win.webContents.once("did-finish-load", () => {
    sendDisplayInfo();
  });

  // Forward display scale factor (DPR) changes to the renderer
  screen.on("display-metrics-changed", (_event, metricsDisplay, changedMetrics) => {
    if (win.isDestroyed()) return;
    if (changedMetrics.includes("scaleFactor")) {
      const winBounds = win.getBounds();
      const currentDisplay = screen.getDisplayNearestPoint({ x: winBounds.x, y: winBounds.y });
      if (currentDisplay.id === metricsDisplay.id) {
        win.webContents.send("display-metrics-changed", { scaleFactor: metricsDisplay.scaleFactor });
      }
    }
  });

  let moveTimer: NodeJS.Timeout | null = null;
  win.on("move", () => {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      sendDisplayInfo();
      moveTimer = null;
    }, 200);
  });

  if (isDev) {
    const devServerUrl = process.env.ELECTRON_RENDERER_URL;
    if (devServerUrl) {
      await win.loadURL(devServerUrl);
    } else {
      await win.loadFile(join(__dirname, "../renderer/index.html"));
    }
  } else {
    await win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return win;
}
