// ============================================================================
// OSR (Offscreen Rendering) host — manager + IPC handlers
// ============================================================================

import type { OSRInputEvent, OSRPanelConfig, OSRRendererConfig } from "@downdraft/module-electron-osr/main-entry";
import { InputForwarder, OSRDedicatedRenderer, OSRRendererManager } from "@downdraft/module-electron-osr/main-entry";
import { ipcMain } from "electron";
import { IPC } from "../../shared/messages";
import type { MainContext } from "../types";

export function registerOsrHandlers(ctx: MainContext): OSRRendererManager {
  const osrManager = new OSRRendererManager();
  osrManager.setTargetWebContents(ctx.window!.webContents);
  osrManager.setEventCallback((event) => {
    ctx.window?.webContents.send(IPC.OSR_RENDERER_EVENT, event);
  });
  osrManager.registerDisplayMetricsListener();
  const osrInputForwarder = new InputForwarder(osrManager);

  ipcMain.handle(IPC.OSR_CREATE_RENDERER, async (_event, config: OSRRendererConfig) => {
    osrManager.createRenderer(config);
  });

  ipcMain.handle(IPC.OSR_DESTROY_RENDERER, async (_event, id: string) => {
    osrManager.destroyRenderer(id);
  });

  ipcMain.handle(IPC.OSR_ADD_PANEL, async (_event, config: OSRPanelConfig) => {
    const renderer = osrManager.getRenderer(config.rendererId);
    if (!renderer) return null;
    const rect = renderer.addPanel(config);
    if (rect) {
      const layout = osrManager.getAtlasLayout(config.rendererId);
      ctx.window?.webContents.send(IPC.OSR_PANEL_LAYOUT, config.rendererId, layout);
    }
    return rect;
  });

  ipcMain.handle(IPC.OSR_REMOVE_PANEL, async (_event, rendererId: string, panelId: string) => {
    const renderer = osrManager.getRenderer(rendererId);
    if (!renderer) return null;
    renderer.removePanel(panelId);
    const layout = osrManager.getAtlasLayout(rendererId);
    ctx.window?.webContents.send(IPC.OSR_PANEL_LAYOUT, rendererId, layout);
    return layout;
  });

  ipcMain.handle(IPC.OSR_UPDATE_PANEL, async (_event, rendererId: string, panelId: string, html: string) => {
    const renderer = osrManager.getRenderer(rendererId);
    if (!renderer) return;
    renderer.updatePanelContent(panelId, html);
  });

  ipcMain.on(IPC.OSR_UPDATE_DATA, (_event, rendererId: string, panelId: string, values: Record<string, string | number | boolean>) => {
    const renderer = osrManager.getRenderer(rendererId);
    if (!renderer) return;
    renderer.applyDataUpdate({ rendererId, panelId, values });
  });

  ipcMain.handle(IPC.OSR_SET_CONTENT, async (_event, rendererId: string, html: string) => {
    const renderer = osrManager.getRenderer(rendererId);
    if (!renderer) return;
    if (renderer instanceof OSRDedicatedRenderer) {
      renderer.setContent(html);
    }
  });

  ipcMain.handle(IPC.OSR_LOAD_URL, async (_event, rendererId: string, url: string) => {
    const renderer = osrManager.getRenderer(rendererId);
    if (!renderer) return;
    if (renderer instanceof OSRDedicatedRenderer) {
      renderer.loadURL(url);
    }
  });

  ipcMain.on(IPC.OSR_INPUT_EVENT, (_event, rendererId: string, eventData: Omit<OSRInputEvent, "rendererId">) => {
    osrInputForwarder.forward({ rendererId, ...eventData });
  });

  ipcMain.on(IPC.OSR_SET_SOFTWARE_CURSOR, (_event, rendererId: string, enabled: boolean) => {
    const renderer = osrManager.getRenderer(rendererId);
    if (renderer) {
      renderer.setSoftwareCursorEnabled(enabled);
    }
  });

  return osrManager;
}
