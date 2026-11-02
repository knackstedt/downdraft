import { createLogger } from "@downdraft/engine/util/logger";
import { runNativeAppModule } from "@downdraft/platform-native";
import { appModule } from "./app-module";

const log = createLogger();

// Task Board — desktop showcase app for the html-ui-kit widget set: kanban
// board, dashboard, full widget gallery (including a WebGPU surface
// composited inside a Blitz scroll area), settings, 10-foot TV mode, menus,
// tray, dialogs, notifications, settings persistence, and a close veto.
// `draft dev --app taskboard` runs it.

await runNativeAppModule(appModule, {
  title: "Task Board",
  appId: "downdraft-taskboard",
  // lastWindow: an accepted close quits the app — the veto lives in
  // onCloseRequest and is armed from the View menu / Settings page / MCP.
  closePolicy: "lastWindow",
  onCloseRequest: () => {
    const armed = (globalThis as any).__tbVetoArmed === true;
    return !armed;
  },
}).catch((e) => {
  log.error("boot", `fatal: ${e}`);
  process.exit(1);
});
