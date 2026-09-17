// wgsl-validate: prelude ./light-structs.wgsl
// wgsl-validate: prelude ./pbr-functions.wgsl
// wgsl-validate: prelude ./ibl-bindings.wgsl
// wgsl-validate: prelude ./lighting-fn.wgsl
struct BoatUniforms {
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

@group(0) @binding(0) var<uniform> uniforms: BoatUniforms;

struct BoatVertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) cellColor: vec3<f32>,
};

struct BoatVertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec3<f32>,
};

fn qrotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

@vertex
fn vs_main(input: BoatVertexInput) -> BoatVertexOutput {
  var output: BoatVertexOutput;
  let scaled = input.position * uniforms.entityScale;
  let rotated = qrotate(uniforms.entityRot, scaled);
  let worldPos = rotated + uniforms.entityPos;
  output.worldPos = worldPos;
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  output.normal = normalize(qrotate(uniforms.entityRot, input.normal));
  output.color = input.cellColor;
  return output;
}

@fragment
fn fs_main(input: BoatVertexOutput) -> @location(0) vec4<f32> {
  let N = normalize(input.normal);
  var color = entityLighting(N, input.worldPos, input.color);
  return vec4<f32>(color, 1.0);
}
