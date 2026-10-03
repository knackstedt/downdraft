import { GameClient } from "@downdraft/engine/mcp/client";
const c = await GameClient.connect({ pid: 2349319 });
const call = async (name: string, args: Record<string, unknown> = {}) => {
    try { const r = await (c as any).call(name, args); return r?.content?.[0]?.text; } catch (e) { return "ERR: " + String(e).slice(0, 300); }
};
console.log("== inspect_dom body =="); console.log((await call("inspect_dom", {}))?.slice(0, 2000));
console.log("== bounds .mr-root =="); console.log(await call("get_element_bounds", { selector: ".mr-root" }));
process.exit(0);
