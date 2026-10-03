// Probe: verify display attr mutations on #fs-fieldtypes / #fs-matname
// after toggling field→material mode.
import { launchGame } from "@downdraft/engine/mcp/client";

const g = await launchGame({ game: "falling-sand", gpu: "swiftshader", mirrorOutput: false });
const c = g.client as any;
await new Promise((r) => setTimeout(r, 3000));

const call = async (name: string, args: Record<string, unknown>) => {
    try {
        const r = await c.call(name, args);
        const t = r?.content?.[0]?.text ?? JSON.stringify(r);
        return t;
    } catch (e) { return "FAILED: " + String(e).slice(0, 200); }
};

console.log("== initial (material mode)");
console.log(await call("inspect_dom", {}));

// switch to field mode
console.log(await call("dispatch_click", { type: "click", x: 190, y: 68 }));
await new Promise((r) => setTimeout(r, 700));
console.log("== after Field click");
console.log(await call("inspect_dom", {}));

// switch back to material
console.log(await call("dispatch_click", { type: "click", x: 57, y: 68 }));
await new Promise((r) => setTimeout(r, 700));
console.log("== after Material click");
console.log(await call("inspect_dom", {}));

const errs = g.getConsoleErrors();
if (errs.length) console.log("console errors:", errs.slice(0, 15));
await g.kill();
