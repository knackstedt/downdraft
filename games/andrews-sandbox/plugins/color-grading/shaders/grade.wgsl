// Color grading — warm/cool/sepia/noir/vintage/teal-orange looks.
// Runs in the stylized group (after tonemap) so input is LDR.
struct U {
  inv_w: f32,
  inv_h: f32,
  time: f32,
  mode: f32,
  intensity: f32,
  contrast: f32,
  saturation: f32,
  _pad: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv;
  let mode = u32(u.mode);

  var color = textureSample(colorTex, samp, uv).rgb;
  // Clamp input to LDR in case tonemap isn't enabled.
  color = clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));

  // Contrast
  color = (color - 0.5) * u.contrast + 0.5;

  // Saturation
  let luma = dot(color, vec3<f32>(0.299, 0.587, 0.114));
  color = mix(vec3<f32>(luma), color, u.saturation);

  var graded = color;

  if (mode == 0u) {
    // Warm
    graded = vec3<f32>(color.r * 1.25 + 0.03, color.g * 1.05, color.b * 0.65 - 0.02);
  } else if (mode == 1u) {
    // Cool
    graded = vec3<f32>(color.r * 0.70, color.g * 0.90, color.b * 1.35 + 0.03);
  } else if (mode == 2u) {
    // Sepia
    graded = vec3<f32>(
      dot(color, vec3<f32>(0.393, 0.769, 0.189)),
      dot(color, vec3<f32>(0.349, 0.686, 0.168)),
      dot(color, vec3<f32>(0.272, 0.534, 0.131))
    );
  } else if (mode == 3u) {
    // Noir
    graded = vec3<f32>(luma);
  } else if (mode == 4u) {
    // Vintage
    graded = vec3<f32>(color.r * 0.85 + 0.08, color.g * 0.80 + 0.05, color.b * 0.65 + 0.03);
  } else if (mode == 5u) {
    // Teal-Orange
    let shadows = mix(color, vec3<f32>(0.15, 0.45, 0.55), 0.4);
    let highlights = mix(color, vec3<f32>(1.3, 0.65, 0.25), 0.4);
    graded = mix(shadows, highlights, smoothstep(0.25, 0.75, luma));
  }

  let result = mix(color, graded, u.intensity);
  return vec4<f32>(clamp(result, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
