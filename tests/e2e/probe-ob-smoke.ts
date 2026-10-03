import { launchGame } from "@downdraft/engine/mcp/client";
const g = await launchGame({ game: "overburden", gpu: "swiftshader", mirrorOutput: false });
const c = g.client as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = async (n: string, a: Record<string, unknown> = {}) => {
    try { return (await c.call(n, a))?.content?.[0]?.text; } catch (e) { return "ERR:" + String(e).slice(0, 120); }
};
await sleep(11000);
await call("dispatch_click", { x: 548, y: 370 });
await sleep(2500);
await g.client.screenshot("/var/tmp/ob-smoke-hud.png");
await call("dispatch_key", { key: "i", code: "KeyI" });
await sleep(800);
await call("dispatch_click", { x: 674, y: 112 }); // creative tab
await sleep(800);
await g.client.screenshot("/var/tmp/ob-smoke-creative.png");
// settings over inventory
await call("dispatch_key", { key: "Escape", code: "Escape" });
await sleep(400);
await call("dispatch_key", { key: "Escape", code: "Escape" }); // pause
await sleep(500);
await call("dispatch_click", { x: 548, y: 281 }); // Settings in pause
await sleep(800);
await g.client.screenshot("/var/tmp/ob-smoke-settings.png");
await g.kill();
console.log("done");
