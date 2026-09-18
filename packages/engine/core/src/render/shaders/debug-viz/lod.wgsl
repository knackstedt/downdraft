struct CameraUniforms {
  viewProj: mat4x4<f32>,
  _pad0: vec4<f32>,
};

struct LodUniforms {
  level: f32,
  _pad: vec3<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<uniform> lod: LodUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) vLevel: f32,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.clipPosition = camera.viewProj * vec4<f32>(input.position, 1.0);
  output.vLevel = lod.level;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let l = input.vLevel;
  if (l < 0.5) { return vec4<f32>(0.0, 1.0, 0.0, 1.0); }
  if (l < 1.5) { return vec4<f32>(1.0, 1.0, 0.0, 1.0); }
  if (l < 2.5) { return vec4<f32>(1.0, 0.5, 0.0, 1.0); }
  return vec4<f32>(1.0, 0.0, 0.0, 1.0);
}
