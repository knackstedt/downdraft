struct Uniforms {
  gridW: f32,
  gridH: f32,
  time: f32,
  pad: f32,
};

@group(0) @binding(0) var gridTex: texture_2d<u32>;
@group(0) @binding(1) var paletteTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: Uniforms;

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  // Grid fills the entire canvas — UVs map 1:1, no letterboxing.
  let coords = vec2<i32>(i32(uv.x * u.gridW), i32(uv.y * u.gridH));
  let packed = textureLoad(gridTex, coords, 0).r;
  let matId = packed & 0xffu;
  let lifetime = f32((packed >> 8u) & 0xffu) / 255.0;

  let color = textureLoad(paletteTex, vec2<i32>(i32(matId), 0), 0);

  var alpha = color.a;
  if (matId == 5u || matId == 6u || matId == 11u) {
    alpha = alpha * (0.4 + 0.6 * lifetime);
  }

  return vec4<f32>(color.rgb, alpha);
}
