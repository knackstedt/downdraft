// Trace frames + screenshot while settings is open.
process.env.DD_UI_TRACE_FRAMES = "1";
import { launchGame } from "@downdraft/engine/mcp/client";

const g = await launchGame({ game: "falling-sand", gpu: "swiftshader", mirrorOutput: true });
const c = g.client as any;
await new Promise((r) => setTimeout(r, 3000));

const call = async (name: string, args: Record<string, unknown>) => {
    try { const r = await c.call(name, args); return r?.content?.[0]?.text; } catch (e) { console.log(name, "FAILED:", String(e).slice(0, 150)); }
};

console.log("===== click Settings (open)");
await call("dispatch_click", { type: "click", x: 55, y: 187 });
await new Promise((r) => setTimeout(r, 1500));
await g.client.screenshot("/var/tmp/fs-dbg-settings.png");
console.log("===== click Material already; click Settings (close)");
await call("dispatch_click", { type: "click", x: 55, y: 187 });
await new Promise((r) => setTimeout(r, 1200));
await g.kill();
