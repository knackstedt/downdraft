export interface Bone {
  name: string;
  parentIndex: number;
  childrenIndices: number[];
  bindPosition: [number, number, number];
  bindRotation: [number, number, number, number];
  bindScale: [number, number, number];
  inverseBindMatrix: Float32Array;
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

function multiplyMat4(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[i * 4 + j] =
        a[i * 4 + 0] * b[0 * 4 + j] +
        a[i * 4 + 1] * b[1 * 4 + j] +
        a[i * 4 + 2] * b[2 * 4 + j] +
        a[i * 4 + 3] * b[3 * 4 + j];
    }
  }
  return out;
}

function invertMat4(m: Float32Array): Float32Array {
  const out = new Float32Array(16);
  const inv = new Float32Array(16);

  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  inv[1] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  inv[2] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  inv[3] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  inv[4] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  inv[6] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  inv[7] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  inv[8] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  inv[9] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  inv[11] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  inv[12] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  inv[13] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  inv[14] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];

  let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  if (Math.abs(det) < 1e-9) return new Float32Array(16);
  det = 1 / det;
  for (let i = 0; i < 16; i++) out[i] = inv[i] * det;
  return out;
}

function composeMat4(
  pos: [number, number, number],
  rot: [number, number, number, number],
  scale: [number, number, number],
): Float32Array {
  const x = rot[0], y = rot[1], z = rot[2], w = rot[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;

  const m = new Float32Array(16);
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
  return m;
}

export class Skeleton {
  data: SkeletonData;
  private boneIndexMap: Map<string, number> = new Map();
  private boneWorldMatrices: Float32Array[];
  private skinMatrices: Float32Array;

  constructor(data: SkeletonData) {
    this.data = data;
    for (let i = 0; i < data.bones.length; i++) {
      this.boneIndexMap.set(data.bones[i].name, i);
    }
    this.boneWorldMatrices = data.bones.map(() => new Float32Array(16));
    this.skinMatrices = new Float32Array(data.bones.length * 16);
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

    for (let i = 0; i < bones.length; i++) {
      const bone = bones[i];
      const local = localTransforms[i];
      const localMatrix = composeMat4(local.position, local.rotation, local.scale);

      if (bone.parentIndex >= 0) {
        this.boneWorldMatrices[i] = multiplyMat4(this.boneWorldMatrices[bone.parentIndex], localMatrix);
      } else {
        this.boneWorldMatrices[i] = localMatrix;
      }
    }

    for (let i = 0; i < bones.length; i++) {
      const skinMatrix = multiplyMat4(this.boneWorldMatrices[i], bones[i].inverseBindMatrix);
      this.skinMatrices.set(skinMatrix, i * 16);
    }

    return this.skinMatrices;
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
      const bindMatrix = composeMat4(bindPos, bindRot, bindScale);
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
