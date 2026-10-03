import { launchGame } from "@downdraft/engine/mcp/client";
const g = await launchGame({ game: "archery-game", gpu: "swiftshader", mirrorOutput: false });
const c = g.client as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await sleep(3500);
// Zoom way out
for (let i = 0; i < 6; i++) {
  await c.call("dispatch_click", { type: "wheel", x: 550, y: 300, deltaY: 120 });
  await sleep(120);
}
await sleep(400);
await g.client.screenshot("/var/tmp/ar-wide.png");
await g.kill();
