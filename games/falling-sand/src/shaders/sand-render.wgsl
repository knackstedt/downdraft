struct Uniforms {
  gridW: f32,
  gridH: f32,
  time: f32,
  pad: f32,
};

@group(0) @binding(0) var gridTex: texture_2d<u32>;
@group(0) @binding(1) var paletteTex: texture_2d<f32>;   // color palette (64×1)
@group(0) @binding(2) var propsTex: texture_2d<f32>;     // material props (16×1: albedo, reflectivity, brightness, 0)
@group(0) @binding(3) var behindTex: texture_2d<f32>;    // behind-layer (unused for now, kept for bind group compat)
@group(0) @binding(4) var<uniform> u: Uniforms;

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let coords = vec2<i32>(i32(uv.x * u.gridW), i32(uv.y * u.gridH));
  let packed = textureLoad(gridTex, coords, 0).r;
  let matId = packed & 0xffu;
  let lifetime = f32((packed >> 8u) & 0xffu) / 255.0;
  let shade = (packed >> 16u) & 0x03u;

  // Empty cell — fully transparent (let behind-layer show through)
  if (matId == 0u) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }

  // Material color from palette
  let palIdx = i32(matId) * 4 + i32(shade);
  let matColor = textureLoad(paletteTex, vec2<i32>(palIdx, 0), 0);

  // Material properties
  let props = textureLoad(propsTex, vec2<i32>(i32(matId), 0), 0);
  let brightness = props.b;

  // Fire/smoke/steam alpha fade
  var alpha = matColor.a;
  if (matId == 5u || matId == 6u || matId == 11u) {
    alpha = alpha * (0.4 + 0.6 * lifetime);
  }

  // Base color modulated by brightness (self-illumination)
  let finalColor = matColor.rgb * brightness;

  return vec4<f32>(finalColor, alpha);
}
