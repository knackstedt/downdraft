import { runNativeGameModule } from "@downdraft/platform-native";
import { gameModule } from "./game-module";

// Native entry — `draft dev`/`draft release` runtime (winit + wgpu under Bun,
// Node, or Deno). MCP, saves, display info, screenshots via the in-process
// HostAPI bridge.
await runNativeGameModule(gameModule, {
  title: "devtools",
  appId: "downdraft-devtools",
  width: 1600,
  height: 1000,
  focused: true,
}).catch((e) => {
  // oxlint-disable-next-line no-console -- last-resort fatal path
  console.error("[native-entry] Fatal:", e);
  process.exit(1);
});
