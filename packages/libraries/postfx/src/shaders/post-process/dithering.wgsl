// Dithering — ordered (Bayer) + blue-noise modes to reduce color banding.
// Applies a dithering pattern before quantization to break up smooth gradients.
struct U {
  texelSize: vec2<f32>,
  mode: f32,         // 0 = off, 1 = Bayer 4x4, 2 = blue-noise
  strength: f32,     // dithering intensity (0–1)
  levels: f32,       // color quantization levels (0 = no quantization, e.g. 32)
  _p0: f32,
  _p1: f32,
  _p2: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var noiseTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

// 4x4 Bayer matrix (threshold values 0–15, normalized to 0–1)
fn bayer4(x: u32, y: u32) -> f32 {
  let m = array<u32, 16>(
     0u,  8u,  2u, 10u,
    12u,  4u, 14u,  6u,
     3u, 11u,  1u,  9u,
    15u,  7u, 13u,  5u,
  );
  return f32(m[(y % 4u) * 4u + (x % 4u)]) / 16.0;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv;
  var color = textureSample(colorTex, samp, uv).rgb;

  if (u.mode < 0.5) {
    return vec4<f32>(color, 1.0);
  }

  let dims = vec2<f32>(1.0 / u.texelSize.x, 1.0 / u.texelSize.y);
  let pixelPos = vec2<u32>(u32(i32(uv.x * dims.x)), u32(i32(uv.y * dims.y)));

  var dither: f32;
  if (u.mode < 1.5) {
    // Bayer 4x4
    dither = bayer4(pixelPos.x, pixelPos.y) - 0.5;
  } else {
    // Blue noise
    let noiseUV = uv * dims / 128.0;  // tile noise texture
    dither = textureSample(noiseTex, samp, noiseUV).r - 0.5;
  }

  // Apply dithering: add noise before quantization
  let dithered = color + dither * u.strength * (1.0 / max(u.levels, 1.0));

  if (u.levels > 0.5) {
    // Quantize to N levels per channel
    let q = u.levels;
    let quantized = floor(dithered * q + 0.5) / q;
    return vec4<f32>(clamp(quantized, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
  }

  return vec4<f32>(clamp(dithered, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
