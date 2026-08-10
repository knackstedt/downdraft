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
  let coords = vec2<i32>(i32(uv.x * u.gridW), i32(uv.y * u.gridH));
  let packed = textureLoad(gridTex, coords, 0).r;
  let matId = packed & 0xffu;
  let lifetime = f32((packed >> 8u) & 0xffu) / 255.0;
  let shade = (packed >> 16u) & 0x03u;  // 2 bits = 4 shade variants

  // Palette is 16 materials × 4 shades, laid out as 64×1
  let palIdx = i32(matId) * 4 + i32(shade);
  let color = textureLoad(paletteTex, vec2<i32>(palIdx, 0), 0);

  var alpha = color.a;
  if (matId == 5u || matId == 6u || matId == 11u) {
    alpha = alpha * (0.4 + 0.6 * lifetime);
  }

  return vec4<f32>(color.rgb, alpha);
}
