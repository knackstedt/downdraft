struct Uniforms {
  gridW: f32,
  gridH: f32,
  time: f32,
  pad: f32,
};

@group(0) @binding(0) var gridTex: texture_2d<u32>;
@group(0) @binding(1) var paletteTex: texture_2d<f32>;   // color palette (256×1)
@group(0) @binding(2) var propsTex: texture_2d<f32>;     // material props (64×1: albedo, reflectivity, brightness, 0)
@group(0) @binding(3) var behindTex: texture_2d<f32>;    // behind-layer (unused for now)
@group(0) @binding(4) var<uniform> u: Uniforms;

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let coords = vec2<i32>(i32(uv.x * u.gridW), i32(uv.y * u.gridH));
  let packed = textureLoad(gridTex, coords, 0).r;
  let matId = packed & 0xffu;
  let lifetime = f32((packed >> 8u) & 0xffu) / 255.0;
  let shade = (packed >> 16u) & 0x03u;

  if (matId == 0u) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }

  let palIdx = i32(matId) * 4 + i32(shade);
  let matColor = textureLoad(paletteTex, vec2<i32>(palIdx, 0), 0);

  let props = textureLoad(propsTex, vec2<i32>(i32(matId), 0), 0);
  let brightness = props.b;

  // Alpha fade for gases and temporary particles
  // Fire=5, Smoke=6, Steam=11, GasVapor=21, Hydrogen=22, Fireflies=27,
  // Plasma=39, Nanobots=40, BurningOil=51
  var alpha = matColor.a;
  if (matId == 5u || matId == 50u || matId == 51u) {
    // Fire/FuseFire/BurningOil: keep bright and fairly opaque — don't fade too much with lifetime
    alpha = alpha * (0.85 + 0.15 * lifetime);
  } else if (matId == 6u || matId == 11u || matId == 21u ||
      matId == 22u || matId == 39u) {
    alpha = alpha * (0.4 + 0.6 * lifetime);
  }
  // Hydrogen nearly invisible
  if (matId == 22u) {
    alpha = alpha * 0.15;
  }
  // Fireflies flicker
  if (matId == 27u) {
    let flicker = 0.5 + 0.5 * sin(u.time * 5.0 + f32(coords.x) * 0.5 + f32(coords.y) * 0.3);
    alpha = alpha * flicker;
  }

  let finalColor = matColor.rgb * brightness;
  return vec4<f32>(finalColor, alpha);
}
