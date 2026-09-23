// ============================================================================
// native-entry.ts — Bun-native entry point for pixi-ui-demo
//
// Runs the SAME GameModule as the Electron renderer (src/main.tsx →
// src/game-module.ts). On native the PixiUI overlay runs in-process via
// NativePixiUiHost (PixiJS v8 WebGPU on the shared wgpu-native device) —
// see native-pixi-host.ts.
//
// Run: draft dev  (native is the default) — or: bun run src/native-entry.ts
// ============================================================================

import { runNativeGameModule } from "@downdraft/platform-native";
import { pixiUiDemoModule } from "./game-module";

await runNativeGameModule(pixiUiDemoModule, {
  title: "PixiUI Demo — Native",
  appId: "downdraft-pixi-ui-demo",
}).catch((e) => {
  console.error("[native-entry] Fatal:", e);
  process.exit(1);
});
