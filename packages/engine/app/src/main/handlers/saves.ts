// ============================================================================
// Save/load IPC handlers
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { FileSaveStore } from "@downdraft/engine/libraries/persistence";
import { app, ipcMain } from "electron";
import { join } from "path";
import { IPC } from "../../shared/messages";
import type { DowndraftSavesConfig } from "../types";

const log = createLogger("info");

let saveStore: FileSaveStore | null = null;

function getStore(config: DowndraftSavesConfig): FileSaveStore {
  if (!saveStore) {
    const saveDir = join(app.getPath("userData"), "saves");
    saveStore = new FileSaveStore({
      saveDir,
      engineVersion: config.engineVersion,
      skipMigrations: config.skipMigrations ?? true,
    });
    saveStore.onWarning((w: { kind: string; slot: string; message: string }) => {
      log.warn("save", `[${w.kind}] slot='${w.slot}': ${w.message}`);
    });
  }
  return saveStore;
}

export function registerSaveHandlers(config: DowndraftSavesConfig): void {
  ipcMain.handle(IPC.SAVE_GAME_STATE, async (_event, slotName: string, stateJson: string, opts?: any) => {
    try {
      const store = getStore(config);
      const components = JSON.parse(stateJson);
      const result = await store.save(slotName, {
        components,
        meta: {
          engineVersion: config.engineVersion,
          timestamp: Date.now() / 1000,
          entityCount: 0,
          playerCount: 0,
        },
      }, opts);
      log.info("main", `Saved game state to slot '${slotName}' (${result.bytes} bytes)`);
      return result.success;
    } catch (err) {
      log.error("main", `Save failed: ${err}`);
      return false;
    }
  });

  ipcMain.handle(IPC.LOAD_GAME_STATE, async (_event, slotName: string, opts?: any) => {
    try {
      const store = getStore(config);
      const result = await store.load(slotName, opts);
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
      if (!saveStore) return false;
      return saveStore.deleteSave(slotName);
    } catch (err) {
      log.error("main", `Delete save failed: ${err}`);
      return false;
    }
  });

  ipcMain.handle(IPC.LIST_SAVE_SLOTS, async () => {
    try {
      if (!saveStore) return [];
      return saveStore.listSaves();
    } catch (err) {
      log.error("main", `List saves failed: ${err}`);
      return [];
    }
  });

  ipcMain.handle(IPC.LIST_SAVE_GENERATIONS, async (_event, slotName: string) => {
    try {
      if (!saveStore) return [];
      return saveStore.listGenerations(slotName);
    } catch (err) {
      log.error("main", `List generations failed: ${err}`);
      return [];
    }
  });

  ipcMain.handle(IPC.DELETE_SAVE_GENERATION, async (_event, slotName: string, gen: number) => {
    try {
      if (!saveStore) return false;
      return saveStore.deleteGeneration(slotName, gen);
    } catch (err) {
      log.error("main", `Delete generation failed: ${err}`);
      return false;
    }
  });

  ipcMain.handle(IPC.SET_THUMBNAIL, async (_event, slotName: string, data: ArrayBuffer | Uint8Array) => {
    try {
      if (!saveStore) return;
      await saveStore.setThumbnail(slotName, data);
    } catch (err) {
      log.error("main", `Set thumbnail failed: ${err}`);
    }
  });

  ipcMain.handle(IPC.GET_THUMBNAIL, async (_event, slotName: string) => {
    try {
      if (!saveStore) return null;
      return saveStore.getThumbnail(slotName);
    } catch (err) {
      log.error("main", `Get thumbnail failed: ${err}`);
      return null;
    }
  });

  ipcMain.handle(IPC.SET_SAVE_PROPERTIES, async (_event, slotName: string, props: Record<string, unknown>) => {
    try {
      if (!saveStore) return;
      await saveStore.setProperties(slotName, props);
    } catch (err) {
      log.error("main", `Set properties failed: ${err}`);
    }
  });

  ipcMain.handle(IPC.GET_SAVE_PROPERTIES, async (_event, slotName: string) => {
    try {
      if (!saveStore) return {};
      return saveStore.getProperties(slotName);
    } catch (err) {
      log.error("main", `Get properties failed: ${err}`);
      return {};
    }
  });
}
