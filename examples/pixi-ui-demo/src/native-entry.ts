// ============================================================================
// native-entry.ts — native entry point for pixi-ui-demo (Bun/Node/Deno)
//
// Runs the GameModule (src/game-module.ts). The PixiUI overlay runs
// in-process via NativePixiUiHost (PixiJS v8 WebGPU on the shared
// wgpu-native device) — see native-pixi-host.ts.
//
// Run: draft dev  (native is the default) — or: bun run src/native-entry.ts
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { runNativeGameModule } from "@downdraft/platform-native";
import { pixiUiDemoModule } from "./game-module";
const log = createLogger();


await runNativeGameModule(pixiUiDemoModule, {
  title: "PixiUI Demo — Native",
  appId: "downdraft-pixi-ui-demo",
}).catch((e) => {
  log.error("native-entry", `Fatal: ${e}`);
  process.exit(1);
});
