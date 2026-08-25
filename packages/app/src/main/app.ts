// ============================================================================
// createDowndraftApp() — main process orchestrator
// ============================================================================

import { createLogger } from "@downdraft/core/util/logger";
import { app, BrowserWindow, ipcMain, Menu, screen, session, shell } from "electron";
import { join } from "path";
import { IPC } from "../shared/messages";
import { installErrorHandlers } from "./error-dialog";
import { registerDevtoolsHandlers, resolveDevtoolsConfig } from "./handlers/devtools";
import { registerGpuInfoHandlers } from "./handlers/gpu-info";
import { closeImportCache, registerImportCacheHandlers } from "./handlers/import-cache";
import { startMcpProxy } from "./handlers/mcp";
import { registerOsrHandlers } from "./handlers/osr";
import { registerSaveHandlers } from "./handlers/saves";
import { cleanupStaleStorage, resolveUserDataDir } from "./storage";
import { applySwitches, webGpuSwitches } from "./switches";
import type { DowndraftAppConfig, DowndraftFeatures, MainContext } from "./types";
import { createWindow } from "./window";

const log = createLogger("info");

/**
 * Boot the Downdraft host in the Electron main process.
 *
 * Call this from your game's `src/main.ts`:
 *
 * ```ts
 * import { createDowndraftApp, webGpuSwitches } from "@downdraft/app/main";
 * createDowndraftApp({ window: { title: "My Game" }, switches: webGpuSwitches(), features: { ... } });
 * ```
 */
export function createDowndraftApp(config: DowndraftAppConfig): void {
  (globalThis as any).__ddThreadTag = "M0";
  const isDev = !app.isPackaged;
  const deterministic = process.env.DOWNDRAFT_DETERMINISTIC === "1";

  // --- Default features ---
  // Games can override any of these by passing config.features.
  // The defaults encode the common config shared by all 7 games:
  //   - devtools, gpuInfo, consoleForwarding: always on
  //   - errorDialog, windowStatePersistence: off in deterministic mode
  //   - mcp: default port from MCP_PORT env (9876 in dev)
  //   - saves: default engine version 0.1.0
  //   - osr: off (only to-the-ocean overrides this)
  const features: DowndraftFeatures = {
    devtools: true,
    gpuInfo: true,
    consoleForwarding: true,
    errorDialog: !deterministic,
    windowStatePersistence: !deterministic,
    mcp: { port: parseInt(process.env.MCP_PORT ?? "9876", 10) },
    saves: { engineVersion: "0.1.0" },
    osr: false,
    ...config.features,
  };
  const devtools = resolveDevtoolsConfig(features.devtools);

  // --- Default switches ---
  // webGpuSwitches() is the standard Chromium flag set for WebGPU + gaming.
  const switches = config.switches ?? webGpuSwitches();

  // --- Default webPreferences ---
  // Merge game-specific webPreferences over the engine defaults.
  const windowConfig = {
    ...config.window,
    webPreferences: {
      webgpu: true,
      sharedTexture: true,
      ...config.window.webPreferences,
    },
  };

  // --- Per-game userData directory ---
  // Must be set before anything touches app.getPath("userData") and before
  // app.whenReady(). Each game gets its own isolated Chromium storage (OPFS,
  // IndexedDB, Service Worker DB, cookies, cache) so concurrent game instances
  // don't corrupt each other's LevelDB locks.
  if (config.appId) {
    app.setPath("userData", resolveUserDataDir(app, config.appId));
  }

  // --- Apply chrome switches before app.whenReady ---
  if (switches) {
    applySwitches(app, switches);
  }
  if (devtools.enabled && devtools.debugPort != null) {
    app.commandLine.appendSwitch("remote-debugging-port", String(devtools.debugPort));
  }

  // --- Error dialog + process handlers ---
  if (features.errorDialog !== false) {
    installErrorHandlers(app, BrowserWindow);
  }

  // --- Preload path: emitted to dist/preload/index.cjs by the vite factory ---
  const preloadPath = join(__dirname, "../preload/index.cjs");

  let mainWindow: BrowserWindow | null = null;
  let osrManager: ReturnType<typeof registerOsrHandlers> | null = null;

  // --- Single-instance lock + stale storage cleanup ---
  // Prevents two instances of the same game from corrupting each other's
  // storage. After acquiring the lock, clean up stale LOCK files and Chromium
  // temp artifacts from a previous run that didn't shut down cleanly.
  if (config.appId) {
    const gotLock = app.requestSingleInstanceLock();
    if (!gotLock) {
      log.info("main", `Another instance of "${config.appId}" is already running — quitting.`);
      app.quit();
      return;
    }
    app.on("second-instance", () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
    cleanupStaleStorage(app.getPath("userData"));
  }

  const ctx: MainContext = {
    app,
    BrowserWindow,
    ipcMain,
    session,
    screen,
    shell,
    window: null,
    isDev,
    sendToRenderer: (channel: string, ...args: unknown[]) => {
      mainWindow?.webContents.send(channel, ...args);
    },
  };

  async function init(): Promise<void> {
    Menu.setApplicationMenu(null);

    // --- Create the main window ---
    mainWindow = await createWindow({
      config: windowConfig,
      isDev,
      app,
      BrowserWindow,
      screen,
      session,
      consoleForwarding: features.consoleForwarding !== false,
      windowStatePersistence: features.windowStatePersistence !== false,
      devtools,
      preloadPath,
    });
    ctx.window = mainWindow;

    // --- Register IPC handlers based on features ---
    if (features.saves) {
      registerSaveHandlers(features.saves);
    }

    if (devtools.enabled) {
      registerDevtoolsHandlers(ctx, devtools);
    }

    if (features.gpuInfo !== false) {
      registerGpuInfoHandlers();
    }

    if (features.osr) {
      osrManager = registerOsrHandlers(ctx);
      ctx.osr = osrManager;
    }

    if (features.importCache !== false) {
      registerImportCacheHandlers();
    }

    // --- Deliberate escape hatch: raw Electron access ---
    if (config.extend) {
      config.extend(ctx);
    }

    // --- Lifecycle: onReady ---
    if (config.lifecycle?.onReady) {
      await config.lifecycle.onReady(ctx);
    } else {
      // Default: send sim-ready to renderer
      mainWindow?.webContents.send(IPC.SIM_READY, { isDev, deterministic: process.env.DOWNDRAFT_DETERMINISTIC === "1" });
    }

    // --- MCP proxy ---
    if (features.mcp) {
      await startMcpProxy(ctx, features.mcp);
    }
  }

  app.whenReady().then(init).catch((err) => {
    log.error("main", `Failed to initialize: ${err}`);
  });

  // GPU process crash handler
  app.on("child-process-gone", (_event: any, details: any) => {
    if (details?.type === "GPU") {
      console.error(`[GPU] Process gone: reason=${details.reason}, exitCode=${details.exitCode}`);
    }
  });

  app.on("window-all-closed", () => {
    if (config.lifecycle?.onWindowAllClosed) {
      config.lifecycle.onWindowAllClosed(ctx);
    } else {
      app.quit();
    }
  });

  app.on("before-quit", async () => {
    if (config.lifecycle?.onBeforeQuit) {
      await config.lifecycle.onBeforeQuit(ctx);
    }
    osrManager?.destroy();
    osrManager = null;
    closeImportCache();
  });

  app.on("activate", async () => {
    if (config.lifecycle?.onActivate) {
      await config.lifecycle.onActivate(ctx);
    } else if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = await createWindow({
        config: windowConfig,
        isDev,
        app,
        BrowserWindow,
        screen,
        session,
        consoleForwarding: features.consoleForwarding !== false,
        windowStatePersistence: features.windowStatePersistence !== false,
        devtools,
        preloadPath,
      });
      ctx.window = mainWindow;
    }
  });
}
