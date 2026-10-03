// Pure-vertical drag test — mouse DOWN only. If the pull renders UP, the
// event y-axis is inverted relative to the canvas.
import { launchGame } from "@downdraft/engine/mcp/client";

const g = await launchGame({ game: "archery-game", gpu: "swiftshader", mirrorOutput: false });
const c = g.client as any;
const base = "/var/tmp/vd";

const call = async (name: string, args: Record<string, unknown> = {}) => {
    try { return await c.call(name, args); }
    catch (e) { console.log(name, "FAILED:", String(e).slice(0, 160)); return null; }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shot = async (n: string) => { await g.client.screenshot(`${base}-${n}.png`); console.log("shot:", n); };
const key = async (k: string, code: string) => {
    await call("dispatch_key", { key: k, code });
    await call("dispatch_key", { key: k, code, type: "keyup" });
};

await sleep(4000);
await key("x", "KeyX");
await sleep(200);

// Drag straight DOWN: (640,300) → (640,420)
await call("dispatch_click", { type: "mousedown", x: 640, y: 300, button: 0 });
await sleep(80);
for (let i = 1; i <= 8; i++) {
    await call("dispatch_click", { type: "mousemove", x: 640, y: 300 + i * 15, button: 0 });
    await sleep(30);
}
await shot("drag-down");

await call("dispatch_click", { type: "mouseup", x: 640, y: 420, button: 0 });
await sleep(400);

// Drag straight UP: (640,420) → (640,300)
await call("dispatch_click", { type: "mousedown", x: 640, y: 420, button: 0 });
await sleep(80);
for (let i = 1; i <= 8; i++) {
    await call("dispatch_click", { type: "mousemove", x: 640, y: 420 - i * 15, button: 0 });
    await sleep(30);
}
await shot("drag-up");

const errs = g.getConsoleErrors();
if (errs.length) console.log("console errors:", errs.slice(0, 10));
await g.kill();
