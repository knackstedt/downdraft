import type { Bone, SkeletonData } from "./skeleton";
import { Skeleton } from "./skeleton";

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
  // Correct column-major 4x4 inverse (adjugate / det)
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
  const out = new Float32Array(16);
  out[0]=b00*det; out[1]=b01*det; out[2]=b02*det; out[3]=b03*det;
  out[4]=b10*det; out[5]=b11*det; out[6]=b12*det; out[7]=b13*det;
  out[8]=b20*det; out[9]=b21*det; out[10]=b22*det; out[11]=b23*det;
  out[12]=b30*det; out[13]=b31*det; out[14]=b32*det; out[15]=b33*det;
  return out;
}

/** Column-major matrix multiply: A * B */
function matMul(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[i * 4 + j] =
        a[0 * 4 + j] * b[i * 4 + 0] +
        a[1 * 4 + j] * b[i * 4 + 1] +
        a[2 * 4 + j] * b[i * 4 + 2] +
        a[3 * 4 + j] * b[i * 4 + 3];
    }
  }
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

  it("produces identity skin matrices at bind pose with rotated hierarchy", () => {
    // Root has 90° Z rotation; child is at (1,0,0) in root's local space.
    // IBMs are world-space (as provided by FBX/glTF cluster data).
    // At bind pose, skinMatrix = boneWorld * IBM must be identity for all bones.
    const halfRoot2 = Math.sqrt(0.5);
    const rootLocal = composeMat4([0, 0, 0], [0, 0, halfRoot2, halfRoot2], [1, 1, 1]);
    const childLocal = composeMat4([1, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
    // Compute child world matrix: parent * local
    const childWorld = matMul(rootLocal, childLocal);

    const bones: Bone[] = [
      {
        name: "root", parentIndex: -1, childrenIndices: [1],
        bindPosition: [0, 0, 0],
        bindRotation: [0, 0, halfRoot2, halfRoot2],
        bindScale: [1, 1, 1],
        inverseBindMatrix: invertMat4(rootLocal),
      },
      {
        name: "child", parentIndex: 0, childrenIndices: [],
        bindPosition: [1, 0, 0],
        bindRotation: [0, 0, 0, 1],
        bindScale: [1, 1, 1],
        inverseBindMatrix: invertMat4(childWorld),
      },
    ];
    const data: SkeletonData = { bones, name: "rot_bind", rootBoneIndex: 0 };
    const skeleton = new Skeleton(data);
    const mats = skeleton.computeSkinMatrices(skeleton.getBindPose());

    // Both skin matrices should be identity
    for (let b = 0; b < 2; b++) {
      const off = b * 16;
      for (let i = 0; i < 16; i++) {
        const expected = (i % 5 === 0) ? 1 : 0;
        expect(Math.abs(mats[off + i] - expected)).toBeLessThan(1e-5);
      }
    }
  });

  it("produces identity skin matrices at bind pose with translation + rotation", () => {
    const halfRoot2 = Math.sqrt(0.5);
    const rootLocal = composeMat4([5, 3, 0], [0, 0, halfRoot2, halfRoot2], [1, 1, 1]);
    const childLocal = composeMat4([1, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
    const childWorld = matMul(rootLocal, childLocal);

    const bones: Bone[] = [
      {
        name: "root", parentIndex: -1, childrenIndices: [1],
        bindPosition: [5, 3, 0],
        bindRotation: [0, 0, halfRoot2, halfRoot2],
        bindScale: [1, 1, 1],
        inverseBindMatrix: invertMat4(rootLocal),
      },
      {
        name: "child", parentIndex: 0, childrenIndices: [],
        bindPosition: [1, 0, 0],
        bindRotation: [0, 0, 0, 1],
        bindScale: [1, 1, 1],
        inverseBindMatrix: invertMat4(childWorld),
      },
    ];
    const data: SkeletonData = { bones, name: "trans_rot_bind", rootBoneIndex: 0 };
    const skeleton = new Skeleton(data);
    const mats = skeleton.computeSkinMatrices(skeleton.getBindPose());

    for (let b = 0; b < 2; b++) {
      const off = b * 16;
      for (let i = 0; i < 16; i++) {
        const expected = (i % 5 === 0) ? 1 : 0;
        expect(Math.abs(mats[off + i] - expected)).toBeLessThan(1e-5);
      }
    }
  });
});
