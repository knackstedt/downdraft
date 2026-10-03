// Interactive probe: launch game, inject input via dispatch_click, screenshot.
// Sequence for falling-sand: field mode, swatch pick, settings open.
import { launchGame } from "@downdraft/engine/mcp/client";

const game = process.argv[2] ?? "falling-sand";
const base = process.argv[3] ?? "/var/tmp/probe";

const g = await launchGame({ game, gpu: "swiftshader", mirrorOutput: false });
const c = g.client as any;

await new Promise((r) => setTimeout(r, 3000));

const call = async (name: string, args: Record<string, unknown>) => {
    try {
        const r = await c.call(name, args);
        const t = r?.content?.[0]?.text ?? JSON.stringify(r);
        console.log(name, "→", t.replace(/\s+/g, " ").slice(0, 160));
        return r;
    } catch (e) { console.log(name, "FAILED:", String(e).slice(0, 200)); return null; }
};
const shot = async (name: string) => {
    await g.client.screenshot(`${base}-${name}.png`);
    console.log("shot:", name);
};

// 1. Click "Field" mode button (HUD row at ~(190,68)).
await call("dispatch_click", { type: "click", x: 190, y: 68 });
await new Promise((r) => setTimeout(r, 800));
await shot("field-mode");

// 2. Back to material mode, click a swatch (Fire = index 5).
await call("dispatch_click", { type: "click", x: 57, y: 68 });
await new Promise((r) => setTimeout(r, 400));
await call("dispatch_click", { type: "click", x: 484, y: 23 });
await new Promise((r) => setTimeout(r, 600));
await call("get_ui_state", {});
await shot("swatch-picked");

// 3. Open settings.
await call("dispatch_click", { type: "click", x: 55, y: 187 });
await new Promise((r) => setTimeout(r, 800));
await shot("settings");

// 4. Open saves.
await call("dispatch_click", { type: "click", x: 55, y: 187 }); // close settings
await call("dispatch_click", { type: "click", x: 98, y: 156 }); // Load
await new Promise((r) => setTimeout(r, 800));
await shot("saves");

const errs = g.getConsoleErrors();
if (errs.length) console.log("console errors:", errs.slice(0, 15));
await g.kill();
