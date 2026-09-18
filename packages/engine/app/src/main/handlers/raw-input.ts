// ============================================================================
// Raw Input host — IPC handlers for native raw mouse capture
// ============================================================================

import { RawInputHost } from "@downdraft/module-raw-input/main-entry";
import { ipcMain } from "electron";
import { IPC } from "../../shared/messages";
import type { MainContext } from "../types";

export function registerRawInputHandlers(ctx: MainContext): RawInputHost {
  const host = new RawInputHost();
  host.setTargetWebContents(ctx.window!.webContents);

  // Renderer → Main: start raw mouse capture
  ipcMain.handle(IPC.RAW_INPUT_START, async () => {
    const win = ctx.window;
    if (!win || win.isDestroyed()) {
      return { platform: "unsupported" as const, capturing: false, detail: "No window" };
    }
    // getNativeWindowHandle() returns a Buffer with the platform-specific
    // window handle (HWND on Windows, X11 Window ID on Linux, NSView on macOS).
    const windowHandle = win.getNativeWindowHandle();
    return host.start({ windowHandle });
  });

  // Renderer → Main: stop raw mouse capture
  ipcMain.handle(IPC.RAW_INPUT_STOP, async () => {
    host.stop();
  });

  // Renderer → Main: set cursor visibility
  ipcMain.handle(IPC.RAW_INPUT_CURSOR_VISIBLE, async (_event, visible: boolean) => {
    host.setCursorVisible(visible);
  });

  // Main → Renderer: raw-input:delta is sent directly via webContents.send
  // from the host's flush timer. The preload bridge wires it to
  // downdraft.rawInput.onDelta().

  // Clean up on window close.
  ctx.window?.once("closed", () => {
    host.destroy();
  });

  return host;
}
