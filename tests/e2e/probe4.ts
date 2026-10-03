// Debug probe: dump doc attrs + screenshot while toggling modes.
import { launchGame } from "@downdraft/engine/mcp/client";

const g = await launchGame({ game: "falling-sand", gpu: "swiftshader", mirrorOutput: true });
const c = g.client as any;
await new Promise((r) => setTimeout(r, 3500));

const call = async (name: string, args: Record<string, unknown>) => {
    try { const r = await c.call(name, args); return r?.content?.[0]?.text; } catch (e) { console.log(name, "FAILED:", String(e).slice(0, 150)); }
};

console.log("===== click Field");
await call("dispatch_click", { type: "click", x: 190, y: 68 });
await new Promise((r) => setTimeout(r, 3200));
await g.client.screenshot("/var/tmp/fs-dbg-field.png");
console.log("===== click Material");
await call("dispatch_click", { type: "click", x: 57, y: 68 });
await new Promise((r) => setTimeout(r, 3200));
await g.client.screenshot("/var/tmp/fs-dbg-material.png");
console.log("===== ui_state:", await call("get_ui_state", {}));
await g.kill();
