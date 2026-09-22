// ============================================================================
// Import Cache IPC Handler — SQLite-backed cache for resolved ImportSettings
// ============================================================================
// The storage layer lives in app/src/shared/import-cache-store.ts so the
// native host bridge can reuse it without Electron.
//

import { app, ipcMain } from "electron";
import { join } from "path";
import { createImportCacheStore, type ImportCacheStore } from "../../shared/import-cache-store";
import { IPC } from "../../shared/messages";

let store: ImportCacheStore | null = null;

function getStore(): ImportCacheStore {
  if (!store) {
    store = createImportCacheStore(join(app.getPath("userData"), "downdraft-import-cache.db"));
  }
  return store;
}

export function registerImportCacheHandlers(): void {
  ipcMain.handle(IPC.IMPORT_CACHE_GET, (_event, modelPath: string) => {
    return getStore().get(modelPath);
  });

  ipcMain.handle(
    IPC.IMPORT_CACHE_SET,
    (_event, modelPath: string, entry: { settings: unknown; sourceMtime: number; sidecarMtime: number; updatedAt: number }) => {
      getStore().set(modelPath, entry);
    },
  );

  ipcMain.handle(IPC.IMPORT_CACHE_INVALIDATE, (_event, modelPath: string) => {
    getStore().invalidate(modelPath);
  });
}

/** Close the database connection. Called on app shutdown. */
export function closeImportCache(): void {
  store?.close();
  store = null;
}
