// Overburden BEFORE shots, panels: pause, inventory, crafting, settings, task queue.
import { launchGame } from "@downdraft/engine/mcp/client";

const g = await launchGame({ game: "overburden", gpu: "swiftshader", mirrorOutput: false });
const c = g.client as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = async (name: string, args: Record<string, unknown> = {}) => {
    try { const r = await c.call(name, args); return r?.content?.[0]?.text; } catch (e) { console.log(name, "FAILED:", String(e).slice(0, 200)); }
};
const shot = async (n: string) => { await g.client.screenshot(`/var/tmp/ob-${n}.png`); console.log("shot:", n); };
const uiClick = async (x: number, y: number) => {
    await call("pixi_dispatch_pointer", { type: "pointerdown", x, y, button: 0 });
    await call("pixi_dispatch_pointer", { type: "pointerup", x, y, button: 0 });
};

await sleep(9000);
await call("pixi_set_interactive", { interactive: true });
await uiClick(548, 370); // Start Game
await sleep(2000);

// Pause menu (Esc key goes through guiKeyHandler on window)
await call("dispatch_key", { key: "Escape", code: "Escape" });
await sleep(700);
await shot("pause");

// Settings from pause menu — "Settings" button is 2nd row (~cy+117)
await uiClick(548, 425);
await sleep(800);
await shot("settings");
// close settings (× top-right of 400-wide panel centered at 1097 → x≈711, y≈~46)
await uiClick(711, 46);
await sleep(500);
// resume
await call("dispatch_key", { key: "Escape", code: "Escape" });
await sleep(500);

// Inventory (I)
await call("dispatch_key", { key: "i", code: "KeyI" });
await sleep(700);
await shot("inventory");

// Crafting tab (C re-toggles to crafting)
await call("dispatch_key", { key: "c", code: "KeyC" });
await sleep(700);
await shot("crafting");

// Creative tab — click "Creative" tab (tabs at y≈ panelY+10+12, x≈ panelX+150+2*104+48)
// panel x0=(1097-560)/2≈268 → Creative tab center x≈268+150+208+48=674, y≈(617-436)/2+22≈112
await uiClick(674, 112);
await sleep(700);
await shot("creative");

// close inventory
await call("dispatch_key", { key: "Escape", code: "Escape" });
await sleep(400);

// Task queue (Q)
await call("dispatch_key", { key: "q", code: "KeyQ" });
await sleep(700);
await shot("taskqueue");
await call("dispatch_key", { key: "q", code: "KeyQ" });

await g.kill();
console.log("done");
