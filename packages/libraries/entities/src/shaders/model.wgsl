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
  // Per-draw highlight mode: 0 = normal shading, 1 = ghost hologram (cyan,
  // used for the physgun's no-collision grab), 2 = hover outline (drawn by a
  // separate inverted-hull pipeline — see vs_outline / fs_outline).
  highlight: f32,
  // Inverted-hull outline parameters (used by vs_outline / fs_outline only).
  outlineWidth: f32,
  outlineColor: vec3<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

// Skin matrices for skinned meshes (@group(1)). A dynamic storage buffer of
// mat4x4<f32>, one per bone. Updated per-frame by the renderer via
// updateSkinMatrices(). Only bound when drawing skinned meshes.
@group(1) @binding(0) var<storage, read> skinMatrices: array<mat4x4<f32>>;

// Frame-global lighting (@group(2)): sun color, hemisphere ambient, point lights.
// Games that want colored lighting provide a compatible uniform buffer; the
// default bind group supplies a neutral white sun + no point lights so existing
// consumers see no visual change.
struct FrameLighting {
  sunDir: vec3<f32>,
  ambientIntensity: f32,
  sunColor: vec3<f32>,
  pointLightCount: u32,
  skyAmbient: vec3<f32>,
  _pad0: u32,
  groundAmbient: vec3<f32>,
  _pad1: u32,
  pointLights: array<vec4<f32>, 16>,
};
@group(2) @binding(0) var<uniform> frameLighting: FrameLighting;

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

// Build a tangent basis from screen-space derivatives (fallback when the
// mesh has no explicit tangent attribute). Returns (T, B, N).
fn buildTangentBasis(N: vec3<f32>, worldPos: vec4<f32>, uv: vec2<f32>) -> mat3x3<f32> {
  let dpdx_val = dpdx(worldPos.xyz);
  let dpdy_val = dpdy(worldPos.xyz);
  let duvdx = dpdx(vec3<f32>(uv, 0.0)).xy;
  let duvdy = dpdy(vec3<f32>(uv, 0.0)).xy;
  let r = 1.0 / (duvdx.x * duvdy.y - duvdx.y * duvdy.x);
  let T = normalize((dpdx_val * duvdy.y - dpdy_val * duvdx.y) * r);
  let B = normalize((dpdy_val * duvdx.x - dpdx_val * duvdy.x) * r);
  // Re-orthogonalize T and B against N (Gram-Schmidt)
  let tOrtho = normalize(T - N * dot(N, T));
  let bOrtho = normalize(B - N * dot(N, B) - tOrtho * dot(tOrtho, B));
  return mat3x3<f32>(tOrtho, bOrtho, N);
}

// Sample the normal map and perturb the geometric normal. Returns the
// perturbed world-space normal. If the material has no normal map (normalTex
// points at the default white texture), the sampled tangent-space normal is
// (0.5, 0.5, 1.0) → unpacked to (0, 0, 1) → no perturbation.
fn perturbNormal(N: vec3<f32>, worldPos: vec4<f32>, uv: vec2<f32>, normalTexHandle: u32) -> vec3<f32> {
  let arr = unpackArrayIndex(normalTexHandle);
  let layer = unpackLayerIndex(normalTexHandle);
  let sampled = sampleBindlessArray(arr, uv, layer);
  let tangentNormal = sampled.xyz * 2.0 - 1.0;
  let basis = buildTangentBasis(N, worldPos, uv);
  return normalize(basis * tangentNormal);
}

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
  let geometricN = normalize(input.normal);

  // Bindless material lookup (needed for normal map handle + albedo).
  let m = bindlessMaterials[uniforms.materialIndex];

  // Perturb the normal using the material's normal map (if any). Materials
  // without a normal map use the default white texture → no perturbation.
  let N = perturbNormal(geometricN, vec4<f32>(input.worldPos, 1.0), input.uv, m.normalTex);

  // Colored directional sun light from the frame-lighting UBO. Fall back to
  // the per-draw lightDir/ambient/intensity (set via setLightState) for the
  // directional *direction* and a baseline ambient — this keeps backward
  // compatibility for callers that only use setLightState() — while the
  // frame-lighting UBO tints the sun and adds hemisphere ambient + point lights.
  let perDrawDir = normalize(vec3<f32>(uniforms.lightDirX, uniforms.lightDirY, uniforms.lightDirZ));
  let frameDir = normalize(frameLighting.sunDir);
  let sunDir = frameDir;
  let ndotl = max(dot(N, sunDir), 0.0);
  let sunDiffuse = ndotl * frameLighting.sunColor * uniforms.lightIntensity;

  // Hemisphere ambient: blend sky/ground based on normal.y. Scaled by the
  // frame-lighting ambientIntensity and the per-draw ambient baseline.
  let hemiMix = N.y * 0.5 + 0.5;
  let hemisphere = mix(frameLighting.groundAmbient, frameLighting.skyAmbient, hemiMix);
  let ambient = hemisphere * frameLighting.ambientIntensity + uniforms.lightAmbient * 0.35;

  // Bindless albedo sample: index the material SSBO by materialIndex, then
  // sample the texture_2d_array page/layer the material points at.
  let arr = unpackArrayIndex(m.albedoTex);
  let layer = unpackLayerIndex(m.albedoTex);
  let texColor = sampleBindlessArray(arr, input.uv, layer);

  // All inputs are sRGB: texture (rgba8unorm), vertex color (white), and
  // baseColor (parser converts FBX linear DiffuseColor to sRGB). The swapchain
  // is non-sRGB (bgra8unorm), so output sRGB directly.
  let baseColor = texColor.rgb * input.color * m.baseColor.rgb;
  var litColor = baseColor * (ambient + sunDiffuse);

  // Point lights (up to 8). Each light is 2 vec4s: (pos.xyz, radius) + (color.rgb, intensity).
  let plCount = frameLighting.pointLightCount;
  for (var i = 0u; i < plCount; i++) {
    let pl0 = frameLighting.pointLights[i * 2u];
    let pl1 = frameLighting.pointLights[i * 2u + 1u];
    let plPos = pl0.xyz;
    let plRadius = pl0.w;
    let plColor = pl1.xyz;
    let plIntensity = pl1.w;
    let L = plPos - input.worldPos;
    let dist = length(L);
    if (dist < plRadius) {
      let atten = 1.0 / (1.0 + dist * dist / (plRadius * plRadius));
      let ndotl_pl = max(dot(N, normalize(L)), 0.0);
      litColor += baseColor * plColor * plIntensity * atten * ndotl_pl;
    }
  }

  // Distance fog — tint toward sky ambient so it matches the procedural scene.
  let dist = length(uniforms.cameraPos - input.worldPos);
  let fogFactor = min(dist / 1000.0, 1.0);
  litColor = mix(litColor, frameLighting.skyAmbient, fogFactor);

  // Ghost hologram override (highlight == 1): render the prop as a
  // translucent-looking cyan shell with a fresnel rim and a vertical
  // scanline pulse so it's visually distinct from normally-grabbed (solid)
  // props. Opaque output (the pipeline has no blend state) but reads as a
  // hologram. Hover outline (highlight == 2) is handled by a separate
  // inverted-hull draw — see vs_outline / fs_outline below.
  if (uniforms.highlight > 0.5 && uniforms.highlight < 1.5) {
    let viewDir = normalize(uniforms.cameraPos - input.worldPos);
    let fresnel = pow(1.0 - max(dot(N, viewDir), 0.0), 2.5);
    let pulse = 0.65 + 0.35 * sin(uniforms.time * 5.0 + input.worldPos.y * 3.0);
    let scan = 0.5 + 0.5 * sin((input.worldPos.y + uniforms.time * 2.0) * 20.0);
    let ghostBase = vec3<f32>(0.15, 0.75, 0.95);
    let ghostRim = vec3<f32>(0.7, 1.0, 1.0);
    var ghostCol = mix(ghostBase, ghostRim, fresnel) * pulse;
    ghostCol = ghostCol + ghostRim * scan * 0.15 * fresnel;
    return vec4<f32>(ghostCol, 1.0);
  }

  return vec4<f32>(litColor, 1.0);
}

// ── Mask entry point for post-process outline ──
// Renders the model as solid white to a mask texture.  Uses the same
// vertex shader as the normal render (vs_main / vs_skinned).
@fragment
fn fs_mask() -> @location(0) vec4f {
  return vec4f(1.0, 1.0, 1.0, 1.0);
}
