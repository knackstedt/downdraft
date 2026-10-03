import { launchGame } from "@downdraft/engine/mcp/client";
const g = await launchGame({ game: "sandjongg", gpu: "swiftshader", mirrorOutput: true });
const c = g.client as any;
const call = async (n: string, a: Record<string, unknown>) => { try { return await c.call(n, a); } catch (e) { console.log(n, "FAILED:", String(e).slice(0, 120)); } };
await new Promise((r) => setTimeout(r, 7000));
await call("dispatch_click", { type: "click", x: 208, y: 528 });
await new Promise((r) => setTimeout(r, 2500));
// Pause → Settings
await call("dispatch_click", { type: "click", x: 1071, y: 18 });
await new Promise((r) => setTimeout(r, 600));
await call("dispatch_click", { type: "click", x: 548, y: 284 });
await new Promise((r) => setTimeout(r, 900));
await g.client.screenshot("/var/tmp/sj-after-settings.png");
// Close settings (Close btn ~432)
await call("dispatch_click", { type: "click", x: 548, y: 432 });
await new Promise((r) => setTimeout(r, 600));
await g.client.screenshot("/var/tmp/sj-after-setclosed.png");
// Pause → Help
await call("dispatch_click", { type: "click", x: 1071, y: 18 });
await new Promise((r) => setTimeout(r, 600));
await call("dispatch_click", { type: "click", x: 548, y: 318 });
await new Promise((r) => setTimeout(r, 900));
await g.client.screenshot("/var/tmp/sj-after-help.png");
// Close help (help modal 600x560 → close ~ y=540)
await call("dispatch_click", { type: "click", x: 548, y: 540 });
await new Promise((r) => setTimeout(r, 600));
// Debug panel via toolbar Debug btn
await call("dispatch_click", { type: "click", x: 628, y: 594 });
await new Promise((r) => setTimeout(r, 700));
await g.client.screenshot("/var/tmp/sj-after-debug.png");
await g.kill();
