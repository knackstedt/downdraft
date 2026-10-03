// Visual/UX probe 2: spawn view, Tab → enemy castle, shop overlay, saves.
import { launchGame } from "@downdraft/engine/mcp/client";

const g = await launchGame({ game: "archery-game", gpu: "swiftshader", mirrorOutput: false });
const c = g.client as any;
const base = "/var/tmp/ar2";

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

await sleep(3500);
await shot("0-spawn");

// Zoom out to see more of the world
await call("dispatch_click", { type: "wheel", x: 550, y: 300, deltaY: 120 });
await call("dispatch_click", { type: "wheel", x: 550, y: 300, deltaY: 120 });
await call("dispatch_click", { type: "wheel", x: 550, y: 300, deltaY: 120 });
await sleep(400);
await shot("1-zoomed-out");

// Tab → snap to enemy castle
await key("Tab", "Tab");
await sleep(600);
await shot("2-enemy-castle");

// F → back to player
await key("f", "KeyF");
await sleep(600);
await shot("3-follow");

// Open the shop overlay (click "Shop" in top bar — roughly x=788)
await call("dispatch_click", { type: "click", x: 788, y: 17 });
await sleep(500);
await shot("4-shop");

// Close shop, open saves
await call("dispatch_click", { type: "click", x: 788, y: 17 });
await sleep(200);
await call("dispatch_click", { type: "click", x: 838, y: 17 });
await sleep(500);
await shot("5-saves");

// Close saves, open settings
await call("dispatch_click", { type: "click", x: 838, y: 17 });
await sleep(200);
await call("dispatch_click", { type: "click", x: 1002, y: 17 });
await sleep(400);
await shot("6-settings");
await call("dispatch_click", { type: "click", x: 1002, y: 17 });
await sleep(200);

// Fire an arrow — click mode then click far right
await key("z", "KeyZ");
await call("dispatch_click", { type: "click", x: 850, y: 260 });
await sleep(200);
await shot("7-arrow-flight");
await sleep(600);
await shot("8-arrow-later");

const errs = g.getConsoleErrors();
if (errs.length) console.log("console errors:", errs.slice(0, 15));
await g.kill();
