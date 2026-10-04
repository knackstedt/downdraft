// ============================================================================
// Bind Unskinned Meshes — rigid-bind meshes without skin weights to the
// nearest bone of the model's skeleton.
//
// Character asset packs (e.g. Unity/VRChat avatars round-tripped through FBX)
// frequently contain accessory meshes — hair, glasses, hats, shoes, pants —
// that carry no skin deformer because the DCC/prefab attached them as rigid
// children of a bone, a relationship FBX cannot represent in the geometry.
// Left unskinned they render at bind pose forever, visibly detached from the
// animated skeleton (a hat floating where the head started, pants stuck at
// the feet while the legs walk away).
//
// bindUnskinnedMeshes assigns every vertex of each unskinned mesh to the bone
// whose bind-pose segment (joint → preferred child joint; leaf bones extend
// along their own parent→joint axis so extremities still map correctly) is
// nearest to the vertex — weight 1.0, matching the rigid-attachment semantics
// the asset was authored with.
// ============================================================================

import { invertMat4 } from "@downdraft/engine";
import type { ModelData } from "./types";

/** Bone-name pattern for the "axial continuation" child that defines a bone's
 *  segment direction (spine→spine, hand→middle finger, foot→toe, …). */
const AXIAL_CHILD = /spine|neck|head|middle|ball|toe/i;

/**
 * Rigid-bind every mesh that lacks usable skin weights to the nearest
 * bind-pose bone segment.
 *
 * Call after normalization: mesh vertices must be in the same space as the
 * rendered model (i.e. post-normalizeModel). Bone bind positions are derived
 * from `inverse(inverseBindMatrix)` — the bind world transform in source
 * space — then mapped through `skin.normalizationMatrix` so they compare
 * against normalized vertices.
 *
 * @returns the number of meshes that received synthesized skin weights.
 */
export function bindUnskinnedMeshes(modelData: ModelData): number {
    const skin = modelData.skin;
    if (!skin || skin.bones.length === 0 || !modelData.meshes?.length) return 0;

    const bones = skin.bones;
    const boneCount = bones.length;

    // Bone joint positions at bind, in normalized vertex space.
    const T = skin.normalizationMatrix ?? null;
    const bindPos = new Float32Array(boneCount * 3);
    for (let i = 0; i < boneCount; i++) {
        const w = invertMat4(bones[i].inverseBindMatrix);
        let x = w[12], y = w[13], z = w[14];
        if (T) {
            const nx = T[0] * x + T[4] * y + T[8] * z + T[12];
            const ny = T[1] * x + T[5] * y + T[9] * z + T[13];
            const nz = T[2] * x + T[6] * y + T[10] * z + T[14];
            x = nx; y = ny; z = nz;
        }
        bindPos[i * 3] = x; bindPos[i * 3 + 1] = y; bindPos[i * 3 + 2] = z;
    }

    // Bone segments: joint → "tip". The tip is the axial-continuation child
    // joint; leaf bones extend one bone-length along their own axis.
    const children = new Map<number, number[]>();
    for (let i = 0; i < boneCount; i++) {
        const p = bones[i].parentIndex;
        if (p < 0) continue;
        let list = children.get(p);
        if (!list) { list = []; children.set(p, list); }
        list.push(i);
    }
    const segA = new Float32Array(boneCount * 3);
    const segB = new Float32Array(boneCount * 3);
    for (let i = 0; i < boneCount; i++) {
        const ax = bindPos[i * 3], ay = bindPos[i * 3 + 1], az = bindPos[i * 3 + 2];
        let bx = ax, by = ay, bz = az;
        const kids = children.get(i);
        if (kids && kids.length > 0) {
            const tip = kids.find((k) => AXIAL_CHILD.test(bones[k].name)) ?? kids[0];
            bx = bindPos[tip * 3]; by = bindPos[tip * 3 + 1]; bz = bindPos[tip * 3 + 2];
        } else {
            const p = bones[i].parentIndex;
            if (p >= 0) {
                bx = ax + (ax - bindPos[p * 3]);
                by = ay + (ay - bindPos[p * 3 + 1]);
                bz = az + (az - bindPos[p * 3 + 2]);
            }
        }
        segA[i * 3] = ax; segA[i * 3 + 1] = ay; segA[i * 3 + 2] = az;
        segB[i * 3] = bx; segB[i * 3 + 1] = by; segB[i * 3 + 2] = bz;
    }

    let bound = 0;
    for (let _i = 0, _it = modelData.meshes, _n = _it.length; _i < _n; _i++) { const mesh = _it[_i];
        // Matches the renderer's own test for "has skinning data".
        if (mesh.joints && mesh.weights && mesh.joints.length >= mesh.vertexCount * 4) continue;
        const vc = mesh.vertexCount;
        const verts = mesh.vertices;
        const stride = vc > 0 ? Math.floor(verts.length / vc) : 0;
        if (stride < 3) continue;

        const joints =
            boneCount <= 255 ? new Uint8Array(vc * 4) :
            boneCount <= 65535 ? new Uint16Array(vc * 4) :
            new Uint32Array(vc * 4);
        const weights = new Float32Array(vc * 4);

        for (let v = 0; v < vc; v++) {
            const px = verts[v * stride], py = verts[v * stride + 1], pz = verts[v * stride + 2];
            let best = 0;
            let bestD = Infinity;
            for (let b = 0; b < boneCount; b++) {
                const ax = segA[b * 3], ay = segA[b * 3 + 1], az = segA[b * 3 + 2];
                const abx = segB[b * 3] - ax, aby = segB[b * 3 + 1] - ay, abz = segB[b * 3 + 2] - az;
                const len2 = abx * abx + aby * aby + abz * abz;
                let t = len2 > 1e-12 ? ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / len2 : 0;
                if (t < 0) t = 0; else if (t > 1) t = 1;
                const dx = px - (ax + t * abx);
                const dy = py - (ay + t * aby);
                const dz = pz - (az + t * abz);
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 < bestD) { bestD = d2; best = b; }
            }
            joints[v * 4] = best;
            weights[v * 4] = 1;
        }
        mesh.joints = joints;
        mesh.weights = weights;
        bound++;
    }
    return bound;
}
