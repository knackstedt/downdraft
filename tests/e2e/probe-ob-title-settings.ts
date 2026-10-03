import { launchGame } from "@downdraft/engine/mcp/client";
const g = await launchGame({ game: "overburden", gpu: "swiftshader", mirrorOutput: false });
const c = g.client as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = async (n: string, a: Record<string, unknown> = {}) => {
    try { return (await c.call(n, a))?.content?.[0]?.text; } catch (e) { return "ERR:" + String(e).slice(0, 120); }
};
await sleep(11000);
await g.client.screenshot("/var/tmp/ob-title-btns.png");
// Settings button on title: y≈50%+100+18 ≈ 308+118=426, x=548
await call("dispatch_click", { x: 548, y: 426 });
await sleep(900);
await g.client.screenshot("/var/tmp/ob-title-settings.png");
await g.kill();
console.log("done");
