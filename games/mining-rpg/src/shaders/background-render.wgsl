// Background render shader — renders the build materials layer (scaffolding,
// ladders, ropes) with material-specific shape masks.
//
// Build items are multi-cell structures (5-wide platforms with 2 legs, 5×7
// ladders, 3-wide ropes). The shader uses neighbor lookups on the grid texture
// to draw edge features only at the boundaries of each item, so multi-cell
// items appear as seamless shapes.
//
// Masks are styled for zoom-out visibility: features are thicker so they remain
// readable when the camera is zoomed out (1 cell < 4px).
//
// The background is rendered between the backdrop (cave walls) and the
// foreground (sand/stone/water), so build materials appear behind terrain.

struct Uniforms {
  gridW: f32,
  gridH: f32,
  time: f32,
  pad: f32,
};

struct CameraUniforms {
  camX: f32,
  camY: f32,
  zoom: f32,
  canvasW: f32,
  canvasH: f32,
  depth: f32,
  pad1: f32,
  pad2: f32,
};

@group(0) @binding(0) var gridTex: texture_2d<u32>;
@group(0) @binding(1) var paletteTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: Uniforms;
@group(0) @binding(3) var<uniform> cam: CameraUniforms;

// Material IDs (must match the Material enum in materials.ts)
const MAT_SCAFFOLDING: u32 = 93u;
const MAT_LADDER: u32 = 94u;
const MAT_ROPE: u32 = 95u;

// Check if the cell at (x, y) has the given material in the background grid.
fn bgIs(x: i32, y: i32, mat: u32) -> bool {
  if (x < 0 || x >= i32(u.gridW) || y < 0 || y >= i32(u.gridH)) {
    return false;
  }
  return (textureLoad(gridTex, vec2<i32>(x, y), 0).r & 0xffu) == mat;
}

// Scaffolding: platform cells (top row, no scaffolding above) render as wood
// planks. Leg cells (scaffolding above, at left/right edges only) render as
// vertical posts. The 2-leg structure means only the leftmost and rightmost
// columns of the platform have supports below them.
fn scaffoldingMask(frac: vec2<f32>, coords: vec2<i32>) -> f32 {
  let isSupport = bgIs(coords.x, coords.y - 1, MAT_SCAFFOLDING);
  let leftEdge = !bgIs(coords.x - 1, coords.y, MAT_SCAFFOLDING);
  let rightEdge = !bgIs(coords.x + 1, coords.y, MAT_SCAFFOLDING);

  var mask = 1.0;

  if (isSupport) {
    // Leg post: full-width vertical beam (thick for zoom-out visibility)
    // with vertical wood grain
    let grain = 0.80 + 0.20 * sin(frac.y * 6.0);
    mask = grain;
    // Slight darkening at the sides of the post for a rounded look
    if (frac.x < 0.12 || frac.x > 0.88) {
      mask *= 0.75;
    }
  } else {
    // Platform plank: full cell with 2 horizontal grain lines
    let lineW = 0.05;
    if (abs(frac.y - 0.30) < lineW || abs(frac.y - 0.70) < lineW) {
      mask = 0.70;
    }
  }

  // Darken vertical seams at item edges (platform and legs)
  if (leftEdge && frac.x < 0.06) {
    mask *= 0.65;
  }
  if (rightEdge && frac.x > 0.94) {
    mask *= 0.65;
  }

  return mask;
}

// Ladder: rails only at the left/right edges of the 5-wide block. 3 rungs per
// cell at y=0.20, 0.50, 0.80 (tiles vertically for seamless stacking). Rungs
// are thicker for zoom-out readability.
fn ladderMask(frac: vec2<f32>, coords: vec2<i32>) -> f32 {
  let leftEdge = !bgIs(coords.x - 1, coords.y, MAT_LADDER);
  let rightEdge = !bgIs(coords.x + 1, coords.y, MAT_LADDER);

  let railW = 0.18;
  var onRail = false;

  // Left rail: drawn in the leftmost column of the item
  if (leftEdge && frac.x < railW) {
    onRail = true;
  }
  // Right rail: drawn in the rightmost column
  if (rightEdge && frac.x > (1.0 - railW)) {
    onRail = true;
  }

  // 3 rungs at y=0.20, 0.50, 0.80 (tiles when stacked)
  let rungH = 0.08;
  let onRung = (abs(frac.y - 0.20) < rungH ||
                abs(frac.y - 0.50) < rungH ||
                abs(frac.y - 0.80) < rungH);

  if (onRail || onRung) {
    return 1.0;
  }
  return 0.0;
}

// Rope: 3-wide. Center strand fills the middle of the cell. Edge strands fill
// half the edge cell (inner half only, so adjacent rope cells merge into a
// continuous wide strand). Fiber texture for a twisted-rope look.
fn ropeMask(frac: vec2<f32>, coords: vec2<i32>) -> f32 {
  let leftEdge = !bgIs(coords.x - 1, coords.y, MAT_ROPE);
  let rightEdge = !bgIs(coords.x + 1, coords.y, MAT_ROPE);

  let fiber = 0.80 + 0.20 * sin(frac.y * 8.0);
  var mask = 0.0;

  // Center strand: fills the center ~60% of the cell (wide for visibility)
  let centerW = 0.30;
  if (abs(frac.x - 0.5) < centerW) {
    mask = fiber;
  }

  // Left edge strand: fills the inner half of the leftmost cell
  // (frac.x > 0.5 so it merges with the center strand of the next cell)
  if (leftEdge && frac.x > 0.5 && frac.x < 0.85) {
    mask = max(mask, fiber);
  }
  // Right edge strand: fills the inner half of the rightmost cell
  if (rightEdge && frac.x < 0.5 && frac.x > 0.15) {
    mask = max(mask, fiber);
  }

  return mask;
}

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  // Convert UV to active-grid cell coords (same as sand-render.wgsl)
  let screenPx = vec2<f32>(uv.x * cam.canvasW, uv.y * cam.canvasH);
  let cellX = (screenPx.x - cam.canvasW * 0.5) / cam.zoom + cam.camX;
  let cellY = (screenPx.y - cam.canvasH * 0.5) / cam.zoom + cam.camY;

  let coords = vec2<i32>(i32(cellX), i32(cellY));
  if (coords.x < 0 || coords.x >= i32(u.gridW) || coords.y < 0 || coords.y >= i32(u.gridH)) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }

  let packed = textureLoad(gridTex, coords, 0).r;
  let matId = packed & 0xffu;
  let shade = (packed >> 16u) & 0x03u;

  if (matId == 0u) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }

  // Get material color from palette
  let palIdx = i32(matId) * 4 + i32(shade);
  let matColor = textureLoad(paletteTex, vec2<i32>(palIdx, 0), 0);

  // Compute shape mask based on material type (pass coords for neighbor lookups)
  let frac = fract(vec2<f32>(cellX, cellY));
  var mask = 0.0;
  if (matId == MAT_SCAFFOLDING) {
    mask = scaffoldingMask(frac, coords);
  } else if (matId == MAT_LADDER) {
    mask = ladderMask(frac, coords);
  } else if (matId == MAT_ROPE) {
    mask = ropeMask(frac, coords);
  } else {
    mask = 1.0;
  }

  if (mask <= 0.0) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }

  // Depth-based ambient darkening (same as foreground)
  let ambient = 1.0 - clamp(cam.depth / 20.0, 0.0, 0.6);
  let color = matColor.rgb;
  let alpha = matColor.a * mask * ambient;
  return vec4<f32>(color * ambient, alpha);
}
