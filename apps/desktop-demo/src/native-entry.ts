import { createLogger } from "@downdraft/engine/util/logger";
import { runNativeAppModule } from "@downdraft/platform-native";
import { appModule } from "./app-module";

const log = createLogger();

// Desktop Demo — reference app for the desktop surface (menus, tray,
// dialogs, settings, close veto, second-instance forwarding).
// `draft dev --app desktop-demo` runs it; `tests/e2e/desktop-demo-smoke.spec.ts`
// drives it end-to-end via MCP.

await runNativeAppModule(appModule, {
  title: "Desktop Demo",
  appId: "downdraft-desktop-demo",
  // lastWindow: an accepted close quits the app — the demo's veto lives in
  // onCloseRequest and is armed/disarmed from the UI or MCP.
  closePolicy: "lastWindow",
  onCloseRequest: () => {
    // Veto while the demo's "Unsaved changes" toggle is armed.
    const armed = (globalThis as any).__demoVetoArmed === true;
    return !armed;
  },
}).catch((e) => {
  log.error("boot", `fatal: ${e}`);
  process.exit(1);
});
