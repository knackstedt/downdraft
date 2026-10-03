// Archery interaction probe: boot, walk right, click-shoot, screenshot each step.
// bun /var/tmp/probe-archery.ts
import { launchGame } from "@downdraft/engine/mcp/client";

const g = await launchGame({ game: "archery-game", gpu: "swiftshader", mirrorOutput: false });
const c = g.client as any;
const base = "/var/tmp/archery";

const call = async (name: string, args: Record<string, unknown> = {}) => {
    try {
        const r = await c.call(name, args);
        const t = r?.content?.[0]?.text ?? "";
        console.log(name, "→", String(t).replace(/\s+/g, " ").slice(0, 200));
        return r;
    } catch (e) { console.log(name, "FAILED:", String(e).slice(0, 160)); return null; }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shot = async (n: string) => { await g.client.screenshot(`${base}-${n}.png`); console.log("shot:", n); };
const uiState = async () => {
    const r = await call("get_ui_state");
    return r?.content?.[0]?.text ? JSON.parse(r.content[0].text) : null;
};

await sleep(3500);
await uiState();
await shot("0-spawn");

// Walk right for ~4s
await call("dispatch_key", { key: "d", code: "KeyD" });
await sleep(4000);
await shot("1-walk-right");
await uiState();

// Keep walking right off the castle (another 4s)
await sleep(4000);
await call("dispatch_key", { key: "d", code: "KeyD", type: "keyup" });
await shot("2-after-walk");
await uiState();

// Click-to-shoot in the default (slingshot) mode — repro "arrows don't shoot"
await call("dispatch_click", { type: "mousedown", x: 700, y: 200 });
await sleep(120);
await call("dispatch_click", { type: "mouseup", x: 700, y: 200 });
await sleep(300);
await shot("3-plain-click");
await uiState();

// Slingshot drag: press, drag down-left, release
await call("dispatch_click", { type: "mousedown", x: 560, y: 300 });
await sleep(150);
await call("dispatch_click", { type: "mousemove", x: 480, y: 380 });
await sleep(150);
await shot("4-drag");
await call("dispatch_click", { type: "mouseup", x: 480, y: 380 });
await sleep(250);
await shot("5-after-release");
await uiState();

// Click mode (Z) then click far right
await call("dispatch_key", { key: "z", code: "KeyZ" });
await sleep(100);
await call("dispatch_key", { key: "z", code: "KeyZ", type: "keyup" });
await call("dispatch_click", { type: "click", x: 800, y: 250 });
await sleep(250);
await shot("6-clickmode-shot");
await uiState();

const errs = g.getConsoleErrors();
if (errs.length) console.log("console errors:", errs.slice(0, 15));
await g.kill();
