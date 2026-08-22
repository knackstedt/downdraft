// ============================================================================
// Block render shader — renders foreground + background planes with palette
// Packs fg (lower 16 bits) + bg (upper 16 bits) into a single r32uint texture.
//
// 2.5D effects:
// 1. Parallax: background plane is sampled at an offset position, creating
//    depth behind the foreground (background moves slower than foreground).
// 2. Bevel: foreground blocks have lighter top/left edges and darker
//    bottom/right edges, creating a 3D beveled appearance.
// 3. Depth shadow: foreground blocks cast a subtle shadow on the background
//    below them, enhancing the 2.5D depth illusion.
// 4. Background dimming: background plane is rendered darker than foreground.
// ============================================================================

struct Camera {
  camX: f32,
  camY: f32,
  zoom: f32,
  canvasW: f32,
  canvasH: f32,
  daylight: f32,
  mineX: f32,       // mining target X (-1 = none)
  mineY: f32,       // mining target Y (-1 = none)
  mineDamage: f32,  // mining damage progress (0-1)
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
};

@group(0) @binding(0) var gridTex: texture_2d<u32>;       // packed: fg | (bg << 16)
@group(0) @binding(1) var paletteTex: texture_2d<f32>;    // block palette (256×1)
@group(0) @binding(2) var lightTex: texture_2d<f32>;      // light levels (0-1)
@group(0) @binding(3) var exploredTex: texture_2d<f32>;   // fog of war (0 or 1)
@group(0) @binding(4) var<uniform> u: vec4<f32>;          // gridW, gridH, time, _pad
@group(0) @binding(5) var<uniform> cam: Camera;

// Parallax factor for background plane (0 = same as foreground, 1 = fixed)
const PARALLAX_FACTOR = 0.25;

// Bevel intensity — how much lighter/darker the edges are
const BEVEL_LIGHT = 0.25;   // top/left edge brightness boost
const BEVEL_DARK = 0.20;    // bottom/right edge darkness

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let gridW = i32(u.x);
  let gridH = i32(u.y);

  // UV is [0,1]×[0,1]. Convert to screen pixels.
  let screenPxX = uv.x * cam.canvasW;
  let screenPxY = uv.y * cam.canvasH;

  // Convert screen pixels to foreground grid coordinates.
  let cellX = (screenPxX - cam.canvasW * 0.5) / cam.zoom + cam.camX;
  let cellY = (screenPxY - cam.canvasH * 0.5) / cam.zoom + cam.camY;
  let coords = vec2<i32>(i32(cellX), i32(cellY));

  // Out of bounds: transparent (sky shows through)
  if (coords.x < 0 || coords.x >= gridW || coords.y < 0 || coords.y >= gridH) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }

  // Sub-cell position for bevel effect (0.0 = left/top edge, 0.5 = center)
  let subX = fract(cellX);
  let subY = fract(cellY);

  // Sample foreground grid at the current cell
  let packed = textureLoad(gridTex, coords, 0).r;
  let fgId = packed & 0xFFFFu;
  let bgId = (packed >> 16u) & 0xFFFFu;

  // Check neighboring foreground blocks for edge detection
  let leftPacked = textureLoad(gridTex, vec2<i32>(max(coords.x - 1, 0), coords.y), 0).r;
  let rightPacked = textureLoad(gridTex, vec2<i32>(min(coords.x + 1, gridW - 1), coords.y), 0).r;
  let upPacked = textureLoad(gridTex, vec2<i32>(coords.x, max(coords.y - 1, 0)), 0).r;
  let downPacked = textureLoad(gridTex, vec2<i32>(coords.x, min(coords.y + 1, gridH - 1)), 0).r;
  let leftFg = leftPacked & 0xFFFFu;
  let rightFg = rightPacked & 0xFFFFu;
  let upFg = upPacked & 0xFFFFu;
  let downFg = downPacked & 0xFFFFu;

  // For 2.5D parallax: sample the background at a slightly offset position.
  let parallaxOffsetX = i32((cam.camX - cellX) * PARALLAX_FACTOR);
  let parallaxOffsetY = i32((cam.camY - cellY) * PARALLAX_FACTOR);
  let bgCoords = vec2<i32>(
    clamp(coords.x + parallaxOffsetX, 0, gridW - 1),
    clamp(coords.y + parallaxOffsetY, 0, gridH - 1),
  );
  let bgPacked = textureLoad(gridTex, bgCoords, 0).r;
  let parallaxBgId = (bgPacked >> 16u) & 0xFFFFu;
  let effectiveBgId = select(parallaxBgId, bgId, parallaxBgId == 0u);

  // Sample light + explored
  let lightRaw = textureLoad(lightTex, coords, 0).r;
  let lightLevel = min(lightRaw * 17.0, 1.0);
  let explored = textureLoad(exploredTex, coords, 0).r;

  // Fog of war: unexplored cells are dark blue
  if (explored == 0.0) {
    return vec4<f32>(0.03, 0.03, 0.06, 1.0);
  }

  // If both fg and bg are air, transparent (sky shows through)
  if (fgId == 0u && effectiveBgId == 0u) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }

  // Light multiplier with ambient minimum
  let lightMul = max(lightLevel, 0.25);

  // --- Background plane (2.5D depth) ---
  var color = vec3<f32>(0.0);
  if (effectiveBgId > 0u) {
    let bgColor = textureLoad(paletteTex, vec2<i32>(i32(effectiveBgId), 0), 0);
    // Background at 55% brightness — clearly behind the foreground
    color = bgColor.rgb * 0.55 * lightMul;
  }

  // --- Foreground plane with 2.5D bevel effect ---
  if (fgId > 0u) {
    let fgColor = textureLoad(paletteTex, vec2<i32>(i32(fgId), 0), 0);
    var blockColor = fgColor.rgb;

    // Bevel effect: lighter on top/left edges, darker on bottom/right edges.
    // Only apply bevel on edges that are exposed (neighbor is air).
    var bevelMul = 1.0;

    // Top edge: lighter (if block above is air)
    if (upFg == 0u && subY < 0.15) {
      bevelMul += BEVEL_LIGHT * (1.0 - subY / 0.15);
    }
    // Left edge: lighter (if block to left is air)
    if (leftFg == 0u && subX < 0.15) {
      bevelMul += BEVEL_LIGHT * 0.7 * (1.0 - subX / 0.15);
    }
    // Bottom edge: darker (if block below is air)
    if (downFg == 0u && subY > 0.85) {
      bevelMul -= BEVEL_DARK * ((subY - 0.85) / 0.15);
    }
    // Right edge: darker (if block to right is air)
    if (rightFg == 0u && subX > 0.85) {
      bevelMul -= BEVEL_DARK * 0.7 * ((subX - 0.85) / 0.15);
    }

    // 2.5D depth shadow: if the block above is air, cast a shadow on the
    // background block below (simulates light coming from above)
    // This is handled by the light system already.

    color = blockColor * bevelMul * lightMul;
  }

  // --- Mining crack overlay ---
  // If this cell is the mining target, overlay a crack pattern that gets
  // darker as damage increases.
  if (cam.mineX >= 0.0 && cam.mineY >= 0.0) {
    let mineCoords = vec2<i32>(i32(cam.mineX), i32(cam.mineY));
    if (coords.x == mineCoords.x && coords.y == mineCoords.y && fgId > 0u) {
      let dmg = cam.mineDamage;
      // Crack pattern: dark lines that appear progressively as damage increases.
      // Use sub-cell position to create a crack-like pattern.
      let crackThreshold = 1.0 - dmg;
      // Simple crack: darken the block based on damage, with a crack line pattern
      let crackNoise = fract(sin(subX * 12.9898 + subY * 78.233) * 43758.5453);
      let isCrack = step(crackThreshold, crackNoise);
      let crackDarken = 1.0 - dmg * 0.5 * isCrack;
      color *= crackDarken;
      // Add a subtle red tint to indicate active mining
      color.r = color.r + dmg * 0.1;
    }
  }

  return vec4<f32>(color, 1.0);
}
