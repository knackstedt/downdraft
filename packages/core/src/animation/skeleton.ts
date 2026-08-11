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

function multiplyMat4Into(a: Float32Array, b: Float32Array, out: Float32Array): void {
  // Compute A * B in column-major layout, writing into `out` (no allocation).
  // out[col=i, row=j] = sum_k A[col=k, row=j] * B[col=i, row=k]
  for (let i = 0; i < 4; i++) {
    const bi0 = b[i * 4 + 0], bi1 = b[i * 4 + 1], bi2 = b[i * 4 + 2], bi3 = b[i * 4 + 3];
    out[i * 4 + 0] = a[0] * bi0 + a[4] * bi1 + a[8] * bi2 + a[12] * bi3;
    out[i * 4 + 1] = a[1] * bi0 + a[5] * bi1 + a[9] * bi2 + a[13] * bi3;
    out[i * 4 + 2] = a[2] * bi0 + a[6] * bi1 + a[10] * bi2 + a[14] * bi3;
    out[i * 4 + 3] = a[3] * bi0 + a[7] * bi1 + a[11] * bi2 + a[15] * bi3;
  }
}

function invertMat4(m: Float32Array): Float32Array {
  // Column-major layout: m[col*4 + row] = M[row][col].
  // Compute the adjugate (transpose of cofactor matrix) divided by det.
  const a00 = m[0], a01 = m[4], a02 = m[8],  a03 = m[12];
  const a10 = m[1], a11 = m[5], a12 = m[9],  a13 = m[13];
  const a20 = m[2], a21 = m[6], a22 = m[10], a23 = m[14];
  const a30 = m[3], a31 = m[7], a32 = m[11], a33 = m[15];

  const b00 = a11*a22*a33 - a11*a23*a32 - a21*a12*a33 + a21*a13*a32 + a31*a12*a23 - a31*a13*a22;
  const b01 = -a10*a22*a33 + a10*a23*a32 + a20*a12*a33 - a20*a13*a32 - a30*a12*a23 + a30*a13*a22;
  const b02 = a10*a21*a33 - a10*a23*a31 - a20*a11*a33 + a20*a13*a31 + a30*a11*a23 - a30*a13*a21;
  const b03 = -a10*a21*a32 + a10*a22*a31 + a20*a11*a32 - a20*a12*a31 - a30*a11*a22 + a30*a12*a21;

  const b10 = -a01*a22*a33 + a01*a23*a32 + a21*a02*a33 - a21*a03*a32 - a31*a02*a23 + a31*a03*a22;
  const b11 = a00*a22*a33 - a00*a23*a32 - a20*a02*a33 + a20*a03*a32 + a30*a02*a23 - a30*a03*a22;
  const b12 = -a00*a21*a33 + a00*a23*a31 + a20*a01*a33 - a20*a03*a31 - a30*a01*a23 + a30*a03*a21;
  const b13 = a00*a21*a32 - a00*a22*a31 - a20*a01*a32 + a20*a02*a31 + a30*a01*a22 - a30*a02*a21;

  const b20 = a01*a12*a33 - a01*a13*a32 - a11*a02*a33 + a11*a03*a32 + a31*a02*a13 - a31*a03*a12;
  const b21 = -a00*a12*a33 + a00*a13*a32 + a10*a02*a33 - a10*a03*a32 - a30*a02*a13 + a30*a03*a12;
  const b22 = a00*a11*a33 - a00*a13*a31 - a10*a01*a33 + a10*a03*a31 + a30*a01*a13 - a30*a03*a11;
  const b23 = -a00*a11*a32 + a00*a12*a31 + a10*a01*a32 - a10*a02*a31 - a30*a01*a12 + a30*a02*a11;

  const b30 = -a01*a12*a23 + a01*a13*a22 + a11*a02*a23 - a11*a03*a22 - a21*a02*a13 + a21*a03*a12;
  const b31 = a00*a12*a23 - a00*a13*a22 - a10*a02*a23 + a10*a03*a22 + a20*a02*a13 - a20*a03*a12;
  const b32 = -a00*a11*a23 + a00*a13*a21 + a10*a01*a23 - a10*a03*a21 - a20*a01*a13 + a20*a03*a11;
  const b33 = a00*a11*a22 - a00*a12*a21 - a10*a01*a22 + a10*a02*a21 + a20*a01*a12 - a20*a02*a11;

  let det = a00*b00 + a01*b01 + a02*b02 + a03*b03;
  if (Math.abs(det) < 1e-9) return new Float32Array(16);
  det = 1 / det;

  // Adjugate = cofactor^T, stored column-major
  const out = new Float32Array(16);
  out[0] = b00 * det;  out[1] = b01 * det;  out[2] = b02 * det;  out[3] = b03 * det;
  out[4] = b10 * det;  out[5] = b11 * det;  out[6] = b12 * det;  out[7] = b13 * det;
  out[8] = b20 * det;  out[9] = b21 * det;  out[10] = b22 * det; out[11] = b23 * det;
  out[12] = b30 * det; out[13] = b31 * det; out[14] = b32 * det; out[15] = b33 * det;
  return out;
}

function composeMat4Into(
  pos: [number, number, number],
  rot: [number, number, number, number],
  scale: [number, number, number],
  m: Float32Array,
): void {
  const x = rot[0], y = rot[1], z = rot[2], w = rot[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;

  m[0] = (1 - (yy + zz)) * scale[0];
  m[1] = (xy + wz) * scale[0];
  m[2] = (xz - wy) * scale[0];
  m[3] = 0;
  m[4] = (xy - wz) * scale[1];
  m[5] = (1 - (xx + zz)) * scale[1];
  m[6] = (yz + wx) * scale[1];
  m[7] = 0;
  m[8] = (xz + wy) * scale[2];
  m[9] = (yz - wx) * scale[2];
  m[10] = (1 - (xx + yy)) * scale[2];
  m[11] = 0;
  m[12] = pos[0];
  m[13] = pos[1];
  m[14] = pos[2];
  m[15] = 1;
}

export class Skeleton {
  data: SkeletonData;
  private boneIndexMap: Map<string, number> = new Map();
  private boneWorldMatrices: Float32Array[];
  private skinMatrices: Float32Array;
  // Scratch buffers to avoid per-frame allocations
  private scratchLocal: Float32Array;
  private scratchProduct: Float32Array;

  constructor(data: SkeletonData) {
    this.data = data;
    for (let i = 0; i < data.bones.length; i++) {
      this.boneIndexMap.set(data.bones[i].name, i);
    }
    this.boneWorldMatrices = data.bones.map(() => new Float32Array(16));
    this.skinMatrices = new Float32Array(data.bones.length * 16);
    this.scratchLocal = new Float32Array(16);
    this.scratchProduct = new Float32Array(16);
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
      for (const childNodeIndex of node.children) {
        const childBoneIndex = jointToBoneIndex.get(childNodeIndex);
        if (childBoneIndex !== undefined) {
          bones[i].childrenIndices.push(childBoneIndex);
          bones[childBoneIndex].parentIndex = i;
        }
      }
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
