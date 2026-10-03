// Overburden AFTER shots — html-ui port. dispatch_click routes through the
// real input pipeline; html-ui panels hit-test in CSS px.
import { launchGame } from "@downdraft/engine/mcp/client";

const g = await launchGame({ game: "overburden", gpu: "swiftshader", mirrorOutput: false });
const c = g.client as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = async (name: string, args: Record<string, unknown> = {}) => {
    try { const r = await c.call(name, args); return r?.content?.[0]?.text; } catch (e) { console.log(name, "FAILED:", String(e).slice(0, 200)); }
};
const shot = async (n: string) => { await g.client.screenshot(`/var/tmp/ob-after-${n}.png`); console.log("shot:", n); };
const click = async (x: number, y: number) => { await call("dispatch_click", { type: "click", x, y }); };
const key = async (k: string, code: string) => { await call("dispatch_key", { key: k, code }); };

await sleep(12000); // loading → title
await shot("title");

await click(548, 370); // Start Game
await sleep(3000);
await shot("hud");

await key("Escape", "Escape");
await sleep(800);
await shot("pause");

// Pause panel 260×280 centered; buttons: Resume ~238, Settings ~281
await click(548, 281);
await sleep(900);
await shot("settings");
// close settings ×: panel 400×560 centered → x≈726, y≈48
await click(726, 48);
await sleep(600);
await key("Escape", "Escape"); // resume
await sleep(600);

await key("i", "KeyI");
await sleep(900);
await shot("inventory");

// panel 560×436 centered on 1097×617 → tabs at y≈112, x: inv≈466 craft≈570 creative≈674
await click(570, 112);
await sleep(800);
await shot("crafting");
await click(674, 112);
await sleep(800);
await shot("creative");
await key("Escape", "Escape");
await sleep(500);

await key("q", "KeyQ");
await sleep(800);
await shot("taskqueue");
await key("q", "KeyQ");
await sleep(400);

// Station: place a workbench near the blockhead, then select it.
const roster = JSON.parse(await call("get_all_players", {}) ?? "{}");
const bh = roster.blockheads?.[0];
console.log("bh0:", JSON.stringify(bh).slice(0, 200));
if (bh) {
    const wx = Math.round(bh.x ?? bh.wx ?? 0), wy = Math.round(bh.y ?? bh.wy ?? 0);
    console.log("using pos", wx, wy);
    await call("set_block", { x: wx + 4, y: wy, block: "workbench" });
    await sleep(400);
    await call("select_station", { x: wx + 4, y: wy });
    await sleep(1200);
    await shot("station");
    await call("select_station", { select: false });
    await sleep(400);

    await call("set_block", { x: wx + 6, y: wy, block: "trade_post" });
    await sleep(400);
    await call("select_station", { x: wx + 6, y: wy });
    await sleep(1200);
    await shot("trade");
    await call("select_station", { select: false });
    await sleep(400);
}

// Re-open pause for input-shield sanity + final hud
await key("Escape", "Escape");
await sleep(600);
await shot("pause2");
await key("Escape", "Escape");

await g.kill();
console.log("done");
