// Slingshot drag test — hold a drag, screenshot the preview, release,
// screenshot the arrow in flight.
import { launchGame } from "@downdraft/engine/mcp/client";

const g = await launchGame({ game: "archery-game", gpu: "swiftshader", mirrorOutput: false });
const c = g.client as any;
const base = "/var/tmp/drag";

const call = async (name: string, args: Record<string, unknown> = {}) => {
    try { return await c.call(name, args); }
    catch (e) { console.log(name, "FAILED:", String(e).slice(0, 160)); return null; }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shot = async (n: string) => { await g.client.screenshot(`${base}-${n}.png`); console.log("shot:", n); };

await sleep(4000);

// Switch to Slingshot mode (X)
await call("dispatch_key", { key: "x", code: "KeyX" });
await sleep(50);
await call("dispatch_key", { key: "x", code: "KeyX", type: "keyup" });
await sleep(300);

// Drag: press near player (center-ish), pull DOWN-LEFT → arrow should fly UP-RIGHT.
// Player castle is left; player spawns on the keep ~ (550,300) screen?
// Find player screen pos first via get_ui_state? Just drag relative to center.
await call("dispatch_click", { type: "mousedown", x: 700, y: 400, button: 0 });
await sleep(60);
// drag down-left in steps
for (let i = 1; i <= 8; i++) {
    await call("dispatch_click", { type: "mousemove", x: 700 - i * 12, y: 400 + i * 6, button: 0 });
    await sleep(30);
}
await shot("01-dragging");
await sleep(300);
await shot("02-dragging-held");

// release → arrow fires
await call("dispatch_click", { type: "mouseup", x: 700 - 96, y: 400 + 48, button: 0 });
await sleep(250);
await shot("03-after-release");
await sleep(300);
await shot("04-arrow-mid");

// Also test FREE mode (C): drag at an arbitrary point
await call("dispatch_key", { key: "c", code: "KeyC" });
await sleep(50);
await call("dispatch_key", { key: "c", code: "KeyC", type: "keyup" });
await sleep(200);
await call("dispatch_click", { type: "mousedown", x: 800, y: 300, button: 0 });
await sleep(60);
for (let i = 1; i <= 8; i++) {
    await call("dispatch_click", { type: "mousemove", x: 800 + i * 12, y: 300 + i * 8, button: 0 });
    await sleep(30);
}
await shot("05-free-dragging");
await call("dispatch_click", { type: "mouseup", x: 896, y: 364, button: 0 });
await sleep(300);
await shot("06-free-released");

const errs = g.getConsoleErrors();
if (errs.length) console.log("console errors:", errs.slice(0, 15));
await g.kill();
