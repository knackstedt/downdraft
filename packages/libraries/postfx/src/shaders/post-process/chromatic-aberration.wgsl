// Chromatic aberration — radial RGB channel shift with falloff from center.
// Simulates lens chromatic aberration by offsetting R and B channels radially.
struct U {
  texelSize: vec2<f32>,
  intensity: f32,      // overall strength (0–1)
  start: f32,          // radial falloff start (0–1, normalized distance from center)
  end: f32,            // radial falloff end (0–1)
  centerX: f32,        // lens center offset X (0–1, 0.5 = center)
  centerY: f32,        // lens center offset Y (0–1, 0.5 = center)
  _p0: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv;
  let center = vec2<f32>(u.centerX, u.centerY);
  let dir = uv - center;
  let dist = length(dir);
  // Radial falloff: no aberration near center, full at edges
  let falloff = smoothstep(u.start, u.end, dist);
  let strength = u.intensity * falloff;
  let offset = normalize(dir) * strength;

  // Sample R and B at offset positions, G at center
  let r = textureSample(colorTex, samp, uv + offset).r;
  let g = textureSample(colorTex, samp, uv).g;
  let b = textureSample(colorTex, samp, uv - offset).b;

  return vec4<f32>(r, g, b, 1.0);
}
