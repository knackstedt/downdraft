import { createDowndraftApp, webGpuSwitches } from "@downdraft/app/main";

const deterministic = process.env.DOWNDRAFT_DETERMINISTIC === "1";

createDowndraftApp({
  window: {
    title: "Alchemist's Lab",
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#0a0a12",
    placement: "remember",
    stateFile: "window-state.json",
    webPreferences: {
      webgpu: true,
      sharedTexture: true,
    },
  },
  switches: webGpuSwitches(),
  features: {
    saves: { engineVersion: "0.1.0" },
    osr: false,
    mcp: { port: parseInt(process.env.MCP_PORT ?? "9876", 10) },
    devtools: { enabled: true, autoOpen: !deterministic, keybind: deterministic ? "" : "F12" },
    gpuInfo: true,
    consoleForwarding: true,
    errorDialog: !deterministic,
    windowStatePersistence: !deterministic,
  },
});
