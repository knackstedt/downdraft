// Baseline electron mock for `bun test` — registered via bunfig [test] preload.
//
// The real electron package's index.js only exposes meaningful bindings inside
// an Electron runtime; under bun the named exports don't exist and any spec
// that transitively imports a main-process module dies at import time.
//
// Individual spec files can still call mock.module("electron", ...) to layer
// behavior-specific mocks on top.

import { mock } from "bun:test";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ipcMainEmitter = new EventEmitter();
const ipcMain = {
  handle: (channel: string, cb: (...args: any[]) => any) => ipcMainEmitter.on(`handle:${channel}`, cb),
  handleOnce: (channel: string, cb: (...args: any[]) => any) => ipcMainEmitter.once(`handle:${channel}`, cb),
  removeHandler: (channel: string) => ipcMainEmitter.removeAllListeners(`handle:${channel}`),
  on: (channel: string, cb: (...args: any[]) => void) => ipcMainEmitter.on(channel, cb),
  once: (channel: string, cb: (...args: any[]) => void) => ipcMainEmitter.once(channel, cb),
  removeListener: (channel: string, cb: (...args: any[]) => void) => ipcMainEmitter.removeListener(channel, cb),
  removeAllListeners: (channel?: string) => ipcMainEmitter.removeAllListeners(channel),
};

const ipcRendererEmitter = new EventEmitter();
const ipcRenderer = {
  invoke: async (_channel: string, ..._args: any[]) => undefined,
  send: (_channel: string, ..._args: any[]) => {},
  on: (channel: string, cb: (...args: any[]) => void) => ipcRendererEmitter.on(channel, cb),
  once: (channel: string, cb: (...args: any[]) => void) => ipcRendererEmitter.once(channel, cb),
  removeListener: (channel: string, cb: (...args: any[]) => void) => ipcRendererEmitter.removeListener(channel, cb),
  removeAllListeners: (channel?: string) => ipcRendererEmitter.removeAllListeners(channel),
};

const webContentsStub = () => ({
  send: () => {},
  on: () => {},
  once: () => {},
  isDestroyed: () => false,
  getLastWebPreferences: () => ({}),
});

const app = {
  getPath: (name: string) => join(tmpdir(), `downdraft-test-${name}`),
  getName: () => "downdraft-test",
  getVersion: () => "0.0.0-test",
  isPackaged: false,
  on: () => {},
  once: () => {},
  whenReady: async () => {},
  quit: () => {},
  requestSingleInstanceLock: () => true,
  setAppUserModelId: () => {},
};

const BrowserWindow = class {
  webContents = webContentsStub();
  on() { return this; }
  once() { return this; }
  isDestroyed() { return false; }
  getBounds() { return { x: 0, y: 0, width: 1280, height: 720 }; }
  setBounds() {}
  loadURL() { return Promise.resolve(); }
  loadFile() { return Promise.resolve(); }
  show() {}
  close() {}
  static getAllWindows() { return []; }
};

const screen = {
  getPrimaryDisplay: () => ({ id: 1, scaleFactor: 1, displayFrequency: 60, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
  getDisplayNearestPoint: () => ({ id: 1, scaleFactor: 1, displayFrequency: 60, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
  getAllDisplays: () => [{ id: 1, scaleFactor: 1, displayFrequency: 60, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }],
  on: () => {},
};

const session = {
  defaultSession: {
    webRequest: { onBeforeSendHeaders: () => {}, onHeadersReceived: () => {} },
    setPermissionRequestHandler: () => {},
    clearCache: async () => {},
  },
  fromPartition: () => session.defaultSession,
};

const shell = { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" };
const Menu = { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) };
const clipboard = { readText: () => "", writeText: () => {} };
const contextBridge = { exposeInMainWorld: () => {} };
const contentTracing = {
  startRecording: async () => {},
  stopRecording: async () => "",
  getCategories: async () => [],
  getTraceBufferUsage: async () => ({ value: 0, percentage: 0 }),
  enableHeapProfiling: async () => {},
};

const electronMock = {
  app,
  BrowserWindow,
  clipboard,
  contentTracing,
  contextBridge,
  ipcMain,
  ipcRenderer,
  Menu,
  screen,
  session,
  shell,
};

mock.module("electron", () => electronMock);
