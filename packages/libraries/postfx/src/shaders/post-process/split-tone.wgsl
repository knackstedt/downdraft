// Split-tone — separate highlight and shadow tinting with balance control.
// Applies different color tints to shadows and highlights, blended by luminance.
struct U {
  shadowR: f32, shadowG: f32, shadowB: f32,   // shadow tint color
  highlightR: f32, highlightG: f32, highlightB: f32,  // highlight tint color
  balance: f32,     // -1.0 = more shadows, 1.0 = more highlights, 0 = even
  _p0: f32,
  _p1: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv;
  var color = textureSample(colorTex, samp, uv).rgb;

  let luma = dot(color, vec3<f32>(0.299, 0.587, 0.114));
  // Weight: 0 at shadows, 1 at highlights, shifted by balance
  let weight = smoothstep(0.0, 1.0, luma + u.balance * 0.5);

  let shadowTint = vec3<f32>(u.shadowR, u.shadowG, u.shadowB);
  let highlightTint = vec3<f32>(u.highlightR, u.highlightG, u.highlightB);

  // Blend: shadows get shadow tint, highlights get highlight tint
  let tint = mix(shadowTint, highlightTint, weight);
  // Additive tint with luminance preservation
  color = color * (vec3<f32>(1.0) + tint * 0.5);

  return vec4<f32>(color, 1.0);
}
