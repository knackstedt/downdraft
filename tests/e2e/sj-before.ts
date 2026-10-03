import { launchGame } from "@downdraft/engine/mcp/client";
const g = await launchGame({ game: "sandjongg", gpu: "swiftshader", mirrorOutput: true });
const c = g.client as any;
const call = async (n: string, a: Record<string, unknown>) => { try { return await c.call(n, a); } catch (e) { console.log(n, "FAILED:", String(e).slice(0, 120)); } };
await new Promise((r) => setTimeout(r, 7000));
await g.client.screenshot("/var/tmp/sj-before-menu.png");
// "New Game" on Sandjongg card ≈ (208, 495)
await call("dispatch_click", { type: "click", x: 208, y: 495 });
await new Promise((r) => setTimeout(r, 3000));
await g.client.screenshot("/var/tmp/sj-before-game.png");
// Pause menu — pause button top-right ≈ (1071, 18)
await call("dispatch_click", { type: "click", x: 1071, y: 18 });
await new Promise((r) => setTimeout(r, 700));
await g.client.screenshot("/var/tmp/sj-before-pause.png");
await g.kill();
