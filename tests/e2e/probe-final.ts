// Post-fix probe: material mode → field mode → back → settings open/close → saves
process.env.DD_UI_TRACE_FRAMES = "0";
import { launchGame } from "@downdraft/engine/mcp/client";

const g = await launchGame({ game: "falling-sand", gpu: "swiftshader", mirrorOutput: true });
const c = g.client as any;
await new Promise((r) => setTimeout(r, 6000));

const call = async (name: string, args: Record<string, unknown>) => {
    try { const r = await c.call(name, args); return r?.content?.[0]?.text; } catch (e) { console.log(name, "FAILED:", String(e).slice(0, 150)); }
};
const shot = async (n: string) => { await g.client.screenshot(`/var/tmp/fin-${n}.png`); console.log("shot:", n); };

await shot("initial");

// Field mode
await call("dispatch_click", { type: "click", x: 155, y: 55 });
await new Promise((r) => setTimeout(r, 700));
await shot("field");

// Back to material
await call("dispatch_click", { type: "click", x: 46, y: 55 });
await new Promise((r) => setTimeout(r, 700));
await shot("material-back");

// Settings open
await call("dispatch_click", { type: "click", x: 44, y: 186 });
await new Promise((r) => setTimeout(r, 900));
await shot("settings-open");

// Settings close (same button)
await call("dispatch_click", { type: "click", x: 44, y: 186 });
await new Promise((r) => setTimeout(r, 700));
await shot("settings-closed");

// Saves open via Load button (~y 148)
await call("dispatch_click", { type: "click", x: 98, y: 148 });
await new Promise((r) => setTimeout(r, 900));
await shot("saves-open");

// close saves
await call("dispatch_click", { type: "click", x: 98, y: 148 });
await new Promise((r) => setTimeout(r, 700));
await shot("saves-closed");

// Swatch pick — toolbar starts at x≈258, swatches 22px + 2px gap, pad 4.
// Swatch index 9 (Iron) row 0 center ≈ 258+4+9*24+11 = 485, y ≈ 8+4+11 = 23.
await call("dispatch_click", { type: "click", x: 485, y: 23 });
await new Promise((r) => setTimeout(r, 700));
await shot("swatch-picked");

await g.kill();
