// Overburden BEFORE shots (pixi-ui): loading → title → HUD → pause → inventory
import { launchGame } from "@downdraft/engine/mcp/client";

const g = await launchGame({ game: "overburden", gpu: "swiftshader", mirrorOutput: true });
const c = g.client as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = async (name: string, args: Record<string, unknown> = {}) => {
    try { const r = await c.call(name, args); return r?.content?.[0]?.text; } catch (e) { console.log(name, "FAILED:", String(e).slice(0, 150)); }
};
const shot = async (n: string) => { await g.client.screenshot(`/var/tmp/ob-${n}.png`); console.log("shot:", n); };

await sleep(2500);
await shot("loading");
await sleep(6000);
await shot("title");

// Start Game — centered button ~cy+62 of window.
await call("dispatch_click", { type: "click", x: 548, y: 370 });
await sleep(3000);
await shot("hud");

// Pause menu (Esc)
await call("dispatch_key", { key: "Escape", code: "Escape" });
await sleep(800);
await shot("pause");
await call("dispatch_key", { key: "Escape", code: "Escape" });
await sleep(500);

// Inventory (I key)
await call("dispatch_key", { key: "i", code: "KeyI" });
await sleep(800);
await shot("inventory");

// Crafting tab (C key toggles panel onto crafting)
await call("dispatch_key", { key: "Escape", code: "Escape" });
await sleep(400);
await call("dispatch_key", { key: "c", code: "KeyC" });
await sleep(800);
await shot("crafting");
await call("dispatch_key", { key: "Escape", code: "Escape" });

// Settings via pause menu
await call("dispatch_key", { key: "Escape", code: "Escape" });
await sleep(600);
await call("dispatch_click", { type: "click", x: 548, y: 308 + 117 }); // Settings row in pause menu
await sleep(800);
await shot("settings");

await g.kill();
console.log("done");
