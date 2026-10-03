import { launchGame } from "@downdraft/engine/mcp/client";
const g = await launchGame({ game: "overburden", gpu: "swiftshader", mirrorOutput: false });
const c = g.client as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = async (name: string, args: Record<string, unknown> = {}) => {
    try { const r = await c.call(name, args); return r?.content?.[0]?.text; } catch (e) { return "ERR:" + String(e).slice(0, 120); }
};
await sleep(11000);
await call("dispatch_click", { x: 548, y: 370 }); // Start Game
await sleep(2500);
// open inventory (panel center ~548,308) — click slots; block behind is ground
await call("dispatch_key", { key: "i", code: "KeyI" });
await sleep(700);
for (let i = 0; i < 6; i++) { await call("dispatch_click", { x: 450 + i * 20, y: 300 }); await sleep(120); }
const w = JSON.parse(await call("get_world_state") ?? "{}");
console.log("world:", JSON.stringify(w).slice(0, 300));
// also hold left mouse on the panel region for a few ticks via inject_input
await call("inject_input", { leftMouse: true, mouseX: 500, mouseY: 300, frames: 45 });
await sleep(1600);
const w2 = JSON.parse(await call("get_world_state") ?? "{}");
console.log("world2:", JSON.stringify(w2).slice(0, 300));
await g.kill();
console.log("done");
