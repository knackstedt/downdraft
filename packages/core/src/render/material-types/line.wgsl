// Line material — line rendering with width, color, optional dashed pattern
// Forward-rendered

struct LineUniforms {
  color: vec4<f32>,
  lineWidth: f32,
  dashScale: f32,
  dashSize: f32,
  gapSize: f32,
};

struct CameraUniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> line: LineUniforms;
@group(0) @binding(1) var<uniform> camera: CameraUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.clipPosition = camera.viewProj * vec4<f32>(input.position, 1.0);
  output.uv = input.uv;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (line.dashSize > 0.0) {
    let dashPos = fract(input.uv.x * line.dashScale);
    let dashPattern = step(dashPos, line.dashSize / (line.dashSize + line.gapSize));
    if (dashPattern < 0.5) {
      discard;
    }
  }
  return line.color;
}
