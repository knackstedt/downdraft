import { launchGame } from "@downdraft/engine/mcp/client";
const g = await launchGame({ game: "overburden", gpu: "swiftshader", mirrorOutput: true });
const c = g.client as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = async (n: string, a: Record<string, unknown> = {}) => {
    try { return (await c.call(n, a))?.content?.[0]?.text; } catch (e) { return "ERR:" + String(e).slice(0, 120); }
};
await sleep(11000);
await call("dispatch_click", { x: 548, y: 370 }); // Start
await sleep(2000);
await call("dispatch_key", { key: "Escape", code: "Escape" });
await sleep(600);
await call("dispatch_click", { x: 548, y: 281 }); // Settings
await sleep(800);
// Resolution Scale row: "50%" seg is rightmost of first row (~x=548,y≈137 in the 586px panel)
// panel 400×586 centered on 1097×617 → top ≈ 15; first seg row y≈137
await call("dispatch_click", { x: 540, y: 137 });
await sleep(1500);
const st = JSON.parse(await call("get_ui_state") ?? "{}");
console.log("gfxRes after:", st.gfxResolutionScale, "paused:", st.paused);
await g.client.screenshot("/var/tmp/ob-resscale50.png");
await sleep(1500);
const st2 = JSON.parse(await call("get_ui_state") ?? "{}");
console.log("fps alive:", st.fps, "->", st2.fps);
await g.kill();
console.log("done");
