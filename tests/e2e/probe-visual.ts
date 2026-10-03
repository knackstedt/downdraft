// Visual overhaul probe — terrain, castle, stickman, sky, lighting, menu, arrows.
import { launchGame } from "@downdraft/engine/mcp/client";

const g = await launchGame({ game: "archery-game", gpu: "swiftshader", mirrorOutput: false });
const c = g.client as any;
const base = "/var/tmp/vis";

const call = async (name: string, args: Record<string, unknown> = {}) => {
    try { return await c.call(name, args); }
    catch (e) { console.log(name, "FAILED:", String(e).slice(0, 160)); return null; }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shot = async (n: string) => { await g.client.screenshot(`${base}-${n}.png`); console.log("shot:", n); };
const key = async (k: string, code: string) => {
    await call("dispatch_key", { key: k, code });
    await sleep(60);
    await call("dispatch_key", { key: k, code, type: "keyup" });
};
const state = async () => { const r = await call("get_game_state"); return JSON.stringify(r?.content?.[0]?.text ?? r).slice(0, 400); };

await sleep(4000);
await shot("01-spawn");

// state dump
console.log("state:", await state());

// Zoomed-out battlefield view
await call("dispatch_click", { type: "wheel", x: 550, y: 300, deltaY: 120 });
await call("dispatch_click", { type: "wheel", x: 550, y: 300, deltaY: 120 });
await call("dispatch_click", { type: "wheel", x: 550, y: 300, deltaY: 120 });
await sleep(400);
await shot("02-zoomed");

// Back in; walk right, catch mid-walk animation
await call("dispatch_click", { type: "wheel", x: 550, y: 300, deltaY: -120 });
await sleep(300);
await call("dispatch_key", { key: "d", code: "KeyD" });
await sleep(900);
await shot("03-walking");
await call("dispatch_key", { key: "d", code: "KeyD", type: "keyup" });
await sleep(300);
await shot("04-idle");

// Walk left — other facing
await call("dispatch_key", { key: "a", code: "KeyA" });
await sleep(700);
await shot("05-walk-left");
await call("dispatch_key", { key: "a", code: "KeyA", type: "keyup" });
await sleep(200);

// Tab → enemy castle
await key("Tab", "Tab");
await sleep(700);
await shot("06-enemy-castle");

// Zoom in on the enemy castle
await call("dispatch_click", { type: "wheel", x: 550, y: 300, deltaY: -120 });
await sleep(400);
await shot("07-enemy-close");

// F → back to player, then pan camera DOWN to see underground lighting
await key("f", "KeyF");
await sleep(500);
await call("dispatch_click", { type: "click", x: 550, y: 300, button: "right", type: "mousedown" });
await call("dispatch_click", { type: "mousemove", x: 550, y: 60 });
await sleep(150);
await call("dispatch_click", { type: "click", x: 550, y: 60, button: "right", type: "mouseup" });
await sleep(400);
await shot("08-underground");

// ESC → menu + pause
await key("Escape", "Escape");
await sleep(500);
await shot("09-menu");
console.log("paused state:", await state());

// ESC → resume
await key("Escape", "Escape");
await sleep(400);
await shot("10-resumed");

// Fire an arrow — click mode
await key("z", "KeyZ");
await call("dispatch_click", { type: "click", x: 800, y: 220 });
await sleep(160);
await shot("11-arrow-flight");
await sleep(500);
await shot("12-arrow-later");

const errs = g.getConsoleErrors();
if (errs.length) console.log("console errors:", errs.slice(0, 15));
await g.kill();
