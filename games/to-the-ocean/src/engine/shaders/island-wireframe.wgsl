struct IslandWireframeUniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  time: f32,
  entityPos: vec3<f32>,
  entityScale: f32,
  entityRot: vec4<f32>,
  entityType: u32,
  _pad: f32,
  _pad2: f32,
  _pad3: f32,
  sunDirIntensity: vec4<f32>,
  ambientParams: vec4<f32>,
  fogColor: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: IslandWireframeUniforms;

struct WireframeVertexInput {
  @location(0) position: vec3<f32>,
};

struct WireframeVertexOutput {
  @builtin(position) clipPos: vec4<f32>,
};

fn qrotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

@vertex
fn vs_main(input: WireframeVertexInput) -> WireframeVertexOutput {
  var output: WireframeVertexOutput;
  let scaled = input.position * uniforms.entityScale;
  let rotated = qrotate(uniforms.entityRot, scaled);
  let worldPos = rotated + uniforms.entityPos;
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  return output;
}

@fragment
fn fs_main(input: WireframeVertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(0.0, 1.0, 0.2, 1.0);
}
