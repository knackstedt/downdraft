struct ScreenUniforms {
  screenSize: vec2<f32>,
  _pad: vec2<f32>,
};
@group(0) @binding(0) var<uniform> screen: ScreenUniforms;

struct QuadVertexInput {
  @location(0) position: vec2<f32>,
  @location(1) size: vec2<f32>,
  @location(2) color: vec4<f32>,
  @location(3) borderRadius: f32,
  @location(4) borderWidth: f32,
  @location(5) borderColor: vec4<f32>,
  @location(6) localOffset: vec2<f32>,
};

struct QuadVertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) localPos: vec2<f32>,
  @location(1) size: vec2<f32>,
  @location(2) color: vec4<f32>,
  @location(3) borderRadius: f32,
  @location(4) borderWidth: f32,
  @location(5) borderColor: vec4<f32>,
};

@vertex
fn vs_main(input: QuadVertexInput) -> QuadVertexOutput {
  var output: QuadVertexOutput;
  let ndcX = (input.position.x / screen.screenSize.x) * 2.0 - 1.0;
  let ndcY = 1.0 - (input.position.y / screen.screenSize.y) * 2.0;
  output.clipPosition = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
  output.localPos = input.localOffset;
  output.size = input.size;
  output.color = input.color;
  output.borderRadius = input.borderRadius;
  output.borderWidth = input.borderWidth;
  output.borderColor = input.borderColor;
  return output;
}

fn sdfRoundedBox(p: vec2<f32>, halfSize: vec2<f32>, radius: f32) -> f32 {
  let q = abs(p) - halfSize + vec2<f32>(radius, radius);
  return length(max(q, vec2<f32>(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

@fragment
fn fs_main(input: QuadVertexOutput) -> @location(0) vec4<f32> {
  let center = input.size * 0.5;
  let p = input.localPos - center;
  let halfSize = input.size * 0.5;
  let dist = sdfRoundedBox(p, halfSize, input.borderRadius);

  if (dist > 0.0) {
    discard;
  }

  var color = input.color;

  if (input.borderWidth > 0.0) {
    let borderDist = sdfRoundedBox(p, halfSize - vec2<f32>(input.borderWidth, input.borderWidth), max(input.borderRadius - input.borderWidth, 0.0));
    if (borderDist > 0.0) {
      color = input.borderColor;
    }
  }

  return color;
}
