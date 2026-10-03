// Visual verification: castle backdrop, terrain shade, moon, slingshot
// preview direction, prim-drawn figures, bottom bar.
import { launchGame } from "@downdraft/engine/mcp/client";

const g = await launchGame({ game: "archery-game", gpu: "swiftshader", mirrorOutput: false });
const c = g.client as any;
const base = "/var/tmp/v2";

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
await shot("01-spawn");

// Zoom in on the player figure (wheel up x3)
for (let i = 0; i < 3; i++) await call("dispatch_wheel", { deltaY: -120 });
await sleep(400);
await shot("02-player-closeup");

// Slingshot mode: drag down-right → arrow should preview/fly up-left
await key("x", "KeyX");
await sleep(200);
await call("dispatch_click", { type: "mousedown", x: 640, y: 320, button: 0 });
await sleep(60);
for (let i = 1; i <= 8; i++) {
    await call("dispatch_click", { type: "mousemove", x: 640 + i * 10, y: 320 + i * 7, button: 0 });
    await sleep(30);
}
await shot("03-drag-preview");
await call("dispatch_click", { type: "mouseup", x: 720, y: 376, button: 0 });
await sleep(200);
await shot("04-arrow-flight");

// Click mode: fire at a point
await key("z", "KeyZ");
await sleep(200);
await call("dispatch_click", { type: "mousedown", x: 750, y: 300, button: 0 });
await call("dispatch_click", { type: "mouseup", x: 750, y: 300, button: 0 });
await sleep(250);
await shot("05-click-shot");

// Tab → enemy castle (units + enemy keep)
await key("Tab", "Tab");
await sleep(600);
await shot("06-enemy-castle");

// ESC menu + bottom bar (zoom back out first)
await key("f", "KeyF");
await sleep(400);
for (let i = 0; i < 3; i++) await call("dispatch_wheel", { deltaY: 120 });
await sleep(300);
await key("Escape", "Escape");
await sleep(400);
await shot("07-menu");

const errs = g.getConsoleErrors();
if (errs.length) console.log("console errors:", errs.slice(0, 15));
await g.kill();
