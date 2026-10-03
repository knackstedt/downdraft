// Polish-3 verification: figure proportions, bow arc, arrow look,
// stage-1 flat terrain, enemy castle integrity under enemy fire.
import { launchGame } from "@downdraft/engine/mcp/client";

const g = await launchGame({ game: "archery-game", gpu: "swiftshader", mirrorOutput: false });
const c = g.client as any;
const base = "/var/tmp/p3";

const call = async (name: string, args: Record<string, unknown> = {}) => {
    try { return await c.call(name, args); }
    catch (e) { console.log(name, "FAILED:", String(e).slice(0, 200)); return null; }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shot = async (n: string) => { await g.client.screenshot(`${base}-${n}.png`); console.log("shot:", n); };
const key = async (k: string, code: string) => {
    await call("dispatch_key", { key: k, code });
    await call("dispatch_key", { key: k, code, type: "keyup" });
};
const ui = async () => {
    const r = await call("get_ui_state", {});
    const t = r?.content?.[0]?.text ?? "";
    try { return JSON.parse(t); } catch { return null; }
};

await sleep(4000);
console.log("t0:", JSON.stringify(await ui()));
await shot("01-spawn");

// Player-slingshot drag — shows the draw pose + bow arc + preview
await key("x", "KeyX");
await sleep(200);
await call("dispatch_click", { type: "mousedown", x: 640, y: 320, button: 0 });
await sleep(60);
for (let i = 1; i <= 8; i++) {
    await call("dispatch_click", { type: "mousemove", x: 640 + i * 10, y: 320 + i * 7, button: 0 });
    await sleep(30);
}
await shot("02-drag-preview");
await call("dispatch_click", { type: "mouseup", x: 720, y: 376, button: 0 });
await sleep(200);
await shot("03-arrow-flight");
await sleep(400);
await shot("04-arrow-late");

// Tab → enemy castle + garrison figures
await key("Tab", "Tab");
await sleep(700);
await shot("05-enemy-castle");

// Watch enemy castle HP while its garrison fires bomb arrows — it must not
// chew through its own keep (castleHpR should stay at its fresh value).
let minR = 999;
for (let i = 0; i < 15; i++) {
    await sleep(4000);
    const s = await ui();
    if (s) {
        minR = Math.min(minR, s.castleHpR);
        if (i % 5 === 0) console.log(`t+${i * 4}s: hpL=${s.castleHpL} hpR=${s.castleHpR} units=${s.unitCount} arrows=${s.arrowCount}`);
    }
}
console.log("enemy castle min hp over ~60s:", minR);
await shot("06-enemy-after-barrage");

const errs = g.getConsoleErrors();
if (errs.length) console.log("console errors:", errs.slice(0, 15));
await g.kill();
