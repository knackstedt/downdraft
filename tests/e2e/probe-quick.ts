import { launchGame } from "@downdraft/engine/mcp/client";
const g = await launchGame({ game: "archery-game", gpu: "swiftshader", mirrorOutput: false });
const c = g.client as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await sleep(3500);
for (let i = 0; i < 3; i++) {
    const r = await c.call("get_ui_state", {});
    const t = r?.content?.[0]?.text ?? JSON.stringify(r);
    const s = JSON.parse(t);
    console.log(`tick=${s.tick} health=${s.health} px=${s.playerX?.toFixed(0)} py=${s.playerY?.toFixed(0)} gold=${s.gold} units=${s.unitCount}`);
    await sleep(800);
}
await g.client.screenshot("/var/tmp/p3-quick.png");
await g.kill();
