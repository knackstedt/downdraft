// wgsl-validate: prelude ./fullscreen-vs.wgsl
// wgsl-validate: prelude ./occluder-chunk.wgsl
// Halftone — dot/hex cell pattern for stylized print look.
// Renders a halftone screen: cells of variable-size dots, with dot size
// proportional to luminance. Supports rotation and monochrome/color modes.
struct U {
  texelSize: vec2<f32>,
  cellSize: f32,     // cell size in pixels (e.g. 8)
  dotScale: f32,     // dot size multiplier (0–2)
  angle: f32,        // screen rotation in radians
  monochrome: f32,   // 1.0 = grayscale dots, 0.0 = CMYK-style color dots
  _p0: f32,
  _p1: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

// Rotated cell coordinate
fn cellCoord(uv: vec2<f32>, cellSize: f32, angle: f32) -> vec2<f32> {
  let centered = uv - vec2<f32>(0.5);
  let rot = mat2x2<f32>(cos(angle), -sin(angle), sin(angle), cos(angle));
  let rotated = rot * centered + vec2<f32>(0.5);
  return fract(rotated * vec2<f32>(1.0 / cellSize) * u.texelSize * 1000.0);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv;
  let color = textureSample(colorTex, samp, uv).rgb;
  let dims = vec2<f32>(1.0 / u.texelSize.x, 1.0 / u.texelSize.y);
  let pixelPos = uv * dims;

  // Rotated grid coordinate
  let cosA = cos(u.angle);
  let sinA = sin(u.angle);
  let rot = mat2x2<f32>(cosA, -sinA, sinA, cosA);
  let centered = pixelPos - dims * 0.5;
  let rotated = rot * centered + dims * 0.5;

  let cell = floor(rotated / u.cellSize);
  let cellCenter = (cell + vec2<f32>(0.5)) * u.cellSize;
  let cellUV = (rotated - cell * u.cellSize) / u.cellSize;

  // Sample color at cell center for stable dot color
  let samplePos = (cellCenter / dims);
  let cellColor = textureSample(colorTex, samp, clamp(samplePos, vec2<f32>(0.0), vec2<f32>(1.0))).rgb;

  if (u.monochrome > 0.5) {
    let luma = dot(cellColor, vec3<f32>(0.299, 0.587, 0.114));
    let dotRadius = luma * u.dotScale * 0.5;
    let distFromCenter = length(cellUV - 0.5);
    let dot = 1.0 - smoothstep(dotRadius - 0.05, dotRadius + 0.05, distFromCenter);
    return vec4<f32>(vec3<f32>(luma * dot), 1.0);
  } else {
    // CMYK-style: separate dot per channel with angle offset
    var result = vec3<f32>(0.0);
    let channelAngles = array<f32, 3>(0.0, 1.0471976, 2.0943951);  // 0, 60, 120 deg
    for (var i = 0u; i < 3u; i = i + 1u) {
      let chAngle = u.angle + channelAngles[i];
      let chCos = cos(chAngle);
      let chSin = sin(chAngle);
      let chRot = mat2x2<f32>(chCos, -chSin, chSin, chCos);
      let chCentered = pixelPos - dims * 0.5;
      let chRotated = chRot * chCentered + dims * 0.5;
      let chCell = floor(chRotated / u.cellSize);
      let chCellCenter = (chCell + vec2<f32>(0.5)) * u.cellSize;
      let chCellUV = (chRotated - chCell * u.cellSize) / u.cellSize;
      let chSamplePos = clamp(chCellCenter / dims, vec2<f32>(0.0), vec2<f32>(1.0));
      let chColor = textureSample(colorTex, samp, chSamplePos)[i];
      let dotRadius = chColor * u.dotScale * 0.5;
      let distFromCenter = length(chCellUV - 0.5);
      let dot = 1.0 - smoothstep(dotRadius - 0.05, dotRadius + 0.05, distFromCenter);
      result[i] = chColor * dot;
    }
    return vec4<f32>(result, 1.0);
  }
}
