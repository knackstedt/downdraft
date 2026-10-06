// ============================================================================
// standard-automation-tools tests — inspectable_list/get/set tool wiring.
//
// Run: bun test packages/engine/app/src/renderer/standard-automation-tools.spec.ts
// ============================================================================

import { describe, expect, it } from "bun:test";
import { InspectableRegistry } from "@downdraft/engine/libraries/inspectable";
import { createStandardAutomationTools } from "./standard-automation-tools";
import type { McpToolRegistration } from "./mcp-harness";

function makeTools(registry?: InspectableRegistry): Map<string, McpToolRegistration> {
    const tools = createStandardAutomationTools({
        surface: () => null,
        ...(registry ? { inspectables: registry } : {}),
    });
    return new Map(tools.map((t) => [t.def.name, t]));
}

function makeRegistry(): InspectableRegistry {
    const reg = new InspectableRegistry();
    let girth = 0;
    let mode = "skinny";
    reg.registerAll([
        { path: "player.customization.girth", type: "number", min: -1, max: 1, get: () => girth, set: (v) => { girth = v as number; } },
        {
            path: "player.customization.mode", type: "enum", enum: () => ["skinny", "bulky"],
            get: () => mode, set: (v) => { mode = v as string; },
        },
        { path: "player.name", type: "string", readOnly: true, get: () => "Tester" },
    ]);
    return reg;
}

describe("inspectable_* tools", () => {
    it("omits the tools when no registry is configured", () => {
        const tools = makeTools();
        expect(tools.has("inspectable_list")).toBe(false);
        expect(tools.has("inspectable_get")).toBe(false);
        expect(tools.has("inspectable_set")).toBe(false);
    });

    it("lists nodes with schema and current values", async () => {
        const tools = makeTools(makeRegistry());
        const res = await tools.get("inspectable_list")!.handler({}) as { content: { text: string }[] };
        const body = JSON.parse(res.content[0].text);
        const girth = body.nodes.find((n: { path: string }) => n.path === "player.customization.girth");
        expect(girth.min).toBe(-1);
        expect(girth.value).toBe(0);
        const mode = body.nodes.find((n: { path: string }) => n.path === "player.customization.mode");
        expect(mode.options).toEqual(["skinny", "bulky"]);
    });

    it("honors the prefix filter and tree flag", async () => {
        const tools = makeTools(makeRegistry());
        const res = await tools.get("inspectable_list")!.handler({ prefix: "player.customization", tree: true }) as { content: { text: string }[] };
        const body = JSON.parse(res.content[0].text);
        expect(body.nodes).toHaveLength(2);
        expect(body.tree[0].path).toBe("player");
    });

    it("gets a single node with its schema", async () => {
        const tools = makeTools(makeRegistry());
        const res = await tools.get("inspectable_get")!.handler({ path: "player.customization.mode" }) as { content: { text: string }[] };
        const body = JSON.parse(res.content[0].text);
        expect(body.value).toBe("skinny");
        expect(body.options).toEqual(["skinny", "bulky"]);
    });

    it("sets a value and echoes the post-write state", async () => {
        const reg = makeRegistry();
        const tools = makeTools(reg);
        const res = await tools.get("inspectable_set")!.handler({ path: "player.customization.girth", value: 0.6 }) as { content: { text: string }[] };
        const body = JSON.parse(res.content[0].text);
        expect(body).toMatchObject({ applied: true, value: 0.6 });
        expect(reg.get("player.customization.girth").value).toBe(0.6);
    });

    it("returns validation errors as tool error results", async () => {
        const tools = makeTools(makeRegistry());
        const bad = await tools.get("inspectable_set")!.handler({ path: "player.customization.mode", value: "chonky" }) as { content: { text: string }[] };
        expect(JSON.parse(bad.content[0].text).error).toContain("skinny, bulky");
        const ro = await tools.get("inspectable_set")!.handler({ path: "player.name", value: "x" }) as { content: { text: string }[] };
        expect(JSON.parse(ro.content[0].text).error).toContain("read-only");
        const missing = await tools.get("inspectable_get")!.handler({ path: "nope" }) as { content: { text: string }[] };
        expect(JSON.parse(missing.content[0].text).error).toContain("Unknown inspectable path");
    });
});
