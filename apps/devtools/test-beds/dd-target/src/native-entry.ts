// devtools agent first — it wraps fetch/WebSocket/console before the rest of
// the module graph runs, and publishes the CDP inspector + jsc command server.
// (Equivalent to launching via `draft dev --devtools-agent`; kept as a direct
// import so the test bed also covers the manual-injection path.)
import "@downdraft/platform-native/dev/devtools-agent.mjs";
import { runNativeGameModule } from "@downdraft/platform-native";
import { gameModule } from "./game-module";

await runNativeGameModule(gameModule, {
  title: "dd-target",
  appId: "downdraft-dd-target",
  width: 900,
  height: 640,
  focused: false,
}).catch((e) => {
  console.error("[dd-target] Fatal:", e);
  process.exit(1);
});
