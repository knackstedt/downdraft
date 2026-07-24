// Shadow map pass — depth-only from directional light perspective

struct CameraUniforms {
  lightViewProj: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var modelUniform: mat4x4<f32>;

struct VertexInput {
  @location(0) position: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = modelUniform * vec4<f32>(input.position, 1.0);
  output.clipPosition = camera.lightViewProj * worldPos;
  return output;
}
