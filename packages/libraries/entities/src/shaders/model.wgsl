struct Uniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  time: f32,
  modelPos: vec3<f32>,
  modelScale: vec3<f32>,
  modelRot: vec4<f32>,
  materialIndex: u32,
  lightDirX: f32,
  lightDirY: f32,
  lightDirZ: f32,
  lightAmbient: f32,
  lightIntensity: f32,
  _pad6: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

// Skin matrices for skinned meshes (@group(1)). A dynamic storage buffer of
// mat4x4<f32>, one per bone. Updated per-frame by the renderer via
// updateSkinMatrices(). Only bound when drawing skinned meshes.
@group(1) @binding(0) var<storage, read> skinMatrices: array<mat4x4<f32>>;

// Bindless material binding model (@group(3)):
//   binding 0: material SSBO (read-only storage)
//   bindings 1..8: texture_2d_array pages (rgba8unorm color textures)
//   binding 9: shared sampler (repeat)
//   binding 10: shared sampler (clamp)
struct BindlessMaterial {
  baseColor: vec4<f32>,
  roughness: f32,
  metallic: f32,
  emissiveIntensity: f32,
  hasTexTransform: f32,
  albedoTex: u32,
  normalTex: u32,
  metallicRoughnessTex: u32,
  aoEmissiveTex: u32,
  texOffset: vec2<f32>,
  texScale: vec2<f32>,
  texRotation: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(3) @binding(0) var<storage, read> bindlessMaterials: array<BindlessMaterial>;
@group(3) @binding(1) var albedoArray0: texture_2d_array<f32>;
@group(3) @binding(2) var albedoArray1: texture_2d_array<f32>;
@group(3) @binding(3) var albedoArray2: texture_2d_array<f32>;
@group(3) @binding(4) var albedoArray3: texture_2d_array<f32>;
@group(3) @binding(5) var albedoArray4: texture_2d_array<f32>;
@group(3) @binding(6) var albedoArray5: texture_2d_array<f32>;
@group(3) @binding(7) var albedoArray6: texture_2d_array<f32>;
@group(3) @binding(8) var albedoArray7: texture_2d_array<f32>;
@group(3) @binding(9) var bindlessSamplerRepeat: sampler;
@group(3) @binding(10) var bindlessSamplerClamp: sampler;

fn unpackArrayIndex(handle: u32) -> u32 { return (handle >> 16u) & 0xFFFFu; }
fn unpackLayerIndex(handle: u32) -> u32 { return handle & 0xFFFFu; }

fn sampleBindlessArray(arr: u32, uv: vec2<f32>, layer: u32) -> vec4<f32> {
  switch (arr) {
    case 0u: { return textureSample(albedoArray0, bindlessSamplerRepeat, uv, layer); }
    case 1u: { return textureSample(albedoArray1, bindlessSamplerRepeat, uv, layer); }
    case 2u: { return textureSample(albedoArray2, bindlessSamplerRepeat, uv, layer); }
    case 3u: { return textureSample(albedoArray3, bindlessSamplerRepeat, uv, layer); }
    case 4u: { return textureSample(albedoArray4, bindlessSamplerRepeat, uv, layer); }
    case 5u: { return textureSample(albedoArray5, bindlessSamplerRepeat, uv, layer); }
    case 6u: { return textureSample(albedoArray6, bindlessSamplerRepeat, uv, layer); }
    case 7u: { return textureSample(albedoArray7, bindlessSamplerRepeat, uv, layer); }
    default: { return vec4<f32>(1.0, 1.0, 1.0, 1.0); }
  }
}

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec3<f32>,
};

// Skinned vertex input — extends VertexInput with joints (4 bone indices,
// packed as vec4<u32>) and weights (4 normalized bone weights). Lives in a
// second vertex buffer slot (buffer index 1).
struct SkinnedVertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec3<f32>,
  @location(4) joints: vec4<u32>,
  @location(5) weights: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec3<f32>,
};

fn qrotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

// Accumulate the 4-bone skinning matrix: sum(weights[i] * skinMatrices[joint[i]]).
// If all weights are zero (vertex has no bone assignment), return identity so
// the vertex renders at its baked position instead of collapsing to the origin.
fn skinMatrix(j: vec4<u32>, w: vec4<f32>) -> mat4x4<f32> {
  let m = skinMatrices[j.x] * w.x
        + skinMatrices[j.y] * w.y
        + skinMatrices[j.z] * w.z
        + skinMatrices[j.w] * w.w;
  let wsum = w.x + w.y + w.z + w.w;
  if (wsum < 0.001) {
    return mat4x4<f32>(
      vec4(1.0, 0.0, 0.0, 0.0),
      vec4(0.0, 1.0, 0.0, 0.0),
      vec4(0.0, 0.0, 1.0, 0.0),
      vec4(0.0, 0.0, 0.0, 1.0),
    );
  }
  return m;
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let scaled = input.position * uniforms.modelScale;
  let rotated = qrotate(uniforms.modelRot, scaled);
  let worldPos = rotated + uniforms.modelPos;
  output.worldPos = worldPos;
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  output.normal = normalize(qrotate(uniforms.modelRot, input.normal));
  output.uv = input.uv;
  output.color = input.color;
  return output;
}

// Skinned vertex entry point. Applies linear blend skinning in model space
// (skinMatrices already encode bone-world * inverseBind), then the same
// model transform (scale/rot/pos) as vs_main.
@vertex
fn vs_skinned(input: SkinnedVertexInput) -> VertexOutput {
  var output: VertexOutput;
  let sm = skinMatrix(input.joints, input.weights);
  let skinnedPos = (sm * vec4<f32>(input.position, 1.0)).xyz;
  let skinnedNormal = (sm * vec4<f32>(input.normal, 0.0)).xyz;

  let scaled = skinnedPos * uniforms.modelScale;
  let rotated = qrotate(uniforms.modelRot, scaled);
  let worldPos = rotated + uniforms.modelPos;
  output.worldPos = worldPos;
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  output.normal = normalize(qrotate(uniforms.modelRot, normalize(skinnedNormal)));
  output.uv = input.uv;
  output.color = input.color;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let lightDir = normalize(vec3<f32>(uniforms.lightDirX, uniforms.lightDirY, uniforms.lightDirZ));
  let ndotl = max(dot(normalize(input.normal), lightDir), 0.0);
  let lighting = uniforms.lightAmbient + ndotl * uniforms.lightIntensity;

  // Bindless albedo sample: index the material SSBO by materialIndex, then
  // sample the texture_2d_array page/layer the material points at.
  let m = bindlessMaterials[uniforms.materialIndex];
  let arr = unpackArrayIndex(m.albedoTex);
  let layer = unpackLayerIndex(m.albedoTex);
  let texColor = sampleBindlessArray(arr, input.uv, layer);

  // All inputs are sRGB: texture (rgba8unorm), vertex color (white), and
  // baseColor (parser converts FBX linear DiffuseColor to sRGB). The swapchain
  // is non-sRGB (bgra8unorm), so output sRGB directly.
  var color = texColor.rgb * input.color * lighting * m.baseColor.rgb;

  let dist = length(uniforms.cameraPos - input.worldPos);
  let fogFactor = min(dist / 1000.0, 1.0);
  color = mix(color, vec3<f32>(0.0, 0.1, 0.2), fogFactor);

  return vec4<f32>(color, 1.0);
}
