// ============================================================================
// inspectable.ts (character) tests — characterCustomizationNodes emits
// schema'd nodes that write through the game's apply callback.
//
// Run: bun test packages/engine/libraries/character/src/inspectable.spec.ts
// ============================================================================

import { InspectableRegistry } from "@downdraft/engine/libraries/inspectable";
import { describe, expect, it } from "bun:test";
import type { CharacterCustomization, VariantCatalog, VariantGroup } from "./customization";
import { characterCustomizationNodes, CUSTOMIZATION_NONE } from "./inspectable";

function group(key: string, kind: VariantGroup["kind"], variants: string[]): VariantGroup {
    return { key, label: key, kind, variants: variants.map((v) => ({ key: v, meshIndices: [0] })) };
}

const CATALOG: VariantCatalog = (() => {
    const groups = [
        group("ash_head", "required", ["ash_head.001", "ash_head.002"]),
        group("ash_torso", "required", ["ash_torso.001"]),       // single-variant required: not listed
        group("ash_hair", "optional", ["ash_hair.001", "ash_hair.002"]),
        group("ash_backpack", "defaultOff", ["ash_backpack.001"]),
        group("ash_collider", "internal", ["ash_collider"]),
    ];
    return { groups, byKey: new Map(groups.map((g) => [g.key, g])) };
})();

function makeCust(): { cust: CharacterCustomization; applied: CharacterCustomization[] } {
    const applied: CharacterCustomization[] = [];
    const cust: CharacterCustomization = { variants: {}, textures: {}, tints: {} };
    return { cust, applied };
}

function setup(prefix?: string) {
    const { cust, applied } = makeCust();
    const nodes = characterCustomizationNodes({
        prefix,
        catalog: CATALOG,
        get: () => cust,
        apply: (next) => { applied.push(next); Object.assign(cust, next); },
    });
    return { cust, applied, nodes };
}

describe("characterCustomizationNodes", () => {
    it("emits girth/tints/textures plus one enum node per customizable group", () => {
        const { nodes } = setup();
        const paths = nodes.map((n) => n.path).sort();
        expect(paths).toEqual([
            "player.customization.girth",
            "player.customization.textures",
            "player.customization.tints",
            "player.customization.variants.ash_backpack",
            "player.customization.variants.ash_hair",
            "player.customization.variants.ash_head",
        ]);
    });

    it("honors a custom prefix", () => {
        const { nodes } = setup("avatar");
        expect(nodes.map((n) => n.path)).toContain("avatar.girth");
    });

    it("required groups list only real variants; optional/defaultOff add <none>", () => {
        const reg = new InspectableRegistry();
        reg.registerAll(setup().nodes);
        const info = Object.fromEntries(reg.list().map((n) => [n.path, n.options]));
        expect(info["player.customization.variants.ash_head"]).toEqual(["ash_head.001", "ash_head.002"]);
        expect(info["player.customization.variants.ash_hair"]).toEqual(["ash_hair.001", "ash_hair.002", CUSTOMIZATION_NONE]);
        expect(info["player.customization.variants.ash_backpack"]).toEqual(["ash_backpack.001", CUSTOMIZATION_NONE]);
    });

    it("writes variants through apply() and reads back the effective pick", async () => {
        const { cust, applied, nodes } = setup();
        const reg = new InspectableRegistry();
        reg.registerAll(nodes);

        await reg.set("player.customization.variants.ash_head", "ash_head.002");
        expect(cust.variants["ash_head"]).toBe("ash_head.002");
        expect(applied).toHaveLength(1);

        await reg.set("player.customization.variants.ash_backpack", CUSTOMIZATION_NONE);
        expect(cust.variants["ash_backpack"]).toBeNull();
        expect(reg.get("player.customization.variants.ash_backpack").value).toBe(CUSTOMIZATION_NONE);
    });

    it("unsaved optional picks read as the group default, not <none>", () => {
        const { nodes } = setup();
        const reg = new InspectableRegistry();
        reg.registerAll(nodes);
        expect(reg.get("player.customization.variants.ash_hair").value).toBe("ash_hair.001");
        expect(reg.get("player.customization.variants.ash_backpack").value).toBe(CUSTOMIZATION_NONE);
    });

    it("girth/tints/textures write through apply()", async () => {
        const { cust, nodes } = setup();
        const reg = new InspectableRegistry();
        reg.registerAll(nodes);
        await reg.set("player.customization.girth", 0.5);
        expect(cust.girth).toBe(0.5);
        await reg.set("player.customization.tints", { skin: [1, 0.8, 0.7] });
        expect(cust.tints).toEqual({ skin: [1, 0.8, 0.7] });
        expect(reg.get("player.customization.girth").value).toBe(0.5);
    });

    it("girth enforces its -1..1 range via the registry", async () => {
        const { nodes } = setup();
        const reg = new InspectableRegistry();
        reg.registerAll(nodes);
        await expect(reg.set("player.customization.girth", 3)).rejects.toThrow(/within \[-1/);
    });

    it("works with a lazy catalog accessor", () => {
        const { cust, applied } = makeCust();
        let cat: VariantCatalog | null = null;
        const reg = new InspectableRegistry();
        const off = reg.registerAll(characterCustomizationNodes({
            catalog: () => cat,
            get: () => cust,
            apply: (n) => { applied.push(n); Object.assign(cust, n); },
        }));
        expect(reg.list().map((n) => n.path)).not.toContain("player.customization.variants.ash_hair");
        off();
        cat = CATALOG;
        reg.registerAll(characterCustomizationNodes({
            catalog: () => cat,
            get: () => cust,
            apply: (n) => { applied.push(n); Object.assign(cust, n); },
        }));
        expect(reg.list().map((n) => n.path)).toContain("player.customization.variants.ash_hair");
    });
});
