import { createDowndraftApp, webGpuSwitches } from "@downdraft/app/main";

const deterministic = process.env.DOWNDRAFT_DETERMINISTIC === "1";

createDowndraftApp({
  window: {
    title: "Mining RPG",
    width: 1280,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#000000",
    placement: "remember",
    stateFile: "mining-rpg-window-state.json",
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
