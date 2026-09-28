// DORMANT — Electron/browser entry point; the example runs native-only now.
// ============================================================================
// PixiUI Demo — Main Process Entry
// ============================================================================

import { createDowndraftApp, webGpuSwitches } from "@downdraft/engine/app/main";

createDowndraftApp({
  appId: "downdraft-pixi-ui-demo",
  window: {
    title: "PixiUI Demo",
    width: 1280,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#0a0a12",
    placement: "center",
  },
  switches: webGpuSwitches(),
  features: {
    devtools: true,
    gpuInfo: true,
    consoleForwarding: true,
    errorDialog: true,
  },
});
