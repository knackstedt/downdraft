import type { WgslStruct } from "@downdraft/engine/shader-graph";
import { mat4x4f, vec4f, wgsl } from "@downdraft/engine/shader-graph";

export const MAX_BONES_VS = 256;
export const MAX_BONE_INFLUENCES = 8;

const BoneTransforms: WgslStruct = wgsl.struct("BoneTransforms", {
  transforms: wgsl.array(vec4f, MAX_BONES_VS * 3),
});

const InverseBindMatrices: WgslStruct = wgsl.struct("InverseBindMatrices", {
  matrices: wgsl.array(mat4x4f, MAX_BONES_VS),
});

export const SKINNING_VS_GLSL = `
uniform vec4 uBoneTransforms[${256}];
uniform mat4 uInverseBindMatrices[${256}];
uniform int uBoneCount;

mat4 composeMat4(vec3 pos, vec4 rot, vec3 scale) {
  vec4 nq = normalize(rot);
  float xx = nq.x * nq.x;
  float yy = nq.y * nq.y;
  float zz = nq.z * nq.z;
  float xy = nq.x * nq.y;
  float xz = nq.x * nq.z;
  float yz = nq.y * nq.z;
  float wx = nq.w * nq.x;
  float wy = nq.w * nq.y;
  float wz = nq.w * nq.z;

  mat4 m = mat4(1.0);
  m[0] = vec4((1.0 - 2.0 * (yy + zz)) * scale.x, (2.0 * (xy + wz)) * scale.x, (2.0 * (xz - wy)) * scale.x, 0.0);
  m[1] = vec4((2.0 * (xy - wz)) * scale.y, (1.0 - 2.0 * (xx + zz)) * scale.y, (2.0 * (yz + wx)) * scale.y, 0.0);
  m[2] = vec4((2.0 * (xz + wy)) * scale.z, (2.0 * (yz - wx)) * scale.z, (1.0 - 2.0 * (xx + yy)) * scale.z, 0.0);
  m[3] = vec4(pos.x, pos.y, pos.z, 1.0);
  return m;
}

mat4 computeSkinMatrixVS(vec4 boneIndices, vec4 boneWeights) {
  mat4 skinMatrix = mat4(0.0);
  for (int i = 0; i < 4; i++) {
    int boneIdx = int(boneIndices[i]);
    if (boneIdx < 0 || boneIdx >= uBoneCount) continue;
    vec4 bonePosRot0 = uBoneTransforms[boneIdx * 3];
    vec4 boneRot1Scale0 = uBoneTransforms[boneIdx * 3 + 1];
    vec4 boneScale1Pad = uBoneTransforms[boneIdx * 3 + 2];
    vec3 bPos = bonePosRot0.xyz;
    vec4 bRot = vec4(bonePosRot0.w, boneRot1Scale0.xy);
    vec3 bScale = vec4(boneRot1Scale0.zw, boneScale1Pad.xy).xyz;
    mat4 localMat = composeMat4(bPos, bRot, bScale);
    mat4 skinMat = localMat * uInverseBindMatrices[boneIdx];
    skinMatrix += skinMat * boneWeights[i];
  }
  return skinMatrix;
}
`;

export const SKINNING_VS_WGSL = `
${BoneTransforms.wgsl}

${InverseBindMatrices.wgsl}

@group(2) @binding(0) var<uniform> boneTransforms: BoneTransforms;
@group(2) @binding(1) var<uniform> inverseBindMatrices: InverseBindMatrices;
@group(2) @binding(2) var<uniform> boneCount: u32;

fn composeMat4VS(pos: vec3<f32>, rot: vec4<f32>, scale: vec3<f32>) -> mat4x4<f32> {
  let nq = normalize(rot);
  let xx = nq.x * nq.x;
  let yy = nq.y * nq.y;
  let zz = nq.z * nq.z;
  let xy = nq.x * nq.y;
  let xz = nq.x * nq.z;
  let yz = nq.y * nq.z;
  let wx = nq.w * nq.x;
  let wy = nq.w * nq.y;
  let wz = nq.w * nq.z;

  var m: mat4x4<f32>;
  m[0] = vec4<f32>((1.0 - 2.0 * (yy + zz)) * scale.x, (2.0 * (xy + wz)) * scale.x, (2.0 * (xz - wy)) * scale.x, 0.0);
  m[1] = vec4<f32>((2.0 * (xy - wz)) * scale.y, (1.0 - 2.0 * (xx + zz)) * scale.y, (2.0 * (yz + wx)) * scale.y, 0.0);
  m[2] = vec4<f32>((2.0 * (xz + wy)) * scale.z, (2.0 * (yz - wx)) * scale.z, (1.0 - 2.0 * (xx + yy)) * scale.z, 0.0);
  m[3] = vec4<f32>(pos.x, pos.y, pos.z, 1.0);
  return m;
}

fn computeSkinMatrixVS(boneIndices: vec4<u32>, boneWeights: vec4<f32>) -> mat4x4<f32> {
  var skinMatrix: mat4x4<f32> = mat4x4<f32>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  for (var i: u32 = 0u; i < 4u; i++) {
    let boneIdx = boneIndices[i];
    if boneIdx >= boneCount { continue; }
    let posRot0 = boneTransforms.transforms[boneIdx * 3u];
    let rot1Scale0 = boneTransforms.transforms[boneIdx * 3u + 1u];
    let scale1Pad = boneTransforms.transforms[boneIdx * 3u + 2u];
    let bPos = vec3<f32>(posRot0.xyz);
    let bRot = vec4<f32>(posRot0.w, rot1Scale0.xy);
    let bScale = vec3<f32>(rot1Scale0.zw, scale1Pad.xy);
    let localMat = composeMat4VS(bPos, bRot, bScale);
    let skinMat = localMat * inverseBindMatrices.matrices[boneIdx];
    skinMatrix += skinMat * boneWeights[i];
  }
  return skinMatrix;
}
`;

export type SkinningMode = "compute" | "vertex";

export interface SkinningPass {
  mode: SkinningMode;
  updateBoneTransforms(transforms: Float32Array): void;
  updateInverseBindMatrices(matrices: Float32Array): void;
  updateBoneCount(count: number): void;
  destroy(): void;
}

export function createSkinningPass(
  hasCompute: boolean,
): SkinningMode {
  return hasCompute ? "compute" : "vertex";
}
