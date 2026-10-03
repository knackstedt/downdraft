import { launchGame } from "@downdraft/engine/mcp/client";
const g = await launchGame({ game: "archery-game", gpu: "swiftshader", mirrorOutput: false });
await new Promise((r) => setTimeout(r, 4500));
await g.client.screenshot("/var/tmp/final-scene.png");
const errs = g.getConsoleErrors();
if (errs.length) console.log("console errors:", errs.slice(0, 10));
await g.kill();
