// ============================================================================
// customization.ts tests — variant catalogs, group classification, default
// parity with the destructive selectVariantMeshes/filterOptionalMeshes
// pipeline, and selection → mesh-subset resolution.
//
// Run: bun test packages/engine/libraries/character/src/customization.spec.ts
// ============================================================================

import type { MeshData, ModelData, ModelNode } from "@downdraft/engine/libraries/models";
import { describe, expect, it } from "bun:test";
import {
    buildVariantCatalog, computeMeshBounds, customizableGroups, defaultCustomization,
    requiredMeshIndices, resolveCustomizationMeshes, slotLabel, variantLabel, withMaterialOverrides,
    type CharacterCustomization
} from "./customization";
import { filterOptionalMeshes, selectVariantMeshes } from "./loader";

function mesh(verts = 3): MeshData {
    return {
        vertices: new Float32Array(verts * 6).map((_, i) => i),
        indices: new Uint16Array([0, 1, 2]),
        vertexCount: verts,
        indexCount: 3,
        uvs: null,
        colors: null,
    };
}

/** Model whose node list is the given mesh-node names, one mesh per node. */
function modelWithNodes(names: string[]): ModelData {
    const nodes: ModelNode[] = names.map((name, i) => ({ name, mesh: i, meshes: [i] }));
    return { name: "test", format: "fbx", meshes: names.map(() => mesh()), nodes };
}

function cloneModel(m: ModelData): ModelData {
    return { ...m, meshes: m.meshes.slice(), nodes: (m.nodes ?? []).map((n) => ({ ...n })) };
}

const KIT = [
    "ash_head",
    "ash_torso.001", "ash_torso.002", "ash_torso.003",
    "ash_hair.001", "ash_hair.002",
    "ash_backpack.001", "ash_backpack.002",
    "ash_mask.001",
    "ash_collider",
];

describe("buildVariantCatalog", () => {
    it("groups slot.NNN siblings into one variant group each", () => {
        const cat = buildVariantCatalog(modelWithNodes(KIT));
        const torso = cat.byKey.get("ash_torso")!;
        expect(torso.variants.map((v) => v.key)).toEqual(["ash_torso.001", "ash_torso.002", "ash_torso.003"]);
        const hair = cat.byKey.get("ash_hair")!;
        expect(hair.variants.length).toBe(2);
    });

    it("folds _ptN mesh splits into their canonical variant", () => {
        const cat = buildVariantCatalog(modelWithNodes([
            "rb_headwear.004",
            "rb_headwear.005_pt1", "rb_headwear.005_pt2",
            "rb_headwear.006",
        ]));
        const g = cat.byKey.get("rb_headwear")!;
        expect(g.variants.map((v) => v.key)).toEqual(["rb_headwear.004", "rb_headwear.005", "rb_headwear.006"]);
        expect(g.variants[1].meshIndices).toEqual([1, 2]);
    });

    it("collects multi-material node.meshes splits into the variant", () => {
        const model: ModelData = {
            name: "t", format: "fbx",
            meshes: [mesh(), mesh()],
            nodes: [{ name: "f_torso.000", mesh: 0, meshes: [0, 1] }],
        };
        const cat = buildVariantCatalog(model);
        expect(cat.byKey.get("f_torso")!.variants[0].meshIndices).toEqual([0, 1]);
    });

    it("classifies groups: required body, optional, defaultOff accessories, internal collider", () => {
        const cat = buildVariantCatalog(modelWithNodes(KIT));
        expect(cat.byKey.get("ash_head")!.kind).toBe("required");
        expect(cat.byKey.get("ash_torso")!.kind).toBe("required");
        expect(cat.byKey.get("ash_hair")!.kind).toBe("optional");
        expect(cat.byKey.get("ash_backpack")!.kind).toBe("defaultOff");
        expect(cat.byKey.get("ash_mask")!.kind).toBe("defaultOff");
        expect(cat.byKey.get("ash_collider")!.kind).toBe("internal");
    });
});

describe("defaultCustomization parity", () => {
    it("renders exactly the meshes the legacy destructive pipeline keeps", () => {
        const model = modelWithNodes(KIT);
        const cat = buildVariantCatalog(model);
        const cust = defaultCustomization(cat);
        const { meshIndices } = resolveCustomizationMeshes(model, cat, cust);

        const legacy = cloneModel(model);
        filterOptionalMeshes(legacy);
        selectVariantMeshes(legacy);
        // Map surviving MeshData back to original indices by object identity.
        const legacySet = new Set(legacy.meshes.map((m) => model.meshes.indexOf(m)));

        expect(meshIndices).toEqual(legacySet);
    });
});

describe("resolveCustomizationMeshes", () => {
    it("hides a group whose pick is null", () => {
        const model = modelWithNodes(KIT);
        const cat = buildVariantCatalog(model);
        const cust = defaultCustomization(cat);
        cust.variants["ash_hair"] = null;
        const { meshIndices } = resolveCustomizationMeshes(model, cat, cust);
        // ash_hair.001/.002 are mesh indices 4 and 5.
        expect(meshIndices.has(4)).toBe(false);
        expect(meshIndices.has(5)).toBe(false);
        expect(meshIndices.has(1)).toBe(true); // torso.001 still on
    });

    it("selects a non-default variant", () => {
        const model = modelWithNodes(KIT);
        const cat = buildVariantCatalog(model);
        const cust = defaultCustomization(cat);
        cust.variants["ash_torso"] = "ash_torso.003";
        const { meshIndices } = resolveCustomizationMeshes(model, cat, cust);
        expect(meshIndices.has(3)).toBe(true);
        expect(meshIndices.has(1)).toBe(false);
        expect(meshIndices.has(2)).toBe(false);
    });

    it("marks skin-material meshes in inner groups with a surfaceOffset clone", () => {
        const model = modelWithNodes(["ash_head", "ash_torso.001", "ash_leg.001", "ash_hand.001"]);
        model.materials = [
            { name: "M_skin", baseColor: [1, 1, 1, 1], metallic: 0, roughness: 1 },
            { name: "M_pallete", baseColor: [1, 1, 1, 1], metallic: 0, roughness: 1 },
        ];
        // head+torso+hand = skin; legs = garment (palette)
        model.meshes[0].materialIndex = 0; model.meshes[1].materialIndex = 0;
        model.meshes[2].materialIndex = 1; model.meshes[3].materialIndex = 0;
        const cat = buildVariantCatalog(model);
        const { meshes, meshIndices } = resolveCustomizationMeshes(model, cat, defaultCustomization(cat));
        expect([...meshIndices].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
        // skin meshes in inner groups (torso, hand) get the offset clone;
        // head skin is excluded (face group), leg garment isn't skin.
        expect(meshes[0]).toBe(model.meshes[0]);
        expect(meshes[1]).not.toBe(model.meshes[1]);
        expect(meshes[1].surfaceOffset).toBeGreaterThan(0);
        expect(meshes[1].vertices).toBe(model.meshes[1].vertices); // shared buffer
        expect(meshes[2]).toBe(model.meshes[2]);
        expect(meshes[3].surfaceOffset).toBeGreaterThan(0);
    });

    it("inner-layer offset is opt-out via innerLayerOffset=0 and tunable suffixes", () => {
        const model = modelWithNodes(["ash_torso.001", "ash_leg.001"]);
        model.materials = [
            { name: "skin", baseColor: [1, 1, 1, 1], metallic: 0, roughness: 1 },
        ];
        model.meshes[0].materialIndex = 0; model.meshes[1].materialIndex = 0;
        const cat = buildVariantCatalog(model);
        const cust = defaultCustomization(cat);
        const off = resolveCustomizationMeshes(model, cat, cust, { innerLayerOffset: 0 });
        expect(off.meshes[1]).toBe(model.meshes[1]);
        // Exclude torso from inner groups → only the leg skin offsets.
        const custom = resolveCustomizationMeshes(model, cat, cust, {
            innerLayerSuffixes: ["leg"], innerLayerOffset: 0.01,
        });
        expect(custom.meshes[0].surfaceOffset).toBeUndefined();
        expect(custom.meshes[1].surfaceOffset).toBe(0.01);
    });

    it("attaches a skin-derived girth field to all selected meshes when girth is set", () => {
        const model = modelWithNodes(["ash_torso.001", "ash_leg.001", "ash_hair.001"]);
        model.sourceUpAxis = "z";
        // Bone table: spine (full), head (zero) — mesh0 verts split between them.
        model.skin = {
            bones: [
                { name: "spine_01", nodeIndex: 0, parentIndex: -1, inverseBindMatrix: new Float32Array(16), restTranslation: [0, 0, 0], restRotation: [0, 0, 0, 1], restScale: [1, 1, 1] },
                { name: "head", nodeIndex: 1, parentIndex: 0, inverseBindMatrix: new Float32Array(16), restTranslation: [0, 0, 0], restRotation: [0, 0, 0, 1], restScale: [1, 1, 1] },
            ],
            boneNameToIndex: new Map([["spine_01", 0], ["head", 1]]),
        };
        // mesh0: v0 100% spine, v1 50/50, v2 100% head.
        model.meshes[0].joints = new Uint8Array([0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0]);
        model.meshes[0].weights = new Float32Array([1, 0, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0]);
        const cat = buildVariantCatalog(model);
        const cust = defaultCustomization(cat);
        cust.variants["ash_hair"] = "ash_hair.001";
        cust.girth = 0.3;
        const { meshes } = resolveCustomizationMeshes(model, cat, cust);
        // All selected meshes carry the deformation, not just skin ones —
        // garments must widen with the body underneath.
        expect(meshes.every((m) => m.surfaceGirth !== undefined)).toBe(true);
        const g = meshes[0].surfaceGirth!;
        expect(g.factor).toBe(0.3);
        // Region weights from skin data: spine=1, head=0, 50/50 blend=0.5.
        expect(g.weights[0]).toBeCloseTo(1);
        expect(g.weights[1]).toBeCloseTo(0.5);
        expect(g.weights[2]).toBeCloseTo(0);
        // Stored verts are always engine y-up regardless of the source
        // file's axis — the two horizontal axes are x/z.
        expect(g.axes).toEqual([0, 2]);
        // Unskinned meshes (hair fixture has no joints) get the flat fallback.
        expect(meshes[2].surfaceGirth!.weights[0]).toBeCloseTo(0.7);
        // girth=0 → no deformation attached, meshes pass through uncloned.
        cust.girth = 0;
        const off = resolveCustomizationMeshes(model, cat, cust);
        expect(off.meshes.every((m) => m.surfaceGirth === undefined)).toBe(true);
    });

    it("keeps required groups visible when saved pick is null or stale", () => {
        const model = modelWithNodes(KIT);
        const cat = buildVariantCatalog(model);
        const cust: CharacterCustomization = { variants: { ash_torso: null, ash_hair: "bogus.999" }, textures: {}, tints: {} };
        const { meshIndices } = resolveCustomizationMeshes(model, cat, cust);
        expect(meshIndices.has(1)).toBe(true); // torso falls back to .001
        expect(meshIndices.has(4)).toBe(true); // stale hair falls back to .001
    });

    it("internal groups never contribute meshes", () => {
        const model = modelWithNodes(KIT);
        const cat = buildVariantCatalog(model);
        const cust = defaultCustomization(cat);
        cust.variants["ash_collider"] = "ash_collider";
        const { meshIndices } = resolveCustomizationMeshes(model, cat, cust);
        expect(meshIndices.has(9)).toBe(false);
    });
});

describe("customizableGroups", () => {
    it("excludes internal groups and single-variant required groups", () => {
        const cat = buildVariantCatalog(modelWithNodes(KIT));
        const keys = customizableGroups(cat).map((g) => g.key);
        expect(keys).toContain("ash_torso");
        expect(keys).toContain("ash_hair");
        expect(keys).toContain("ash_backpack"); // equipable
        expect(keys).not.toContain("ash_head");  // required singleton — nothing to pick
        expect(keys).not.toContain("ash_collider");
        // ash_mask has a single variant but is defaultOff — still listed (toggleable).
        expect(keys).toContain("ash_mask");
    });
});

describe("requiredMeshIndices", () => {
    it("covers only required groups' selected variants", () => {
        const model = modelWithNodes(KIT);
        const cat = buildVariantCatalog(model);
        const idxs = requiredMeshIndices(cat, defaultCustomization(cat));
        expect([...idxs].sort((a, b) => a - b)).toEqual([0, 1]); // head + torso.001
    });
});

describe("labels", () => {
    it("slotLabel strips the model prefix and title-cases", () => {
        expect(slotLabel("ash_upperTorso")).toBe("Upper Torso");
        expect(slotLabel("rb_headwear")).toBe("Headwear");
        expect(slotLabel("f_leg_acc")).toBe("Leg Acc");
    });
    it("variantLabel shows the numeric suffix or Base", () => {
        expect(variantLabel("ash_torso.007")).toBe("7");
        expect(variantLabel("rb_torso")).toBe("Base");
    });
});

describe("computeMeshBounds", () => {
    it("bounds selected meshes only", () => {
        const m: ModelData = {
            name: "t", format: "fbx",
            meshes: [
                { vertices: new Float32Array([0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 0, 1]), indices: new Uint16Array([0, 1, 2]), vertexCount: 2, indexCount: 3, uvs: null, colors: null },
                { vertices: new Float32Array([9, 9, 9, 0, 1, 0, 10, 10, 10, 0, 0, 1]), indices: new Uint16Array([0, 1, 2]), vertexCount: 2, indexCount: 3, uvs: null, colors: null },
            ],
        };
        const b = computeMeshBounds(m.meshes, new Set([0]))!;
        expect(b.min).toEqual([0, 0, 0]);
        expect(b.max).toEqual([1, 1, 1]);
        expect(computeMeshBounds(m.meshes, new Set()) ?? null).toBeNull();
    });
});

describe("withMaterialOverrides", () => {
    it("clones only overridden materials, preserving indices", () => {
        const mats = [
            { name: "a", baseColor: [1, 1, 1, 1] as [number, number, number, number], metallic: 0, roughness: 1, textureData: new ArrayBuffer(8) },
            { name: "b", baseColor: [1, 1, 1, 1] as [number, number, number, number], metallic: 0, roughness: 1 },
        ];
        const out = withMaterialOverrides(mats, [
            { material: "b", tint: [0.5, 0.2, 0.8] },
        ])!;
        expect(out[0]).toBe(mats[0]); // untouched — same object
        expect(out[1]).not.toBe(mats[1]);
        expect(out[1].baseColor).toEqual([0.5, 0.2, 0.8, 1]);
        expect(withMaterialOverrides(mats, [])).toBe(mats);
    });

    it("swaps textureData and clears textureUri", () => {
        const orig = new ArrayBuffer(4);
        const swap = new ArrayBuffer(8);
        const mats = [{ name: "m", baseColor: [1, 1, 1, 1] as [number, number, number, number], metallic: 0, roughness: 1, textureData: orig, textureUri: "x.png" }];
        const out = withMaterialOverrides(mats, [{ material: "m", textureData: swap }])!;
        expect(out[0].textureData).toBe(swap);
        expect(out[0].textureUri).toBeUndefined();
    });
});
