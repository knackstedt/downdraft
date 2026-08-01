// MAX_BONES = 128 (from @shared/constants)
struct Uniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  time: f32,
  entityPos: vec3<f32>,
  entityScale: f32,
  entityRot: vec4<f32>,
  entityType: u32,
  entityFlags: u32,
  wetness: f32,
  _pad3: f32,
  sunDirIntensity: vec4<f32>,
  ambientParams: vec4<f32>,
  fogColor: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var playerSampler: sampler;
@group(0) @binding(2) var playerTexture: texture_2d<f32>;

@group(0) @binding(3) var<storage, read> boneMatrices: array<mat4x4<f32>, 128>;

struct VertexInput {
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

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  // Skin the vertex position and normal
  let skinMat =
    boneMatrices[input.joints.x] * input.weights.x +
    boneMatrices[input.joints.y] * input.weights.y +
    boneMatrices[input.joints.z] * input.weights.z +
    boneMatrices[input.joints.w] * input.weights.w;

  let skinnedPos = (skinMat * vec4<f32>(input.position, 1.0)).xyz;
  let skinnedNormal = mat3x3<f32>(
    skinMat[0].xyz,
    skinMat[1].xyz,
    skinMat[2].xyz,
  ) * input.normal;

  // Apply entity transform (scale, rotate, translate)
  let scaled = skinnedPos * uniforms.entityScale;
  let rotated = qrotate(uniforms.entityRot, scaled);
  let worldPos = rotated + uniforms.entityPos;
  output.worldPos = worldPos;
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  output.normal = normalize(qrotate(uniforms.entityRot, normalize(skinnedNormal)));
  output.uv = input.uv;
  output.color = input.color;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let N = normalize(input.normal);
  let texColor = textureSample(playerTexture, playerSampler, input.uv);
  var color = entityLighting(N, input.worldPos, texColor.rgb * input.color);
  return vec4<f32>(color, 1.0);
}
