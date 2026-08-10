// ============================================================================
// Error dialog + process-level crash handlers
// ============================================================================

import { createLogger } from "@downdraft/core/util/logger";
import type { app as AppType, BrowserWindow as BrowserWindowType } from "electron";

const log = createLogger("info");

let errorDialogOpen = false;
let exitOnDialogClose = false;
let appRef: typeof AppType | null = null;
let BrowserWindowRef: (typeof BrowserWindowType) | null = null;

function isEpipeError(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    return (err as { code: string }).code === "EPIPE";
  }
  if (err instanceof Error && err.message.includes("write EPIPE")) return true;
  return false;
}

/**
 * Mark the next (or currently open) error dialog as fatal: when it closes, the
 * app will quit. Used for unrecoverable conditions like the renderer process
 * being gone, where leaving the app running would only show a dead window.
 */
export function setExitOnDialogClose(value: boolean): void {
  exitOnDialogClose = value;
}

export function showErrorDialog(title: string, detail: string): void {
  if (errorDialogOpen || !BrowserWindowRef || !appRef) return;
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

  const win = new BrowserWindowRef({
    width: 720,
    height: 480,
    title,
    backgroundColor: "#111111",
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, devTools: false },
  });

  win.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  win.once("ready-to-show", () => { win.show(); win.focus(); });
  win.on("closed", () => {
    errorDialogOpen = false;
    if (exitOnDialogClose) {
      const forceExitTimer = setTimeout(() => process.exit(1), 3000);
      forceExitTimer.unref();
      appRef?.quit();
    }
  });
}

/**
 * Install process-level uncaughtException / unhandledRejection handlers that
 * surface a modal error dialog. Call once during app init when `features.errorDialog` is enabled.
 */
export function installErrorHandlers(app: typeof AppType, BrowserWindow: typeof BrowserWindowType): void {
  appRef = app;
  BrowserWindowRef = BrowserWindow;

  process.on("uncaughtException", (err) => {
    exitOnDialogClose = true;
    if (isEpipeError(err)) {
      // Parent stdout/stderr pipe closed (common when launched from a test
      // harness or MCP client that tears down the process). Not a real crash.
      return;
    }
    log.error("main", `uncaughtException: ${err.stack ?? err.message}`);
    showErrorDialog("Uncaught Exception", err.stack ?? err.message);
  });

  process.on("unhandledRejection", (reason) => {
    exitOnDialogClose = true;
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    if (isEpipeError(reason)) {
      // Parent stdout/stderr pipe closed — ignore; not a real crash.
      return;
    }
    log.error("main", `unhandledRejection: ${detail}`);
    showErrorDialog("Unhandled Rejection", detail);
  });
}
