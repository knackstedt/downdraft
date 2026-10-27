// Manual screenshot helper (not a spec): bun tests/e2e/shot.ts <app> <out.png> [waitMs] [gpu]
import { launchApp } from "@downdraft/engine/mcp/client";

const [app, out, waitMs = "5000", gpu = "swiftshader"] = process.argv.slice(2);
if (!app || !out) {
    console.error("usage: bun tests/e2e/shot.ts <app> <out.png> [waitMs] [gpu]");
    process.exit(1);
}

const g = await launchApp({
    app,
    gpu: gpu as "auto" | "hardware" | "swiftshader",
    mirrorOutput: false,
    ignoreErrorPatterns: [/PIXI.*warning/i, /WebGL.*context.*lost/i, /perf.*extension/i, /dynamic import will not move/i],
});
await new Promise((r) => setTimeout(r, parseInt(waitMs, 10)));
const meta = await g.client.screenshot(out);
console.log("saved", out, meta);
const errs = g.getConsoleErrors();
if (errs.length) console.log("console errors:", errs.slice(0, 15));
await g.kill();
