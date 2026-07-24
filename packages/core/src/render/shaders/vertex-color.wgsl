struct CameraUniforms {
  viewProj: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) normal: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.clipPosition = camera.viewProj * vec4<f32>(input.position, 1.0);
  output.color = input.color;
  output.normal = input.normal;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  // Simple directional lighting + vertex color
  let lightDir = normalize(vec3<f32>(0.5, 0.8, 0.3));
  let lambert = max(dot(normalize(input.normal), lightDir), 0.0);
  let ambient = 0.3;
  let intensity = ambient + lambert * 0.7;
  return vec4<f32>(input.color.rgb * intensity, input.color.a);
}
