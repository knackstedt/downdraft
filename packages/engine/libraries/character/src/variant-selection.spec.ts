// ============================================================================
// selectVariantMeshes tests — one mesh-bearing node per equipment slot, with
// Blender `_ptN` mesh splits folded into their canonical variant node.
//
// Run: bun test packages/engine/libraries/character/src/variant-selection.spec.ts
// ============================================================================

import { describe, expect, it } from "bun:test";
import { selectVariantMeshes } from "./loader";
import type { MeshData, ModelData, ModelNode } from "@downdraft/engine/libraries/models";

function mesh(): MeshData {
    return {
        vertices: new Float32Array(9),
        indices: new Uint16Array([0, 1, 2]),
        vertexCount: 3,
        indexCount: 3,
        uvs: null,
        colors: null,
    };
}

/** Model whose node list is the given mesh-node names, one mesh per node. */
function modelWithNodes(names: string[]): { model: ModelData; nodes: ModelNode[] } {
    const nodes: ModelNode[] = names.map((name, i) => ({ name, mesh: i, meshes: [i] }));
    const model: ModelData = {
        name: "test",
        format: "fbx",
        meshes: names.map(() => mesh()),
        nodes,
    };
    return { model, nodes };
}

describe("selectVariantMeshes", () => {
    it("keeps exactly one variant per numbered group", () => {
        const { model, nodes } = modelWithNodes(["torso.001", "torso.002", "hair.001", "hair.002"]);
        selectVariantMeshes(model);
        expect(model.meshes.length).toBe(2);
        expect(nodes[0].mesh).toBe(0);  // torso.001 kept
        expect(nodes[1].mesh).toBeUndefined(); // torso.002 dropped
        expect(nodes[2].mesh).toBe(1);  // hair.001 kept
        expect(nodes[3].mesh).toBeUndefined();
    });

    it("keeps every _ptN split part of the selected variant", () => {
        // rb_headwear.005 split into _pt1/_pt2 must not shed pt2 when 005 wins.
        const { model, nodes } = modelWithNodes([
            "rb_headwear.004",
            "rb_headwear.005_pt1",
            "rb_headwear.005_pt2",
            "rb_headwear.006",
        ]);
        selectVariantMeshes(model);
        // First variant (004) wins; both .005 parts and .006 are dropped.
        expect(model.meshes.length).toBe(1);
        expect(nodes[0].meshes).toEqual([0]);

        // When the split variant itself is first, both parts survive.
        const { model: m2, nodes: n2 } = modelWithNodes([
            "rb_headwear.005_pt1",
            "rb_headwear.005_pt2",
            "rb_headwear.006",
        ]);
        selectVariantMeshes(m2);
        expect(m2.meshes.length).toBe(2);
        expect(n2[0].meshes).toEqual([0]);
        expect(n2[1].meshes).toEqual([1]);
        expect(n2[2].mesh).toBeUndefined();
    });

    it("does not merge different variants that merely share a _ptN base", () => {
        const { model } = modelWithNodes(["hat.001_pt1", "hat.002_pt1"]);
        selectVariantMeshes(model);
        // hat.001_pt1 wins the group; hat.002_pt1 is a different variant.
        expect(model.meshes.length).toBe(1);
    });

    it("leaves single-node groups and non-variant names alone", () => {
        const { model, nodes } = modelWithNodes(["body", "head", "hand_l"]);
        selectVariantMeshes(model);
        expect(model.meshes.length).toBe(3);
        expect(nodes.every((n, i) => n.mesh === i)).toBe(true);
    });
});
