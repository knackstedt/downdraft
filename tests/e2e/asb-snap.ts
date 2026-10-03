import { GameClient } from "@downdraft/engine/mcp/client";
const c = await GameClient.connect({ pid: 2395212 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = async (n: string, a: Record<string, unknown> = {}) => {
  const r: any = await c.call(n, a); return r?.content?.[0]?.text;
};
// esc menu is open — click Graphics tab (sidebar ~x=76, y=147)
await call("dispatch_click", { type: "click", x: 76, y: 147 });
await sleep(600);
await c.screenshot("/var/tmp/asb-before-esc-graphics.png");
// Content tab
await call("dispatch_click", { type: "click", x: 76, y: 233 });
await sleep(600);
await c.screenshot("/var/tmp/asb-before-esc-content.png");
// Character tab
await call("dispatch_click", { type: "click", x: 76, y: 276 });
await sleep(900);
await c.screenshot("/var/tmp/asb-before-esc-character.png");
// Controls tab
await call("dispatch_click", { type: "click", x: 76, y: 319 });
await sleep(600);
await c.screenshot("/var/tmp/asb-before-esc-controls.png");
// Close esc, open paint palette (P)
await call("dispatch_key", { key: "Escape", code: "Escape" });
await sleep(600);
await call("dispatch_key", { key: "p", code: "KeyP" });
await sleep(700);
await c.screenshot("/var/tmp/asb-before-palette.png");
// Close palette, open browser (B)
await call("dispatch_key", { key: "p", code: "KeyP" });
await sleep(400);
await call("dispatch_key", { key: "b", code: "KeyB" });
await sleep(1800);
await c.screenshot("/var/tmp/asb-before-browser.png");
console.log("done");
process.exit(0);
