const MAX_CHAIN_LEN: u32 = 32u;

struct SkinningUniforms {
  boneCount: u32,
  hasNormalization: u32,
  _pad0: u32,
  _pad1: u32,
  normMatrix: mat4x4<f32>,
  invNormMatrix: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> skinUniforms: SkinningUniforms;
@group(0) @binding(1) var<storage, read> localPos: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> localRot: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> localScale: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> parentIndices: array<i32>;
@group(0) @binding(5) var<storage, read> inverseBindMatrices: array<mat4x4<f32>>;
@group(0) @binding(6) var<storage, read_write> skinMatrices: array<mat4x4<f32>>;

fn buildLocalMatrix(pos: vec4<f32>, rot: vec4<f32>, scale: vec4<f32>) -> mat4x4<f32> {
  let x = rot.x; let y = rot.y; let z = rot.z; let w = rot.w;
  let x2 = x + x; let y2 = y + y; let z2 = z + z;
  let xx = x * x2; let xy = x * y2; let xz = x * z2;
  let yy = y * y2; let yz = y * z2; let zz = z * z2;
  let wx = w * x2; let wy = w * y2; let wz = w * z2;
  let sx = scale.x; let sy = scale.y; let sz = scale.z;
  let px = pos.x; let py = pos.y; let pz = pos.z;

  return mat4x4<f32>(
    vec4<f32>((1.0 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0.0),
    vec4<f32>((xy - wz) * sy, (1.0 - (xx + zz)) * sy, (yz + wx) * sy, 0.0),
    vec4<f32>((xz + wy) * sz, (yz - wx) * sz, (1.0 - (xx + yy)) * sz, 0.0),
    vec4<f32>(px, py, pz, 1.0),
  );
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let boneIdx = gid.x;
  if (boneIdx >= skinUniforms.boneCount) { return; }

  // Build chain from root to this bone by following parent indices upward
  var chain: array<u32, MAX_CHAIN_LEN>;
  var chainLen: u32 = 0u;
  var idx: i32 = i32(boneIdx);
  while (idx >= 0 && chainLen < MAX_CHAIN_LEN) {
    chain[chainLen] = u32(idx);
    chainLen++;
    idx = parentIndices[idx];
  }

  // Accumulate world matrix from root to this bone
  var worldMat = mat4x4<f32>(
    1.0, 0.0, 0.0, 0.0,
    0.0, 1.0, 0.0, 0.0,
    0.0, 0.0, 1.0, 0.0,
    0.0, 0.0, 0.0, 1.0,
  );
  for (var c = chainLen; c > 0u; c--) {
    let bi = chain[c - 1u];
    let localMat = buildLocalMatrix(localPos[bi], localRot[bi], localScale[bi]);
    worldMat = worldMat * localMat;
  }

  // Compute skinning matrix: world * inverseBind
  let skinMat = worldMat * inverseBindMatrices[boneIdx];

  // Apply normalization if enabled: N * (world * IBM) * N^-1
  if (skinUniforms.hasNormalization == 1u) {
    skinMatrices[boneIdx] = skinUniforms.normMatrix * (skinMat * skinUniforms.invNormMatrix);
  } else {
    skinMatrices[boneIdx] = skinMat;
  }
}
