// Gaussian blur — two-pass separable convolution.
// vs_main emits a full-screen triangle; fs_blur samples a 9-tap Gaussian
// kernel along `uniforms.direction` (vec2(1,0) for horizontal, vec2(0,1) for vertical).

struct GaussianBlurUniforms {
  texelSize: vec2<f32>,
  direction: vec2<f32>,
  radius: f32,
};

@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> uniforms: GaussianBlurUniforms;

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  var p = array<vec2<f32>, 3>(
    vec2(-1.0, -1.0),
    vec2( 3.0, -1.0),
    vec2(-1.0,  3.0),
  );
  var output: VertexOutput;
  output.clipPos = vec4(p[vi], 0.0, 1.0);
  output.uv = vec2(p[vi].x * 0.5 + 0.5, 0.5 - p[vi].y * 0.5);
  return output;
};

// 9-tap Gaussian kernel weights (sigma ≈ 4, pre-normalized).
// Offsets are in texels; scaled by `uniforms.radius` at runtime.
const KERNEL_OFFSETS = array<f32, 4>(1.0, 2.0, 3.0, 4.0);
const KERNEL_WEIGHTS = array<f32, 4>(0.27901, 0.21305, 0.10747, 0.03584);

@fragment
fn fs_blur(input: VertexOutput) -> @location(0) vec4<f32> {
  let uv = input.uv;
  let dir = uniforms.direction * uniforms.texelSize * uniforms.radius;

  // Center tap (weight 0.227027)
  var color = textureSample(colorTex, samp, uv) * 0.227027;

  // 8 surrounding taps (4 on each side, mirrored)
  for (var i = 0; i < 4; i = i + 1) {
    let offset = KERNEL_OFFSETS[i] * dir;
    let w = KERNEL_WEIGHTS[i];
    color += textureSample(colorTex, samp, uv + offset) * w;
    color += textureSample(colorTex, samp, uv - offset) * w;
  }

  return color;
}
