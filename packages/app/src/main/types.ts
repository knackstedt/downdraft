// ============================================================================
// Host SDK — config types for createDowndraftApp()
// ============================================================================

import type { OSRRendererManager } from "@downdraft/module-electron-osr/main-entry";
import type { BrowserWindow, WebPreferences } from "electron";
import type { Switch } from "./switches";

// Electron's WebPreferences type doesn't include webgpu/sharedTexture (added in newer versions).
// Allow extra properties via index signature.
export type ExtendedWebPreferences = Partial<WebPreferences> & Record<string, any>;

export type WindowPlacement = "center" | "remember" | "cursor" | { x: number; y: number };

export interface DowndraftWindowConfig {
  title: string;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  backgroundColor?: string;
  placement?: WindowPlacement;
  stateFile?: string;
  /** Merged with safe engine defaults (contextIsolation, sandbox, preload, etc.) */
  webPreferences?: ExtendedWebPreferences;
}

export interface DowndraftSavesConfig {
  engineVersion: string;
  skipMigrations?: boolean;
  /** Save store mode: "inline" (OPFS in sim worker), "worker" (dedicated save worker), "auto" (pick best). Default: "auto". */
  mode?: "inline" | "worker" | "auto";
  /** Default max generations per slot (OPFS mode). Default: 3. */
  maxGenerations?: number;
}

export interface DowndraftMcpConfig {
  /**
   * MCP HTTP transport port. `0` (or unset) binds to an ephemeral
   * OS-assigned port and advertises it via a PID file at
   * `~/.downdraft/port/<pid>` (content = the actual port number) so the
   * stdio bridge can auto-discover it. Set an explicit port to disable
   * discovery (e.g. for the e2e test harness, which sets `MCP_PORT`).
   */
  port?: number;
}

export interface DevtoolsConfig {
  /** Whether DevTools are enabled at all. `false` fully disables (IPC handlers, extension, keybind, auto-open). Default: `true`. */
  enabled?: boolean;
  /** Keybind that toggles DevTools open/close, matched against `KeyboardEvent.key` (e.g. `"F12"`). Default: `"F12"`. Set to `""` to disable the keybind (the `toggleDevtools` IPC remains available). */
  keybind?: string;
  /** Whether DevTools open automatically on game start. Default: `true`. */
  autoOpen?: boolean;
  /** Remote debugging port (sets Chromium's `--remote-debugging-port` switch before app ready). */
  debugPort?: number;
}

export interface DowndraftFeatures {
  /** File-based save/load IPC handlers. `false` disables. */
  saves?: DowndraftSavesConfig | false;
  /** Offscreen rendering host + input forwarder. */
  osr?: boolean;
  /** MCP HTTP transport in proxy mode. */
  mcp?: DowndraftMcpConfig | false;
  /**
   * DevTools extension loading, toggle IPC + keybind, and auto-open on start.
   * `false` fully disables. `true`/`undefined` uses defaults (see DevtoolsConfig).
   */
  devtools?: DevtoolsConfig | boolean;
  /** nvidia-smi + app.getGPUInfo IPC handlers. */
  gpuInfo?: boolean;
  /** Forward renderer console-message events to the main process logger. */
  consoleForwarding?: boolean;
  /** Modal error dialog on uncaughtException / unhandledRejection. */
  errorDialog?: boolean;
  /** Persist window bounds/maximize state across launches. */
  windowStatePersistence?: boolean;
  /** SQLite-backed import cache for resolved model import settings. Default: true. */
  importCache?: boolean;
  /**
   * Main-process tracing & memory-dump toolkit (contentTracing, V8 heap
   * snapshots, process snapshots). Exposed via MCP tools and the preload
   * IPC bridge. Passive unless triggered. Default: true.
   */
  tracing?: boolean;
}

/**
 * Context handed to lifecycle hooks and the `extend` escape hatch.
 * Carries raw Electron modules for deliberate advanced usage.
 */
export interface MainContext {
  app: typeof import("electron").app;
  BrowserWindow: typeof import("electron").BrowserWindow;
  ipcMain: typeof import("electron").ipcMain;
  session: typeof import("electron").session;
  screen: typeof import("electron").screen;
  shell: typeof import("electron").shell;
  /** The main game window (null before creation / after close). */
  window: BrowserWindow | null;
  isDev: boolean;
  /** Send a message to the main window's webContents. No-op if window is gone. */
  sendToRenderer: (channel: string, ...args: unknown[]) => void;
  /** OSR manager, available when `features.osr` is enabled. */
  osr?: OSRRendererManager;
}

export interface DowndraftLifecycle {
  /** Fired after the window is created and IPC handlers registered, before MCP starts. */
  onReady?: (ctx: MainContext) => void | Promise<void>;
  /** Fired on `before-quit`. Clean up resources here. */
  onBeforeQuit?: (ctx: MainContext) => void | Promise<void>;
  /** Fired on `window-all-closed`. Default behavior quits the app; override to keep alive. */
  onWindowAllClosed?: (ctx: MainContext) => void;
  /** Fired on `activate` (macOS re-open). Default re-creates the window. */
  onActivate?: (ctx: MainContext) => void | Promise<void>;
}

export interface DowndraftAppConfig {
  window: DowndraftWindowConfig;
  /**
   * Per-game application identifier. Used as the userData subdirectory name
   * (e.g. `"downdraft-my-game"` → `~/.config/downdraft-my-game/`).
   *
   * Each game MUST set a unique `appId` so that Chromium storage (OPFS,
   * IndexedDB, Service Worker DB, cookies, cache) is isolated per game.
   * Without this, all games share the same `--user-data-dir` and concurrent
   * instances corrupt each other's LevelDB locks.
   *
   * Also enables a single-instance lock (per `appId`) and stale-lock cleanup
   * on startup, so a crashed/killed previous run won't poison the next launch.
   */
  appId?: string;
  /** Switch preset (e.g. `webGpuSwitches()`) or custom array. Applied before `app.whenReady`. */
  switches?: Switch[];
  features?: DowndraftFeatures;
  lifecycle?: DowndraftLifecycle;
  /**
   * Deliberate escape hatch: raw Electron access for advanced/game-specific needs.
   * Called after window creation + handler registration, before `onReady`.
   */
  extend?: (ctx: MainContext) => void;
}
