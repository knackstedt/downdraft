import { createLogger } from "@downdraft/engine/util/logger";
import { runNativeAppModule } from "@downdraft/platform-native";
import { appModule } from "./app-module";

const log = createLogger();

// Redoubt — backup tool frontend. The window is a thin client for `redoubtd`
// (the Rust daemon that owns scheduling, retention, keys and mounts): closing
// it hides the window (closePolicy "explicit"), backups keep running in the
// daemon. Quit is explicit via the File menu / tray "Quit".
// `draft dev --app redoubt` runs it.

await runNativeAppModule(appModule, {
  title: "Redoubt",
  appId: "downdraft-redoubt",
  closePolicy: "explicit",
}).catch((e) => {
  log.error("boot", `fatal: ${e}`);
  process.exit(1);
});
