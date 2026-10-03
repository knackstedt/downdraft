// Mining-rpg BEFORE shots — pixi-ui build.
import { launchGame } from "@downdraft/engine/mcp/client";

const g = await launchGame({ game: "mining-rpg", gpu: "swiftshader", mirrorOutput: false });
const c = g.client as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = async (name: string, args: Record<string, unknown> = {}) => {
    try { const r = await c.call(name, args); return r?.content?.[0]?.text; } catch (e) { console.log(name, "FAILED:", String(e).slice(0, 200)); }
};
const shot = async (n: string) => { await g.client.screenshot(`/var/tmp/mrpg-before-${n}.png`); console.log("shot:", n); };

await sleep(15000); // world gen + autosave restore
await shot("hud");

// EscapeMenu is unreachable via input on the native build (no Esc binding) —
// flip the store flag directly through set_test_state.
await call("set_test_state", { showEscapeMenu: true });
await sleep(800);
await shot("escape");

await call("set_test_state", { showEscapeMenu: false });
await sleep(400);
console.log("done");
process.exit(0);
