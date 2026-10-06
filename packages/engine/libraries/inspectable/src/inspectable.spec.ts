// ============================================================================
// inspectable.ts tests — registration, hierarchy derivation, typed reads,
// validated writes, change notification.
//
// Run: bun test packages/engine/libraries/inspectable/src/inspectable.spec.ts
// ============================================================================

import { describe, expect, it } from "bun:test";
import { InspectableError, InspectableRegistry, type InspectableNode } from "./inspectable";

function numNode(path: string, initial = 0, extra: Partial<InspectableNode> = {}): InspectableNode {
    let v = initial;
    return { path, type: "number", get: () => v, set: (n) => { v = n as number; }, ...extra };
}

/** Set expecting rejection — returns the InspectableError, fails otherwise. */
async function setErr(reg: InspectableRegistry, path: string, value: unknown): Promise<InspectableError> {
    try {
        await reg.set(path, value);
    } catch (e) {
        return e as InspectableError;
    }
    throw new Error(`expected set("${path}") to reject`);
}

describe("InspectableRegistry", () => {
    it("registers, reads, and writes a node through its callbacks", async () => {
        const reg = new InspectableRegistry();
        reg.register(numNode("player.health", 50));
        expect(reg.get("player.health").value).toBe(50);
        const res = await reg.set("player.health", 80);
        expect(res.value).toBe(80);
        expect(reg.get("player.health").value).toBe(80);
    });

    it("rejects duplicate paths", () => {
        const reg = new InspectableRegistry();
        reg.register(numNode("a.b"));
        expect(() => reg.register(numNode("a.b"))).toThrow(InspectableError);
    });

    it("register/unregister round-trip", () => {
        const reg = new InspectableRegistry();
        const off = reg.register(numNode("x"));
        expect(reg.has("x")).toBe(true);
        off();
        expect(reg.has("x")).toBe(false);
        reg.registerAll([numNode("y"), numNode("z")]);
        expect(reg.size()).toBe(2);
        expect(reg.unregister("y")).toBe(true);
        expect(reg.unregister("nope")).toBe(false);
    });

    it("list() filters by prefix without matching sibling names", () => {
        const reg = new InspectableRegistry();
        reg.registerAll([numNode("player.hp"), numNode("player.mp"), numNode("players.x"), numNode("world.tick")]);
        expect(reg.list("player").map((n) => n.path)).toEqual(["player.hp", "player.mp"]);
        expect(reg.list("player.hp").map((n) => n.path)).toEqual(["player.hp"]);
        expect(reg.list()).toHaveLength(4);
    });

    it("tree() derives hierarchy from dot paths", () => {
        const reg = new InspectableRegistry();
        reg.registerAll([numNode("a.b.c"), numNode("a.b.d"), numNode("a.e"), numNode("f")]);
        const tree = reg.tree();
        expect(tree).toHaveLength(2);
        const a = tree.find((t) => t.path === "a")!;
        const b = a.children!.find((t) => t.path === "a.b")!;
        expect(b.children!.map((t) => t.path).sort()).toEqual(["a.b.c", "a.b.d"]);
        expect(b.children![0].type).toBe("number");
    });

    it("resolves enum options lazily at describe time", () => {
        const reg = new InspectableRegistry();
        let options = ["a", "b"];
        reg.register({ path: "mode", type: "enum", enum: () => options, get: () => "a", set: () => {} });
        expect(reg.list()[0].options).toEqual(["a", "b"]);
        options = ["x"];
        expect(reg.list()[0].options).toEqual(["x"]);
    });
});

describe("InspectableRegistry.set validation", () => {
    it("rejects unknown paths with nearby suggestions", async () => {
        const reg = new InspectableRegistry();
        reg.register(numNode("player.health"));
        const err = await setErr(reg, "player.heal", 1);
        expect(err).toBeInstanceOf(InspectableError);
        expect(err.reason).toBe("not_found");
        expect(err.message).toContain("player.health");
    });

    it("rejects writes to read-only nodes", async () => {
        const reg = new InspectableRegistry();
        reg.register({ path: "ro", type: "number", readOnly: true, get: () => 1 });
        reg.register({ path: "noset", type: "number", get: () => 1 });
        expect((await setErr(reg, "ro", 2)).reason).toBe("read_only");
        expect((await setErr(reg, "noset", 2)).reason).toBe("read_only");
        expect(reg.list().map((n) => n.readOnly)).toEqual([true, true]);
    });

    it("enforces type, range, and enum membership", async () => {
        const reg = new InspectableRegistry();
        reg.register(numNode("n", 0, { min: -1, max: 1 }));
        reg.register({ path: "b", type: "boolean", get: () => false, set: () => {} });
        reg.register({ path: "s", type: "string", get: () => "", set: () => {} });
        let enumVal = "a";
        reg.register({ path: "e", type: "enum", enum: () => ["a", "b"], get: () => enumVal, set: (v) => { enumVal = v as string; } });
        let jsonVal: unknown = {};
        reg.register({ path: "j", type: "json", get: () => jsonVal, set: (v) => { jsonVal = v; } });

        expect((await setErr(reg, "n", "x")).reason).toBe("bad_type");
        expect((await setErr(reg, "n", 2)).reason).toBe("out_of_range");
        expect((await reg.set("n", -1)).value).toBe(-1);
        expect((await setErr(reg, "b", 1)).reason).toBe("bad_type");
        expect((await setErr(reg, "s", {})).reason).toBe("bad_type");
        const enumErr = await setErr(reg, "e", "z");
        expect(enumErr.reason).toBe("bad_enum");
        expect(enumErr.message).toContain("a, b");
        expect((await reg.set("e", "b")).value).toBe("b");
        expect((await reg.set("j", { nested: [1, "x"] })).value).toEqual({ nested: [1, "x"] });
    });

    it("does not call set() when validation fails", async () => {
        const reg = new InspectableRegistry();
        let calls = 0;
        reg.register({ path: "n", type: "number", min: 0, get: () => 0, set: () => { calls++; } });
        await reg.set("n", -5).catch(() => {});
        expect(calls).toBe(0);
    });

    it("supports async set() and reports the post-write value", async () => {
        const reg = new InspectableRegistry();
        let v = 0;
        reg.register({ path: "n", type: "number", get: () => v, set: async (x) => { await Promise.resolve(); v = x as number; } });
        expect((await reg.set("n", 7)).value).toBe(7);
    });

    it("notifies onChanged listeners after successful writes", async () => {
        const reg = new InspectableRegistry();
        reg.register(numNode("n"));
        const seen: [string, unknown][] = [];
        const off = reg.onChanged((p, v) => seen.push([p, v]));
        await reg.set("n", 3);
        off();
        await reg.set("n", 4);
        expect(seen).toEqual([["n", 3]]);
    });
});
