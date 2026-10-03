import { launchGame } from "@downdraft/engine/mcp/client";
const g = await launchGame({ game: "archery-game", gpu: "swiftshader", mirrorOutput: false });
const c = g.client as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const state = async () => JSON.parse((await c.call("get_ui_state")).content[0].text);
const key = async (k: string, code: string) => {
  await c.call("dispatch_key", { key: k, code }); await sleep(50);
  await c.call("dispatch_key", { key: k, code, type: "keyup" });
};

await sleep(3500);
console.log("spawn:", JSON.stringify(await state()));

// --- Aim mode 0: click-to-target (sub-frame click) ---
await key("z", "KeyZ");
await sleep(150);
await c.call("dispatch_click", { type: "click", x: 700, y: 300 });
await sleep(150);
console.log("click-mode arrowCount:", (await state()).arrowCount);

// --- Castle entry: walk right off the roof, then back left to the door (~x=78)
await c.call("dispatch_key", { key: "d", code: "KeyD" });
await sleep(2000);
await c.call("dispatch_key", { key: "d", code: "KeyD", type: "keyup" });
await c.call("dispatch_key", { key: "a", code: "KeyA" });
await sleep(1400);
await c.call("dispatch_key", { key: "a", code: "KeyA", type: "keyup" });
let st = await state();
console.log("near door:", st.playerX.toFixed(1), st.playerY.toFixed(1), "state", st.playerState);
await g.client.screenshot("/var/tmp/ar-fn-door.png");

await key("e", "KeyE");
await sleep(300);
st = await state();
console.log("after E enter:", st.playerX.toFixed(1), st.playerY.toFixed(1), "state", st.playerState);
await g.client.screenshot("/var/tmp/ar-fn-inside.png");

await key("e", "KeyE");
await sleep(300);
st = await state();
console.log("after E exit:", st.playerX.toFixed(1), st.playerY.toFixed(1), "state", st.playerState);
await g.client.screenshot("/var/tmp/ar-fn-exit.png");

const errs = g.getConsoleErrors();
if (errs.length) console.log("errors:", errs.slice(0, 10));
await g.kill();
