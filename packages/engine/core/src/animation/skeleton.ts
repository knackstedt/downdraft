export interface Bone {
  name: string;
  parentIndex: number;
  childrenIndices: number[];
  bindPosition: [number, number, number];
  bindRotation: [number, number, number, number];
  bindScale: [number, number, number];
  inverseBindMatrix: Float32Array;
  /** World transform of non-bone ancestors for root bones. See BoneData. */
  rootAncestorMatrix?: Float32Array;
}

export interface SkeletonData {
  bones: Bone[];
  name: string;
  rootBoneIndex: number;
}

export interface GLTFSkin {
  joints: number[];
  inverseBindMatrices?: number;
  skeleton?: number;
  name?: string;
}

import { composeMat4Into, invertMat4, multiplyMat4Into } from "../index";

export class Skeleton {
  data: SkeletonData;
  private boneIndexMap: Map<string, number> = new Map();
  private boneWorldMatrices: Float32Array[];
  private skinMatrices: Float32Array;
  // Scratch buffers to avoid per-frame allocations
  private scratchLocal: Float32Array;
  private scratchProduct: Float32Array;
  private scratchSkin: Float32Array;
  // Per-bone (rootAncestorMatrix, inverse) resolved to the bone's chain ROOT.
  // Root bones carry the accumulated non-bone-ancestor world transform A in
  // rootAncestorMatrix, so W = A·chain while inverseBind = chain_bind⁻¹·A⁻¹.
  // The raw skin matrix W·IBM = A·(chain·chain_bind⁻¹)·A⁻¹ is the vertex delta
  // conjugated by A — for A≠identity that rotates verts about the scene origin
  // and scales translations, mangling any animated pose (bind pose stays
  // identity, which hides the bug until the first animated frame). Skin
  // vertices live in pre-ancestor space, so the correct matrix is the
  // de-conjugated A⁻¹·W·IBM·A. Bones whose root has no ancestor transform
  // keep a null entry (no correction needed).
  private boneAncestor: (Float32Array | null)[];
  private boneAncestorInv: (Float32Array | null)[];

  constructor(data: SkeletonData) {
    this.data = data;
    for (let i = 0; i < data.bones.length; i++) {
      this.boneIndexMap.set(data.bones[i].name, i);
    }
    this.boneWorldMatrices = data.bones.map(() => new Float32Array(16));
    this.skinMatrices = new Float32Array(data.bones.length * 16);
    this.scratchLocal = new Float32Array(16);
    this.scratchProduct = new Float32Array(16);
    this.scratchSkin = new Float32Array(16);
    this.boneAncestor = data.bones.map(() => null);
    this.boneAncestorInv = data.bones.map(() => null);
    for (let i = 0; i < data.bones.length; i++) {
      let r = i;
      while (data.bones[r].parentIndex >= 0) r = data.bones[r].parentIndex;
      const a = data.bones[r].rootAncestorMatrix;
      if (!a) continue;
      const inv = invertMat4(new Float32Array(a));
      // invertMat4 returns all-zeros for singular matrices — skip correction.
      if (inv[15] === 0) continue;
      this.boneAncestor[i] = a;
      this.boneAncestorInv[i] = inv;
    }
  }

  getBoneIndex(name: string): number {
    return this.boneIndexMap.get(name) ?? -1;
  }

  getBoneCount(): number {
    return this.data.bones.length;
  }

  computeSkinMatrices(
    localTransforms: Array<{ position: [number, number, number]; rotation: [number, number, number, number]; scale: [number, number, number] }>,
  ): Float32Array {
    const bones = this.data.bones;
    const scratchLocal = this.scratchLocal;
    const scratchProduct = this.scratchProduct;

    for (let i = 0; i < bones.length; i++) {
      const bone = bones[i];
      const local = localTransforms[i];
      composeMat4Into(local.position, local.rotation, local.scale, scratchLocal);

      const worldMat = this.boneWorldMatrices[i];
      if (bone.parentIndex >= 0 && bone.rootAncestorMatrix) {
        // Child bone with non-bone intermediates: world = parent * intermediate * local
        multiplyMat4Into(bone.rootAncestorMatrix, scratchLocal, scratchProduct);
        multiplyMat4Into(this.boneWorldMatrices[bone.parentIndex], scratchProduct, worldMat);
      } else if (bone.parentIndex >= 0) {
        multiplyMat4Into(this.boneWorldMatrices[bone.parentIndex], scratchLocal, worldMat);
      } else if (bone.rootAncestorMatrix) {
        // Root bone with non-bone ancestors: world = ancestorWorld * local
        multiplyMat4Into(bone.rootAncestorMatrix, scratchLocal, worldMat);
      } else {
        worldMat.set(scratchLocal);
      }
    }

    for (let i = 0; i < bones.length; i++) {
      multiplyMat4Into(this.boneWorldMatrices[i], bones[i].inverseBindMatrix, scratchProduct);
      const aInv = this.boneAncestorInv[i];
      if (aInv) {
        // De-conjugate the root ancestor transform: verts live in
        // pre-ancestor space, so S = A⁻¹·W·IBM·A (see boneAncestor comment).
        multiplyMat4Into(aInv, scratchProduct, this.scratchSkin);
        multiplyMat4Into(this.scratchSkin, this.boneAncestor[i]!, scratchProduct);
      }
      this.skinMatrices.set(scratchProduct, i * 16);
    }

    return this.skinMatrices;
  }

  /**
   * Returns the bone world matrices computed during the last
   * `computeSkinMatrices()` call. Each entry is a column-major mat4.
   * The translation component (indices 12,13,14) gives the bone's
   * world-space position. Call after `computeSkinMatrices()` to get
   * the current animated world transforms.
   */
  getWorldMatrices(): Float32Array[] {
    return this.boneWorldMatrices;
  }

  getBindPose(): Array<{ position: [number, number, number]; rotation: [number, number, number, number]; scale: [number, number, number] }> {
    return this.data.bones.map((bone) => ({
      position: bone.bindPosition,
      rotation: bone.bindRotation,
      scale: bone.bindScale,
    }));
  }
}

export function buildSkeletonFromGLTF(
  nodes: Array<{
    name?: string;
    children?: number[];
    translation?: [number, number, number];
    rotation?: [number, number, number, number];
    scale?: [number, number, number];
  }>,
  skin: { joints: number[]; inverseBindMatrices?: Float32Array; name?: string },
): SkeletonData {
  const bones: Bone[] = [];
  const jointToBoneIndex = new Map<number, number>();

  for (let i = 0; i < skin.joints.length; i++) {
    const nodeIndex = skin.joints[i];
    const node = nodes[nodeIndex];
    jointToBoneIndex.set(nodeIndex, i);

    const bindPos: [number, number, number] = node.translation ?? [0, 0, 0];
    const bindRot: [number, number, number, number] = node.rotation ?? [0, 0, 0, 1];
    const bindScale: [number, number, number] = node.scale ?? [1, 1, 1];

    let ibm: Float32Array;
    if (skin.inverseBindMatrices && i * 16 < skin.inverseBindMatrices.length) {
      ibm = skin.inverseBindMatrices.slice(i * 16, i * 16 + 16);
    } else {
      const bindMatrix = new Float32Array(16);
      composeMat4Into(bindPos, bindRot, bindScale, bindMatrix);
      ibm = invertMat4(bindMatrix);
    }

    bones.push({
      name: node.name ?? `bone_${i}`,
      parentIndex: -1,
      childrenIndices: [],
      bindPosition: bindPos,
      bindRotation: bindRot,
      bindScale: bindScale,
      inverseBindMatrix: ibm,
    });
  }

  for (let i = 0; i < skin.joints.length; i++) {
    const nodeIndex = skin.joints[i];
    const node = nodes[nodeIndex];
    if (node.children) {
      node.children.forEach((childNodeIndex) => {
        const childBoneIndex = jointToBoneIndex.get(childNodeIndex);
        if (childBoneIndex !== undefined) {
          bones[i].childrenIndices.push(childBoneIndex);
          bones[childBoneIndex].parentIndex = i;
        }
      });
    }
  }

  let rootBoneIndex = 0;
  for (let i = 0; i < bones.length; i++) {
    if (bones[i].parentIndex < 0) {
      rootBoneIndex = i;
      break;
    }
  }

  return {
    bones,
    name: skin.name ?? "skeleton",
    rootBoneIndex,
  };
}
