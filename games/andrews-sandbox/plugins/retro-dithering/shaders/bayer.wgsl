// Retro Bayer dithering — ordered dithering to break up color banding.
// Adds a Bayer 4x4 noise pattern to the image. No quantization/posterization.
struct U {
  inv_w: f32,
  inv_h: f32,
  time: f32,
  strength: f32,
  levels: f32,
  scale: f32,
  _pad0: f32,
  _pad1: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

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
  let strength = u.strength;
  let scale = max(0.5, u.scale);

  let dims = vec2<f32>(1.0 / u.inv_w, 1.0 / u.inv_h);
  let pixelPos = vec2<u32>(u32(i32(uv.x * dims.x)), u32(i32(uv.y * dims.y)));
  let bx = u32(f32(pixelPos.x) / scale);
  let by = u32(f32(pixelPos.y) / scale);
  // Bayer dither value in [-0.5, 0.5]
  let dither = (bayer4(bx, by) - 0.5) * strength;

  var color = textureSample(colorTex, samp, uv).rgb;
  // Add dither noise to break up banding — no quantization.
  color = color + dither * 0.1;
  return vec4<f32>(clamp(color, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
