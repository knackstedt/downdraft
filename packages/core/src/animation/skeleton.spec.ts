import { Skeleton } from "./skeleton";
import type { Bone, SkeletonData } from "./skeleton";

function makeBone(name: string, parentIndex: number, bindPos: [number, number, number] = [0, 0, 0]): Bone {
  const bindRot: [number, number, number, number] = [0, 0, 0, 1];
  const bindScale: [number, number, number] = [1, 1, 1];
  const bindMatrix = composeMat4(bindPos, bindRot, bindScale);
  const ibm = invertMat4(bindMatrix);
  return {
    name,
    parentIndex,
    childrenIndices: [],
    bindPosition: bindPos,
    bindRotation: bindRot,
    bindScale,
    inverseBindMatrix: ibm,
  };
}

function composeMat4(pos: [number, number, number], rot: [number, number, number, number], scale: [number, number, number]): Float32Array {
  const out = new Float32Array(16);
  const x = rot[0], y = rot[1], z = rot[2], w = rot[3];
  out[0] = (1 - 2 * (y * y + z * z)) * scale[0];
  out[1] = 2 * (x * y + w * z) * scale[0];
  out[2] = 2 * (x * z - w * y) * scale[0];
  out[3] = 0;
  out[4] = 2 * (x * y - w * z) * scale[1];
  out[5] = (1 - 2 * (x * x + z * z)) * scale[1];
  out[6] = 2 * (y * z + w * x) * scale[1];
  out[7] = 0;
  out[8] = 2 * (x * z + w * y) * scale[2];
  out[9] = 2 * (y * z - w * x) * scale[2];
  out[10] = (1 - 2 * (x * x + y * y)) * scale[2];
  out[11] = 0;
  out[12] = pos[0];
  out[13] = pos[1];
  out[14] = pos[2];
  out[15] = 1;
  return out;
}

function invertMat4(m: Float32Array): Float32Array {
  const out = new Float32Array(16);
  const inv = new Float32Array(16);
  inv[0] = m[0]; inv[1] = m[4]; inv[2] = m[8]; inv[3] = m[12];
  inv[4] = m[1]; inv[5] = m[5]; inv[6] = m[9]; inv[7] = m[13];
  inv[8] = m[2]; inv[9] = m[6]; inv[10] = m[10]; inv[11] = m[14];
  inv[12] = m[3]; inv[13] = m[7]; inv[14] = m[11]; inv[15] = m[15];
  for (let i = 0; i < 16; i++) out[i] = inv[i];
  return out;
}

function makeIdentityTransform() {
  return { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] };
}

describe("Skeleton", () => {
  it("computes skin matrices with identity bind pose", () => {
    const bones: Bone[] = [
      makeBone("root", -1, [0, 0, 0]),
      makeBone("child", 0, [1, 0, 0]),
    ];
    bones[0].childrenIndices = [1];

    const data: SkeletonData = { bones, name: "test", rootBoneIndex: 0 };
    const skeleton = new Skeleton(data);
    const transforms = [makeIdentityTransform(), makeIdentityTransform()];

    const matrices = skeleton.computeSkinMatrices(transforms);
    expect(matrices.length).toBe(2 * 16);
    expect(matrices[0]).toBeCloseTo(1, 5);
    expect(matrices[5]).toBeCloseTo(1, 5);
    expect(matrices[10]).toBeCloseTo(1, 5);
    expect(matrices[15]).toBeCloseTo(1, 5);
  });

  it("returns bind pose with identity transforms", () => {
    const bones: Bone[] = [makeBone("root", -1, [0, 1, 0])];
    const data: SkeletonData = { bones, name: "bind_test", rootBoneIndex: 0 };
    const skeleton = new Skeleton(data);
    const pose = skeleton.getBindPose();
    expect(pose.length).toBe(1);
    expect(pose[0].position).toEqual([0, 1, 0]);
    expect(pose[0].rotation).toEqual([0, 0, 0, 1]);
    expect(pose[0].scale).toEqual([1, 1, 1]);
  });

  it("handles hierarchical bone transforms", () => {
    const bones: Bone[] = [
      makeBone("root", -1, [0, 0, 0]),
      makeBone("child", 0, [1, 0, 0]),
      makeBone("grandchild", 1, [1, 0, 0]),
    ];
    bones[0].childrenIndices = [1];
    bones[1].childrenIndices = [2];
    const data: SkeletonData = { bones, name: "hierarchy", rootBoneIndex: 0 };
    const skeleton = new Skeleton(data);
    expect(skeleton.data.bones.length).toBe(3);
    expect(skeleton.data.bones[2].parentIndex).toBe(1);
  });
});
