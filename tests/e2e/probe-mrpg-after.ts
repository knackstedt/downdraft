// Mining-rpg AFTER shots — html-ui build. Esc now toggles the pause menu.
import { launchGame } from "@downdraft/engine/mcp/client";

const g = await launchGame({ game: "mining-rpg", gpu: "swiftshader", mirrorOutput: false });
const c = g.client as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = async (name: string, args: Record<string, unknown> = {}) => {
    try { const r = await c.call(name, args); return r?.content?.[0]?.text; } catch (e) { console.log(name, "FAILED:", String(e).slice(0, 200)); }
};
const shot = async (n: string) => { await g.client.screenshot(`/var/tmp/mrpg-after-${n}.png`); console.log("shot:", n); };
const key = async (k: string, code: string) => { await call("dispatch_key", { key: k, code }); };
const click = async (x: number, y: number) => { await call("dispatch_click", { type: "click", x, y }); };

await sleep(15000);
await shot("hud");
console.log("ui:", await call("get_ui_state", {}));

// Esc → pause menu
await key("Escape", "Escape");
await sleep(800);
await shot("escape");
console.log("esc ui:", await call("get_ui_state", {}));

// Drag the font-scale slider mid-track: panel 280px centered on ~1280 →
// slider track x from ~530 to ~750, y ≈ 345. Click at ~80% → scale ~2.2.
await click(720, 345);
await sleep(700);
await shot("escape-fontscale");

// Click Resume (button centered ~640, y ≈ 390)
await click(640, 390);
await sleep(700);
await shot("resumed");
console.log("after resume:", await call("get_ui_state", {}));

console.log("done");
process.exit(0);
