// Free-slingshot verification: C mode, drag placed far from the player —
// the arrow must launch FROM THE ARCHER, not the click point.
import { launchGame } from "@downdraft/engine/mcp/client";

const g = await launchGame({ game: "archery-game", gpu: "swiftshader", mirrorOutput: false });
const c = g.client as any;
const base = "/var/tmp/pf";

const call = async (name: string, args: Record<string, unknown> = {}) => {
    try { return await c.call(name, args); }
    catch (e) { console.log(name, "FAILED:", String(e).slice(0, 200)); return null; }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shot = async (n: string) => { await g.client.screenshot(`${base}-${n}.png`); console.log("shot:", n); };
const key = async (k: string, code: string) => {
    await call("dispatch_key", { key: k, code });
    await call("dispatch_key", { key: k, code, type: "keyup" });
};

await sleep(4000);
await shot("01-idle");

// Free slingshot mode
await key("c", "KeyC");
await sleep(200);

// Place the drag circle far from the player (upper-left sky), pull
// down-right — arrow should leave the player's bow flying up-left.
await call("dispatch_click", { type: "mousedown", x: 200, y: 150, button: 0 });
await sleep(60);
for (let i = 1; i <= 8; i++) {
    await call("dispatch_click", { type: "mousemove", x: 200 + i * 9, y: 150 + i * 8, button: 0 });
    await sleep(30);
}
await shot("02-free-drag");
await call("dispatch_click", { type: "mouseup", x: 272, y: 214, button: 0 });
await sleep(150);
await shot("03-free-flight");
await sleep(300);
await shot("04-free-flight2");

const errs = g.getConsoleErrors();
if (errs.length) console.log("console errors:", errs.slice(0, 15));
await g.kill();
