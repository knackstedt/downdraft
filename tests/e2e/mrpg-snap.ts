import { GameClient } from "@downdraft/engine/mcp/client";
const c = await GameClient.connect({ pid: 2388432 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = async (n: string, a: Record<string, unknown> = {}) => {
  const r: any = await c.call(n, a); return r?.content?.[0]?.text;
};
// menu open — drag slider back to min: press at left edge of track
await call("dispatch_click", { type: "mousedown", x: 445, y: 361 });
await sleep(250);
await call("dispatch_click", { type: "mouseup", x: 445, y: 361 });
await sleep(500);
await c.screenshot("/var/tmp/mrpg-final-esc2.png");
console.log("state:", await call("get_ui_state", {}));
process.exit(0);
