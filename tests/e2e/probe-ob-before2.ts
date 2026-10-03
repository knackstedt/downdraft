// Overburden BEFORE shots, attempt 2 — pixi_dispatch_pointer for UI clicks.
import { launchGame } from "@downdraft/engine/mcp/client";

const g = await launchGame({ game: "overburden", gpu: "swiftshader", mirrorOutput: false });
const c = g.client as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = async (name: string, args: Record<string, unknown> = {}) => {
    try { const r = await c.call(name, args); return r?.content?.[0]?.text; } catch (e) { console.log(name, "FAILED:", String(e).slice(0, 200)); }
};
const shot = async (n: string) => { await g.client.screenshot(`/var/tmp/ob-${n}.png`); console.log("shot:", n); };

await sleep(9000);
console.log("scene:", JSON.stringify(await call("pixi_get_scene_state", {})).slice(0, 400));
console.log("ui:", JSON.stringify(await call("get_ui_state", {})).slice(0, 400));

// Try pixi_set_interactive then pixi_dispatch_pointer on Start Game
console.log("interactive:", await call("pixi_set_interactive", { interactive: true }));
await call("pixi_dispatch_pointer", { type: "pointerdown", x: 548, y: 370, button: 0 });
await call("pixi_dispatch_pointer", { type: "pointerup", x: 548, y: 370, button: 0 });
await sleep(2500);
await shot("hud");
console.log("ui2:", JSON.stringify(await call("get_ui_state", {})).slice(0, 400));

await g.kill();
console.log("done");
