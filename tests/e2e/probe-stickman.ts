// Close-up stickman + castle check.
import { launchGame } from "@downdraft/engine/mcp/client";

const g = await launchGame({ game: "archery-game", gpu: "swiftshader", mirrorOutput: false });
const c = g.client as any;
const base = "/var/tmp/sm";

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

await sleep(4000);

// Zoom WAY in on the player
for (let i = 0; i < 6; i++) {
    await call("dispatch_click", { type: "wheel", x: 550, y: 300, deltaY: -120 });
    await sleep(80);
}
await shot("01-idle-close");

// Walk right — several frames of the cycle
await call("dispatch_key", { key: "d", code: "KeyD" });
await sleep(250); await shot("02-walk1");
await sleep(250); await shot("03-walk2");
await sleep(250); await shot("04-walk3");
await call("dispatch_key", { key: "d", code: "KeyD", type: "keyup" });
await sleep(400);
await shot("05-idle-after");

// Walk left
await call("dispatch_key", { key: "a", code: "KeyA" });
await sleep(300); await shot("06-walk-left");
await call("dispatch_key", { key: "a", code: "KeyA", type: "keyup" });
await sleep(200);

// Zoom out a bit, castle close-up
await call("dispatch_click", { type: "wheel", x: 550, y: 300, deltaY: 120 });
await call("dispatch_click", { type: "wheel", x: 550, y: 300, deltaY: 120 });
await sleep(300);
await shot("07-castle-close");

const errs = g.getConsoleErrors();
if (errs.length) console.log("console errors:", errs.slice(0, 15));
await g.kill();
