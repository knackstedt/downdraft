// ============================================================================
// bindUnskinnedMeshes tests — rigid binding for meshes that ship without skin
// weights (Unity/VRChat-style bone-parented accessories flattened into FBX).
//
// Run: bun test packages/engine/libraries/models/src/bind-unskinned-meshes.spec.ts
// ============================================================================

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "path";
import { bindUnskinnedMeshes } from "./bind-unskinned-meshes";
import { loadModel } from "./loader";
import type { BoneData, MeshData, ModelData, SkinData } from "./types";

const SPEC_DIR = import.meta.dirname!;

/** Column-major translation-only mat4. */
function translationMat4(x: number, y: number, z: number): Float32Array {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

/** Bone whose bind world transform is a pure translation to `pos`. */
function bone(name: string, nodeIndex: number, parentIndex: number, pos: [number, number, number]): BoneData {
    return {
        name,
        nodeIndex,
        parentIndex,
        // inverseBindMatrix = inverse(bind world) = translate(-pos)
        inverseBindMatrix: translationMat4(-pos[0], -pos[1], -pos[2]),
        restTranslation: pos,
        restRotation: [0, 0, 0, 1],
        restScale: [1, 1, 1],
    };
}

function mesh(positions: number[], withSkin = false): MeshData {
    const vc = positions.length / 3;
    const m: MeshData = {
        vertices: new Float32Array(positions),
        indices: new Uint16Array(vc >= 3 ? [0, 1, 2] : []),
        vertexCount: vc,
        indexCount: vc >= 3 ? 3 : 0,
        uvs: null,
        colors: null,
    };
    if (withSkin) {
        m.joints = new Uint8Array(vc * 4);
        m.weights = new Float32Array(vc * 4);
        for (let v = 0; v < vc; v++) m.weights[v * 4] = 1;
    }
    return m;
}

function model(bones: BoneData[], meshes: MeshData[], normalizationMatrix?: Float32Array): ModelData {
    const skin: SkinData = {
        bones,
        boneNameToIndex: new Map(bones.map((b, i) => [b.name, i])),
        normalizationMatrix,
    };
    return { name: "test", format: "fbx", meshes, skin };
}

describe("bindUnskinnedMeshes", () => {
    it("binds an unskinned mesh's vertices to the nearest bone segment", () => {
        // pelvis(0,1,0) → spine(0,1.3,0) → head(0,1.7,0); head extends upward.
        const bones = [
            bone("pelvis", 0, -1, [0, 1, 0]),
            bone("spine", 1, 0, [0, 1.3, 0]),
            bone("head", 2, 1, [0, 1.7, 0]),
        ];
        const m = mesh([
            0, 0.9, 0,   // nearest pelvis
            0, 1.5, 0,   // nearest spine
            0, 1.8, 0.1, // nearest head
        ]);
        const bound = bindUnskinnedMeshes(model(bones, [m]));
        expect(bound).toBe(1);
        expect(m.joints).toBeDefined();
        expect(m.weights).toBeDefined();
        expect(m.joints!.length).toBe(m.vertexCount * 4);
        expect(m.weights!.length).toBe(m.vertexCount * 4);
        expect(m.joints![0]).toBe(0); // pelvis
        expect(m.joints![4]).toBe(1); // spine
        expect(m.joints![8]).toBe(2); // head
        for (let v = 0; v < m.vertexCount; v++) {
            expect(m.weights![v * 4]).toBe(1);
        }
    });

    it("leaves leaf bones reachable beyond their joint position", () => {
        // calf → foot; foot is a leaf whose segment extends along its own axis.
        const bones = [
            bone("calf", 0, -1, [0, 0.5, 0]),
            bone("foot", 1, 0, [0, 0.15, 0.05]),
        ];
        // Vertex sits past the foot joint along the calf→foot direction.
        const m = mesh([0, 0.05, 0.12]);
        bindUnskinnedMeshes(model(bones, [m]));
        expect(m.joints![0]).toBe(1); // foot, not calf
    });

    it("does not touch meshes that already have skin weights", () => {
        const bones = [bone("pelvis", 0, -1, [0, 1, 0])];
        const skinned = mesh([0, 0.9, 0, 0, 1.1, 0], true);
        const joints = skinned.joints;
        const bound = bindUnskinnedMeshes(model(bones, [skinned]));
        expect(bound).toBe(0);
        expect(skinned.joints).toBe(joints);
    });

    it("rebinds meshes with truncated/partial skin attribute arrays", () => {
        const bones = [bone("pelvis", 0, -1, [0, 1, 0])];
        const m = mesh([0, 1, 0, 0, 1, 0, 0, 1, 0]);
        m.joints = new Uint8Array(4); // only one vertex worth — invalid
        m.weights = new Float32Array(4);
        const bound = bindUnskinnedMeshes(model(bones, [m]));
        expect(bound).toBe(1);
        expect(m.joints!.length).toBe(m.vertexCount * 4);
    });

    it("maps bone bind positions through skin.normalizationMatrix", () => {
        // Z-up source: normalization rotates source (x,y,z) → (x, z, -y).
        const T = new Float32Array([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
        // Two root bones: A at source (0,1,0) → normalized (0,0,-1);
        //                 B at source (0,-1,0) → normalized (0,0,1).
        const bones = [
            bone("a", 0, -1, [0, 1, 0]),
            bone("b", 1, -1, [0, -1, 0]),
        ];
        // Vertex at normalized (0,0,1) must bind B — without normalization
        // both candidates tie at distance²=2 and A would win by index order.
        const m = mesh([0, 0, 1]);
        bindUnskinnedMeshes(model(bones, [m], T));
        expect(m.joints![0]).toBe(1);
    });

    it("is a no-op when the model has no skin or no meshes", () => {
        expect(bindUnskinnedMeshes({ name: "x", format: "obj", meshes: [mesh([0, 0, 0])] })).toBe(0);
        const bones = [bone("pelvis", 0, -1, [0, 1, 0])];
        expect(bindUnskinnedMeshes(model(bones, []))).toBe(0);
    });
});

// The real fixture lives in a separate game repo (games/ is gitignored) —
// skip when it isn't on disk.
const ROBIN_FBX = resolve(SPEC_DIR, "..", "..", "..", "..", "..",
    "games/andrews-sandbox/src/assets/builtin/Robin/Robin/mesh/Robin.fbx");

describe.skipIf(!existsSync(ROBIN_FBX))("bindUnskinnedMeshes (Robin.fbx real fixture)", () => {
    it("gives every mesh usable skin attributes with sensible bone picks", async () => {
        const data = await Bun.file(ROBIN_FBX).arrayBuffer();
        const m = await loadModel(data, "Robin.fbx");
        expect(m.skin).toBeDefined();

        const unskinnedBefore = m.meshes.filter(
            (mm) => !mm.joints || !mm.weights || mm.joints.length < mm.vertexCount * 4,
        ).length;
        expect(unskinnedBefore).toBeGreaterThan(0); // fixture sanity: Robin ships unskinned parts

        const bound = bindUnskinnedMeshes(m);
        expect(bound).toBe(unskinnedBefore);

        // Every mesh now renders skinned; every bound vertex carries weight 1
        // on a valid bone index.
        const boneCount = m.skin!.bones.length;
        m.meshes.forEach((mm) => {
            expect(mm.joints!.length).toBeGreaterThanOrEqual(mm.vertexCount * 4);
            expect(mm.weights!.length).toBeGreaterThanOrEqual(mm.vertexCount * 4);
            for (let v = 0; v < mm.vertexCount; v++) {
                expect(mm.weights![v * 4]).toBeGreaterThan(0);
                expect(mm.joints![v * 4]).toBeLessThan(boneCount);
            }
        });

        // Spot-check anatomy: hair binds near the head, pants near the legs.
        const nodeByName = new Map((m.nodes ?? []).map((n) => [n.name, n]));
        const boneName = (mm: MeshData, v: number) => m.skin!.bones[mm.joints![v * 4]].name;

        const hair = m.meshes[nodeByName.get("rb_hair")!.mesh!];
        expect(boneName(hair, 0)).toMatch(/head|neck|hair/);

        const legs = m.meshes[nodeByName.get("rb_legs")!.mesh!];
        for (let v = 0; v < legs.vertexCount; v += Math.max(1, Math.floor(legs.vertexCount / 20))) {
            expect(boneName(legs, v)).toMatch(/thigh|calf|pelvis|spine|foot|ball|hip/i);
        }
    });
});
