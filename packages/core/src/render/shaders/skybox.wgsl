// Skybox render pass — renders a fullscreen gradient or cubemap

struct CameraUniforms {
  viewProj: mat4x4<f32>,
  invViewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  _pad0: f32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var skyboxTex: texture_cube<f32>;
@group(0) @binding(2) var skyboxSampler: sampler;

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) direction: vec3<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  let positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0),
  );
  let pos = positions[vi];
  var output: VertexOutput;
  output.clipPosition = vec4<f32>(pos, 1.0, 1.0);
  let ndc = vec3<f32>(pos, 1.0);
  let worldDir = camera.invViewProj * vec4<f32>(ndc, 1.0);
  output.direction = normalize(worldDir.xyz / worldDir.w - camera.cameraPos);
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let color = textureSample(skyboxTex, skyboxSampler, input.direction);
  return vec4<f32>(color.rgb, 1.0);
}
