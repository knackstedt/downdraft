// ============================================================================
// Save/load IPC handlers
// ============================================================================

import { createLogger } from "@downdraft/core/util/logger";
import { FileSaveStore } from "@downdraft/library-persistence";
import { app, ipcMain } from "electron";
import { join } from "path";
import { IPC } from "../../shared/messages";
import type { DowndraftSavesConfig } from "../types";

const log = createLogger("info");

let saveStore: FileSaveStore | null = null;

export function registerSaveHandlers(config: DowndraftSavesConfig): void {
  ipcMain.handle(IPC.SAVE_GAME_STATE, async (_event, slotName: string, stateJson: string) => {
    try {
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
      const components = JSON.parse(stateJson);
      const result = await saveStore.save(slotName, {
        components,
        meta: {
          engineVersion: config.engineVersion,
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
      const result = await saveStore.load(slotName);
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
}
