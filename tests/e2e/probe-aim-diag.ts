// Diagonal drag: mousedown at (640,300), drag to (720,380) = down-right.
// Expected: band down-right, trajectory + glyph up-left.
import { launchGame } from "@downdraft/engine/mcp/client";

const g = await launchGame({ game: "archery-game", gpu: "swiftshader", mirrorOutput: false });
const c = g.client as any;
const base = "/var/tmp/vdiag";

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
await sleep(400);

await call("dispatch_click", { type: "mousedown", x: 640, y: 300, button: 0 });
await sleep(80);
for (let i = 1; i <= 8; i++) {
    await call("dispatch_click", { type: "mousemove", x: 640 + i * 10, y: 300 + i * 10, button: 0 });
    await sleep(30);
}
await shot("diag-down-right");
await call("dispatch_click", { type: "mouseup", x: 720, y: 380, button: 0 });
await sleep(150);
await shot("diag-flight1");
await sleep(250);
await shot("diag-flight2");

const errs = g.getConsoleErrors();
if (errs.length) console.log("console errors:", errs.slice(0, 10));
await g.kill();
