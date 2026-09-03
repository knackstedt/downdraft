// ============================================================================
// Block render 3D shader — renders blocks as 3D cubes with perspective.
//
// Uses instanced rendering: one cube geometry, many instances.
// Per-instance data: world position (x, y, z), block ID, face mask.
// Light and explored levels are sampled from textures at the block's grid pos.
//
// Procedural texturing: each block type gets a distinct texture pattern
// (noise, grain, speckles, bricks, etc.) computed in the fragment shader
// from the block's world position + local face UVs. No texture assets needed.
//
// Face shading: top brightest, front normal, sides medium, bottom dark.
// ============================================================================

struct Camera {
  viewProj: mat4x4<f32>,    // view × projection matrix (16 floats)
  camPos: vec3<f32>,         // camera world position
  zoom: f32,                 // pixels per block
  canvasW: f32,
  canvasH: f32,
  daylight: f32,
  mineX: f32,
  mineY: f32,
  mineDamage: f32,
  _pad: f32,
  originX: f32,             // active grid origin in world coords (for stable texturing)
  originY: f32,
  _pad2: f32,
  _pad3: f32,
  _pad4: f32,
};

@group(0) @binding(0) var<uniform> cam: Camera;
@group(0) @binding(1) var paletteTex: texture_2d<f32>;    // block palette (256×1)
@group(0) @binding(2) var lightTex: texture_2d<f32>;      // light levels (0-1)
@group(0) @binding(3) var exploredTex: texture_2d<f32>;   // fog of war (0 or 1)
@group(0) @binding(4) var fgGridTex: texture_2d<f32>;     // foreground block IDs (r8unorm, 0-1)
@group(0) @binding(5) var bgGridTex: texture_2d<f32>;     // background block IDs (r8unorm, 0-1)

// Vertex attributes (cube geometry)
struct VertexInput {
  @location(0) localPos: vec3<f32>,   // cube-local position [0, 1]
  @location(1) normal: vec3<f32>,     // face normal
  @location(2) faceId: f32,           // face index (0-5 cube, 6-9 chamfer)
};

// Per-instance data
struct InstanceInput {
  @location(3) instancePos: vec3<f32>,  // world position (x, y, z)
  @location(4) instanceData: vec2<f32>,  // x=blockId, y=faceMask (bits 0-5 faces, 8-11 corners)
};

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) @interpolate(flat) faceId: f32,
  @location(3) @interpolate(flat) blockId: f32,
  @location(4) @interpolate(flat) gridCoords: vec2<i32>,
  @location(5) localPos: vec3<f32>,
  @location(6) @interpolate(flat) instanceZ: f32,
  @location(7) @interpolate(flat) cornerMask: u32,
};

// Slope VFX: full diagonal slopes (corner to opposite corner).
// Both top/bottom-side and side-side vertices retract by the full block
// size (1.0), creating a diagonal from corner to opposite corner.
// e.g. for TR cut: chamfer face from (0,0) to (1,1) — the full diagonal.
const SLOPE_DEPTH_X = 1.0;
const SLOPE_DEPTH_Y = 1.0;

@vertex
fn vs_main(v: VertexInput, inst: InstanceInput) -> VSOut {
  let faceMask = u32(inst.instanceData.y);
  // Corner mask: bits 8-11 of instanceData.y (TL=8, TR=9, BL=10, BR=11)
  let cornerMask = (faceMask >> 8u) & 0xFu;
  let fid = u32(v.faceId);

  // Chamfer faces (faceId 6-9): visible only when the corresponding corner
  // bit is set. Vertices are displaced to form a 45° slope.
  if (fid >= 6u) {
    let cornerBit = 1u << (fid - 6u);
    if ((cornerMask & cornerBit) == 0u) {
      // Corner not cut — degenerate (clipped)
      var out: VSOut;
      out.pos = vec4<f32>(0.0, 0.0, 2.0, 1.0);
      return out;
    }
    // Displace vertices to form a full diagonal slope:
    //   normal.y ≠ 0 (top/bottom-side): retract x by full width (1.0)
    //   normal.x ≠ 0 (side-side):       retract y by full height (1.0)
    // For TR corner (1,0): top-side → (0,0), side-side → (1,1)
    // For TL corner (0,0): top-side → (1,0), side-side → (0,1)
    var lp = v.localPos;
    if (v.normal.y != 0.0) {
      // Top/bottom-side vertex: retract x by full block width
      lp.x = select(lp.x + SLOPE_DEPTH_X, lp.x - SLOPE_DEPTH_X, lp.x > 0.5);
    }
    if (v.normal.x != 0.0) {
      // Side-side vertex: retract y by half block height
      lp.y = select(lp.y + SLOPE_DEPTH_Y, lp.y - SLOPE_DEPTH_Y, lp.y > 0.5);
    }
    let worldPos = inst.instancePos + lp;
    var out: VSOut;
    out.pos = cam.viewProj * vec4<f32>(worldPos, 1.0);
    out.worldPos = worldPos;
    out.normal = v.normal;
    out.faceId = v.faceId;
    out.blockId = inst.instanceData.x;
    out.gridCoords = vec2<i32>(i32(inst.instancePos.x), i32(inst.instancePos.y));
    out.localPos = lp;
    out.instanceZ = inst.instancePos.z;
    out.cornerMask = cornerMask;
    return out;
  }

  // Original cube faces (faceId 0-5): check face mask bit
  let faceBit = 1u << fid;
  if ((faceMask & faceBit) == 0u) {
    // Face not visible — degenerate triangle (will be clipped)
    var out: VSOut;
    out.pos = vec4<f32>(0.0, 0.0, 2.0, 1.0); // w=1, z=2 → outside clip [0,1]
    return out;
  }

  // World position = instance position + local offset
  let worldPos = inst.instancePos + v.localPos;

  // Transform to clip space
  var out: VSOut;
  out.pos = cam.viewProj * vec4<f32>(worldPos, 1.0);
  out.worldPos = worldPos;
  out.normal = v.normal;
  out.faceId = v.faceId;
  out.blockId = inst.instanceData.x;
  out.gridCoords = vec2<i32>(i32(inst.instancePos.x), i32(inst.instancePos.y));
  out.localPos = v.localPos;
  out.instanceZ = inst.instancePos.z;
  out.cornerMask = cornerMask;
  return out;
}

// --- Hash / noise helpers ---
fn hash21(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}
fn hash13(p: vec3<f32>) -> f32 {
  return fract(sin(dot(p, vec3<f32>(127.1, 311.7, 74.7))) * 43758.5453);
}
// Value noise 2D — smooth interpolated noise
fn vnoise2(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2<f32>(1.0, 0.0));
  let c = hash21(i + vec2<f32>(0.0, 1.0));
  let d = hash21(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// Fractal noise (3 octaves)
fn fbm2(p: vec2<f32>) -> f32 {
  return vnoise2(p) * 0.5 + vnoise2(p * 2.0) * 0.25 + vnoise2(p * 4.0) * 0.125;
}

// Compute face UV: map localPos to a 2D UV based on which face we're on.
// This gives consistent texturing per-face.
fn faceUV(faceId: f32, lp: vec3<f32>) -> vec2<f32> {
  if (faceId < 0.5 || faceId < 1.5) {
    // +X / -X sides: use Y and Z
    return vec2<f32>(lp.y, lp.z);
  } else if (faceId < 2.5 || faceId < 3.5) {
    // +Y / -Y top/bottom: use X and Z
    return vec2<f32>(lp.x, lp.z);
  } else if (faceId < 5.5) {
    // +Z / -Z front/back: use X and Y
    return vec2<f32>(lp.x, lp.y);
  } else {
    // Chamfer faces (6-9): in x-y plane, extruded in z.
    // U = z (along extrusion), V = diagonal coordinate (varies per corner).
    //   TL (6): x+y is constant (0.5), so use y-x
    //   TR (7): x-y is constant (0.5), so use x+y
    //   BL (8): y-x is constant (0.5), so use x+y
    //   BR (9): x+y is constant (1.5), so use x-y
    if (faceId < 6.5) {
      return vec2<f32>(lp.z, lp.y - lp.x);  // TL
    } else if (faceId < 7.5) {
      return vec2<f32>(lp.z, lp.x + lp.y);  // TR
    } else if (faceId < 8.5) {
      return vec2<f32>(lp.z, lp.x + lp.y);  // BL
    } else {
      return vec2<f32>(lp.z, lp.x - lp.y);  // BR
    }
  }
}

// Compute the fragment's 2D grid position for bilinear light sampling.
// Each face spans one grid cell; the position within the face (localPos)
// determines where in the cell the fragment is, so we can interpolate
// light between neighboring cells for smooth transitions.
//   Front/back (±Z): both X and Y vary → full bilinear
//   Side (±X): only Y varies → bilinear in Y
//   Top/bottom (±Y): only X varies → bilinear in X
//   Chamfer (6-9): both X and Y vary → full bilinear (same as front/back)
fn gridPosForLight(faceId: f32, gridCoords: vec2<i32>, lp: vec3<f32>) -> vec2<f32> {
  if (faceId < 0.5 || faceId < 1.5) {
    // ±X side faces: X fixed at block edge, Y varies
    return vec2<f32>(f32(gridCoords.x), f32(gridCoords.y) + lp.y);
  } else if (faceId < 2.5 || faceId < 3.5) {
    // ±Y top/bottom: Y fixed at block edge, X varies
    return vec2<f32>(f32(gridCoords.x) + lp.x, f32(gridCoords.y));
  } else {
    // ±Z front/back + chamfer faces: both vary
    return vec2<f32>(f32(gridCoords.x) + lp.x, f32(gridCoords.y) + lp.y);
  }
}

// Bilinear-interpolated light sample at a fractional grid position.
// textureLoad returns 0 for out-of-bounds coords (dark), which is correct
// for cells outside the active grid.
//
// Light values are stored per-cell and conceptually represent the cell
// CENTER (cell C at world position C + 0.5). Shift the sample position by
// -0.5 before flooring so bilinear interpolation is symmetric: a block's
// left edge mixes light[C-1] and light[C] equally, and its right edge
// mixes light[C] and light[C+1] equally. Without this shift, light[C]
// bleeds onto block (C-1)'s far edge but not block (C+1)'s near edge,
// causing an asymmetric bias — e.g. in a 1-wide vertical tunnel the sky
// light favors the left wall and extends an extra cell below.
// floor (not i32) is used because the -0.5 shift can produce negative
// coords at the grid edge; i32() truncates toward zero, fract() uses floor.
fn bilinearLight(pos: vec2<f32>) -> vec3<f32> {
  let sp = pos - vec2<f32>(0.5, 0.5);
  let p = vec2<i32>(i32(floor(sp.x)), i32(floor(sp.y)));
  let f = vec2<f32>(fract(sp.x), fract(sp.y));
  let c00 = textureLoad(lightTex, p, 0).rgb;
  let c10 = textureLoad(lightTex, vec2<i32>(p.x + 1, p.y), 0).rgb;
  let c01 = textureLoad(lightTex, vec2<i32>(p.x, p.y + 1), 0).rgb;
  let c11 = textureLoad(lightTex, vec2<i32>(p.x + 1, p.y + 1), 0).rgb;
  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}

// Block IDs (must match constants.ts)
const BLK_DIRT        = 1u;
const BLK_GRASS       = 2u;
const BLK_STONE       = 3u;
const BLK_SAND        = 4u;
const BLK_WATER       = 5u;
const BLK_WOOD        = 6u;
const BLK_LEAVES      = 7u;
const BLK_COAL_ORE    = 8u;
const BLK_COPPER_ORE  = 9u;
const BLK_TIN_ORE     = 10u;
const BLK_IRON_ORE    = 11u;
const BLK_GOLD_ORE    = 12u;
const BLK_BEDROCK     = 13u;
const BLK_LAVA        = 14u;
const BLK_TORCH       = 15u;
const BLK_LADDER      = 16u;
const BLK_ROPE        = 17u;
const BLK_SCAFFOLDING = 18u;
const BLK_TIME_CRYSTAL = 19u;
const BLK_CLAY        = 20u;
const BLK_GRAVEL      = 21u;

// Procedural texture: returns a multiplier (0.8–1.2) to modulate blockColor.
// Uses world-space coords so neighboring blocks have different patterns.
// World coords = gridCoords (active-grid) + origin (chunk offset) → stable
// across chunk boundary crossings.
fn blockTexture(blockId: u32, gridCoords: vec2<i32>, faceId: f32, lp: vec3<f32>) -> f32 {
  let uv = faceUV(faceId, lp);
  let wpos = vec2<f32>(f32(gridCoords.x) + cam.originX, f32(gridCoords.y) + cam.originY);
  let texUV = wpos + uv; // world-aligned UVs so texture is continuous across blocks

  if (blockId == BLK_DIRT) {
    // Clumpy dirt: medium noise with dark specks
    let n = fbm2(texUV * 4.0);
    let speck = step(0.85, hash21(floor(texUV * 8.0)));
    return 0.85 + n * 0.25 - speck * 0.15;
  }
  if (blockId == BLK_GRASS) {
    // Grass: fine vertical noise (blades) on top, dirt-like on sides
    if (faceId > 2.5 && faceId < 3.5) {
      // Top face: grass blade pattern
      let n = fbm2(vec2<f32>(texUV.x * 8.0, texUV.y * 8.0));
      return 0.9 + n * 0.2;
    }
    // Sides/front: grass with dirt showing through
    let n = fbm2(texUV * 4.0);
    return 0.85 + n * 0.25;
  }
  if (blockId == BLK_STONE) {
    // Stone: rough noise with cracks
    let n = fbm2(texUV * 3.0);
    let crack = step(0.7, fbm2(texUV * 6.0));
    return 0.8 + n * 0.3 - crack * 0.1;
  }
  if (blockId == BLK_SAND) {
    // Sand: fine grain
    let n = vnoise2(texUV * 12.0);
    return 0.92 + n * 0.12;
  }
  if (blockId == BLK_WOOD) {
    // Wood: vertical grain rings
    let ring = sin(texUV.y * 3.0 + hash21(vec2<f32>(floor(texUV.x), 0.0)) * 6.28) * 0.5 + 0.5;
    let grain = vnoise2(vec2<f32>(texUV.x * 20.0, texUV.y * 2.0));
    return 0.75 + ring * 0.2 + grain * 0.1;
  }
  if (blockId == BLK_LEAVES) {
    // Leaves: clumpy organic noise
    let n = fbm2(texUV * 5.0);
    let holes = step(0.6, hash21(floor(texUV * 6.0)));
    return 0.7 + n * 0.35 - holes * 0.15;
  }
  if (blockId == BLK_COAL_ORE) {
    // Coal ore: dark speckles in stone
    let stone = fbm2(texUV * 3.0);
    let speck = step(0.55, hash21(floor(texUV * 5.0)));
    return 0.8 + stone * 0.2 - speck * 0.3;
  }
  if (blockId == BLK_COPPER_ORE) {
    // Copper: greenish-orange speckles
    let stone = fbm2(texUV * 3.0);
    let speck = step(0.6, hash21(floor(texUV * 5.0)));
    return 0.8 + stone * 0.2 + speck * 0.15;
  }
  if (blockId == BLK_TIN_ORE) {
    // Tin: light speckles
    let stone = fbm2(texUV * 3.0);
    let speck = step(0.6, hash21(floor(texUV * 5.0)));
    return 0.8 + stone * 0.2 + speck * 0.1;
  }
  if (blockId == BLK_IRON_ORE) {
    // Iron: rusty speckles
    let stone = fbm2(texUV * 3.0);
    let speck = step(0.55, hash21(floor(texUV * 5.0)));
    return 0.8 + stone * 0.2 + speck * 0.12;
  }
  if (blockId == BLK_GOLD_ORE) {
    // Gold: bright yellow speckles
    let stone = fbm2(texUV * 3.0);
    let speck = step(0.5, hash21(floor(texUV * 5.0)));
    return 0.8 + stone * 0.2 + speck * 0.25;
  }
  if (blockId == BLK_BEDROCK) {
    // Bedrock: very rough, dark
    let n = fbm2(texUV * 5.0);
    return 0.6 + n * 0.3;
  }
  if (blockId == BLK_LAVA) {
    // Lava: flowing pattern
    let flow = sin(texUV.x * 3.0 + texUV.y * 2.0) * 0.5 + 0.5;
    let n = fbm2(texUV * 4.0);
    return 0.85 + flow * 0.15 + n * 0.1;
  }
  if (blockId == BLK_CLAY) {
    // Clay: smooth with subtle cracks
    let n = vnoise2(texUV * 6.0);
    return 0.9 + n * 0.1;
  }
  if (blockId == BLK_GRAVEL) {
    // Gravel: coarse pebbles
    let n = vnoise2(texUV * 8.0);
    let pebble = step(0.5, hash21(floor(texUV * 6.0)));
    return 0.8 + n * 0.2 + pebble * 0.05;
  }
  if (blockId == BLK_TIME_CRYSTAL) {
    // Crystal: faceted shimmer
    let facet = abs(sin(texUV.x * 4.0)) * abs(sin(texUV.y * 4.0));
    return 0.85 + facet * 0.3;
  }
  if (blockId == BLK_WATER) {
    // Water: gentle ripples
    let ripple = sin(texUV.x * 4.0 + texUV.y * 3.0) * 0.5 + 0.5;
    return 0.88 + ripple * 0.1;
  }
  // Default: subtle noise
  let n = vnoise2(texUV * 4.0);
  return 0.9 + n * 0.15;
}

// --- Edge blending helpers ---
// Check if a block ID is a natural terrain block (eligible for edge blending)
fn isNaturalBlock(id: u32) -> bool {
  return id == BLK_DIRT || id == BLK_GRASS || id == BLK_STONE ||
         id == BLK_SAND || id == BLK_WOOD || id == BLK_LEAVES ||
         id == BLK_COAL_ORE || id == BLK_COPPER_ORE || id == BLK_TIN_ORE ||
         id == BLK_IRON_ORE || id == BLK_GOLD_ORE || id == BLK_BEDROCK ||
         id == BLK_CLAY || id == BLK_GRAVEL;
}

fn isOreBlock(id: u32) -> bool {
  return id == BLK_COAL_ORE || id == BLK_COPPER_ORE || id == BLK_TIN_ORE ||
         id == BLK_IRON_ORE || id == BLK_GOLD_ORE;
}

// Check if two block types should blend at their shared edge.
// Directional: only the block with the higher ID blends toward the lower.
// This ensures exactly one side of each boundary does the blending — the
// other side stays solid, eliminating the seam where two blend zones overlap.
fn shouldBlend(a: u32, b: u32) -> bool {
  if (a == b) { return false; }
  if (b == 0u) { return false; }
  if (a <= b) { return false; } // only the higher-ID block blends
  if (!isNaturalBlock(a) || !isNaturalBlock(b)) { return false; }
  // Ore blends with stone (ore embedded in stone)
  if (isOreBlock(a) && b == BLK_STONE) { return true; }
  if (isOreBlock(b) && a == BLK_STONE) { return true; }
  // Dirt/stone, grass/dirt, sand/stone, gravel/stone, clay/sand,
  // clay/stone, clay/gravel, sand/dirt, sand/grass, clay/dirt
  if (a == BLK_DIRT && b == BLK_STONE) { return true; }
  if (a == BLK_STONE && b == BLK_DIRT) { return true; }
  if (a == BLK_GRASS && b == BLK_DIRT) { return true; }
  if (a == BLK_DIRT && b == BLK_GRASS) { return true; }
  if (a == BLK_SAND && b == BLK_STONE) { return true; }
  if (a == BLK_STONE && b == BLK_SAND) { return true; }
  if (a == BLK_GRAVEL && b == BLK_STONE) { return true; }
  if (a == BLK_STONE && b == BLK_GRAVEL) { return true; }
  if (a == BLK_CLAY && b == BLK_SAND) { return true; }
  if (a == BLK_SAND && b == BLK_CLAY) { return true; }
  if (a == BLK_DIRT && b == BLK_GRAVEL) { return true; }
  if (a == BLK_GRAVEL && b == BLK_DIRT) { return true; }
  // Clay/stone, clay/gravel
  if (a == BLK_CLAY && b == BLK_STONE) { return true; }
  if (a == BLK_STONE && b == BLK_CLAY) { return true; }
  if (a == BLK_CLAY && b == BLK_GRAVEL) { return true; }
  if (a == BLK_GRAVEL && b == BLK_CLAY) { return true; }
  // Sand/dirt, sand/grass, clay/dirt
  if (a == BLK_SAND && b == BLK_DIRT) { return true; }
  if (a == BLK_DIRT && b == BLK_SAND) { return true; }
  if (a == BLK_SAND && b == BLK_GRASS) { return true; }
  if (a == BLK_GRASS && b == BLK_SAND) { return true; }
  if (a == BLK_CLAY && b == BLK_DIRT) { return true; }
  if (a == BLK_DIRT && b == BLK_CLAY) { return true; }
  // Wood/leaves
  if (a == BLK_WOOD && b == BLK_LEAVES) { return true; }
  if (a == BLK_LEAVES && b == BLK_WOOD) { return true; }
  // Grass/stone (grass over stone)
  if (a == BLK_GRASS && b == BLK_STONE) { return true; }
  if (a == BLK_STONE && b == BLK_GRASS) { return true; }
  return false;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let blockId = u32(in.blockId);
  if (blockId == 0u) {
    discard;
  }

  // Sample light + explored at the block's grid position.
  // Light is RGBA8: RGB = volumetric light color (0-1), A = pad.
  // Bilinear-interpolate the light across cell boundaries for smooth
  // gradients (no hard square light edges).
  let lightGridPos = gridPosForLight(in.faceId, in.gridCoords, in.localPos);
  let lightColor = bilinearLight(lightGridPos);
  let explored = textureLoad(exploredTex, in.gridCoords, 0).r;

  // Fog of war: unexplored cells are pure black
  if (explored == 0.0) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  // --- Slope VFX: discard fragments on existing cube faces that fall outside
  // the filled region of the marching-squares contour. ---
  // Each cut corner creates a full diagonal from that corner to the opposite
  // corner. Fragments on the "air" side of the diagonal are discarded,
  // revealing the chamfer slope face behind them.
  //
  // Corner mask bits: TL=0, TR=1, BL=2, BR=3
  // Full diagonals (in cell-local x,y coordinates):
  //   TL cut: diagonal (1,0)→(0,1), line x+y=1, air where x+y < 1
  //   TR cut: diagonal (0,0)→(1,1), line y=x,   air where y < x
  //   BL cut: diagonal (1,1)→(0,0), line y=x,   air where y > x
  //   BR cut: diagonal (0,1)→(1,0), line x+y=1, air where x+y > 1
  let cm = in.cornerMask;
  let lp0 = in.localPos;
  if (in.faceId < 0.5) {
    // +X side (x=1): substitute x=1
    //   TR: y < 1 → discard entire face except bottom edge
    //   BR: 1+y > 1 → y > 0 → discard entire face except top edge
    if ((cm & 2u) != 0u && lp0.y < 1.0) { discard; }
    if ((cm & 8u) != 0u && lp0.y > 0.0) { discard; }
  } else if (in.faceId < 1.5) {
    // -X side (x=0): substitute x=0
    //   TL: 0+y < 1 → y < 1 → discard entire face except bottom edge
    //   BL: y > 0 → discard entire face except top edge
    if ((cm & 1u) != 0u && lp0.y < 1.0) { discard; }
    if ((cm & 4u) != 0u && lp0.y > 0.0) { discard; }
  } else if (in.faceId < 2.5) {
    // +Y bottom (y=1): substitute y=1
    //   BL: 1 > x → x < 1 → discard entire face except right edge
    //   BR: x+1 > 1 → x > 0 → discard entire face except left edge
    if ((cm & 4u) != 0u && lp0.x < 1.0) { discard; }
    if ((cm & 8u) != 0u && lp0.x > 0.0) { discard; }
  } else if (in.faceId < 3.5) {
    // -Y top (y=0): substitute y=0
    //   TL: x+0 < 1 → x < 1 → discard entire face except right edge
    //   TR: 0 < x → x > 0 → discard entire face except left edge
    if ((cm & 1u) != 0u && lp0.x < 1.0) { discard; }
    if ((cm & 2u) != 0u && lp0.x > 0.0) { discard; }
  } else if (in.faceId < 5.5) {
    // +Z / -Z front/back: full diagonal formulas (both x and y vary)
    if ((cm & 1u) != 0u && lp0.x + lp0.y < 1.0) { discard; }
    if ((cm & 2u) != 0u && lp0.y < lp0.x) { discard; }
    if ((cm & 4u) != 0u && lp0.y > lp0.x) { discard; }
    if ((cm & 8u) != 0u && lp0.x + lp0.y > 1.0) { discard; }
  } else {
    // Chamfer faces (6-9): clip when the adjacent corner on the same edge
    // is also cut, preventing the two full-diagonal chamfer faces from
    // crossing. Both diagonals cross at the cell center (0.5, 0.5).
    // Discard the half that extends into the neighbor's air region.
    if (in.faceId < 6.5) {
      // TL chamfer: diagonal (1,0)→(0,1), lp.y ranges 0→1.
      // When TR is also cut, keep only lp.y > 0.5 (the BL half).
      if ((cm & 2u) != 0u && lp0.y < 0.5) { discard; }
    } else if (in.faceId < 7.5) {
      // TR chamfer: diagonal (0,0)→(1,1), lp.y ranges 0→1.
      // When TL is also cut, keep only lp.y > 0.5 (the BR half).
      if ((cm & 1u) != 0u && lp0.y < 0.5) { discard; }
    } else if (in.faceId < 8.5) {
      // BL chamfer: diagonal (1,1)→(0,0), lp.y ranges 1→0.
      // When BR is also cut, keep only lp.y < 0.5 (the TL half).
      if ((cm & 8u) != 0u && lp0.y > 0.5) { discard; }
    } else {
      // BR chamfer: diagonal (0,1)→(1,0), lp.y ranges 1→0.
      // When BL is also cut, keep only lp.y < 0.5 (the TR half).
      if ((cm & 4u) != 0u && lp0.y > 0.5) { discard; }
    }
  }

  // Sample block color from palette
  let blockColor = textureLoad(paletteTex, vec2<i32>(i32(blockId), 0), 0).rgb;

  // --- Edge blending: noise-dithered transitions between adjacent block types ---
  // Near face edges that border a different block type, dither the current
  // block's color toward the neighbor's color using blocky noise. This matches
  // the game's pixel-art aesthetic — no smooth gradients.
  //
  // PERF: The neighbor grid textures (fgGridTex/bgGridTex) are only sampled
  // when the fragment is within BLEND_WIDTH of a face edge. For interior
  // fragments (~70% of each face) we skip all 8 neighbor texture loads and
  // the shouldBlend() checks entirely. This is the single biggest GPU cost
  // in the shader — the unconditional version did 8 texture loads + 4-8
  // shouldBlend chains per fragment.
  //
  // Neighbor IDs are sampled from the grid textures (fgGridTex/bgGridTex)
  // at gridCoords ± 1. The correct texture is selected by instanceZ:
  //   Z >= -1 → foreground grid, Z < -1 → background grid.
  // r8unorm stores values 0-1, so multiply by 255 to get the block ID.
  //
  // localPos [0,1]³: lp.x=left/right, lp.y=top/bottom (Y-down), lp.z=front/back
  //
  // Edge→neighbor mapping per face:
  //   Front/back (faceId 4/5): lp.x→left/right, lp.y→top/bottom (all 4 edges)
  //   Side (faceId 0/1):       lp.y→top/bottom (2 edges; lp.z has no grid neighbor)
  //   Top/bottom (faceId 2/3): lp.x→left/right (2 edges; lp.z has no grid neighbor)
  let BLEND_WIDTH = 0.3; // how far the dither zone extends from the edge
  let lp = in.localPos;

  // Compute the minimum distance to any relevant edge for this face type.
  // If it's > BLEND_WIDTH, the fragment is in the face interior and edge
  // blending cannot affect it — skip all neighbor texture loads.
  let gc = in.gridCoords;
  let isFg = in.instanceZ >= -1.0;

  var blendColor = blockColor;
  var blendMask = 0.0; // 0 = own color, 1 = neighbor color
  var blendEdgeDist = 1.0;

  if (in.faceId < 0.5 || in.faceId < 1.5) {
    // +X / -X side faces: top (lp.y=0) and bottom (lp.y=1) edges
    let minEdge = min(lp.y, 1.0 - lp.y);
    if (minEdge < BLEND_WIDTH) {
      // Load only the 2 relevant neighbors from the correct grid texture.
      let nT = u32(textureLoad(fgGridTex, vec2<i32>(gc.x, gc.y - 1), 0).r * 255.0);
      let nB = u32(textureLoad(fgGridTex, vec2<i32>(gc.x, gc.y + 1), 0).r * 255.0);
      let bgT = u32(textureLoad(bgGridTex, vec2<i32>(gc.x, gc.y - 1), 0).r * 255.0);
      let bgB = u32(textureLoad(bgGridTex, vec2<i32>(gc.x, gc.y + 1), 0).r * 255.0);
      let sT = u32(select(bgT, nT, isFg));
      let sB = u32(select(bgB, nB, isFg));

      let wpos = vec2<f32>(f32(gc.x) + cam.originX, f32(gc.y) + cam.originY);
      let noiseUV = wpos + faceUV(in.faceId, lp);
      let noiseVal = hash21(floor(noiseUV * 6.0));

      if (shouldBlend(blockId, sT)) {
        let ed = lp.y;
        let t = 1.0 - clamp(ed / BLEND_WIDTH, 0.0, 1.0);
        if (noiseVal < t && (blendMask == 0.0 || ed < blendEdgeDist)) {
          blendMask = 1.0; blendEdgeDist = ed;
          blendColor = textureLoad(paletteTex, vec2<i32>(i32(sT), 0), 0).rgb;
        }
      }
      if (shouldBlend(blockId, sB)) {
        let ed = 1.0 - lp.y;
        let t = 1.0 - clamp(ed / BLEND_WIDTH, 0.0, 1.0);
        if (noiseVal < t && (blendMask == 0.0 || ed < blendEdgeDist)) {
          blendMask = 1.0; blendEdgeDist = ed;
          blendColor = textureLoad(paletteTex, vec2<i32>(i32(sB), 0), 0).rgb;
        }
      }
    }
  } else if (in.faceId < 2.5 || in.faceId < 3.5) {
    // +Y / -Y top/bottom faces: left (lp.x=0) and right (lp.x=1) edges
    let minEdge = min(lp.x, 1.0 - lp.x);
    if (minEdge < BLEND_WIDTH) {
      let nL = u32(textureLoad(fgGridTex, vec2<i32>(gc.x - 1, gc.y), 0).r * 255.0);
      let nR = u32(textureLoad(fgGridTex, vec2<i32>(gc.x + 1, gc.y), 0).r * 255.0);
      let bgL = u32(textureLoad(bgGridTex, vec2<i32>(gc.x - 1, gc.y), 0).r * 255.0);
      let bgR = u32(textureLoad(bgGridTex, vec2<i32>(gc.x + 1, gc.y), 0).r * 255.0);
      let sL = u32(select(bgL, nL, isFg));
      let sR = u32(select(bgR, nR, isFg));

      let wpos = vec2<f32>(f32(gc.x) + cam.originX, f32(gc.y) + cam.originY);
      let noiseUV = wpos + faceUV(in.faceId, lp);
      let noiseVal = hash21(floor(noiseUV * 6.0));

      if (shouldBlend(blockId, sL)) {
        let ed = lp.x;
        let t = 1.0 - clamp(ed / BLEND_WIDTH, 0.0, 1.0);
        if (noiseVal < t && (blendMask == 0.0 || ed < blendEdgeDist)) {
          blendMask = 1.0; blendEdgeDist = ed;
          blendColor = textureLoad(paletteTex, vec2<i32>(i32(sL), 0), 0).rgb;
        }
      }
      if (shouldBlend(blockId, sR)) {
        let ed = 1.0 - lp.x;
        let t = 1.0 - clamp(ed / BLEND_WIDTH, 0.0, 1.0);
        if (noiseVal < t && (blendMask == 0.0 || ed < blendEdgeDist)) {
          blendMask = 1.0; blendEdgeDist = ed;
          blendColor = textureLoad(paletteTex, vec2<i32>(i32(sR), 0), 0).rgb;
        }
      }
    }
  } else if (in.faceId < 5.5) {
    // +Z / -Z front/back faces: all 4 edges
    // (Chamfer faces 6-9 skip edge blending — they're interior to the block)
    let minEdge = min(min(lp.x, 1.0 - lp.x), min(lp.y, 1.0 - lp.y));
    if (minEdge < BLEND_WIDTH) {
      let nL = u32(textureLoad(fgGridTex, vec2<i32>(gc.x - 1, gc.y), 0).r * 255.0);
      let nR = u32(textureLoad(fgGridTex, vec2<i32>(gc.x + 1, gc.y), 0).r * 255.0);
      let nT = u32(textureLoad(fgGridTex, vec2<i32>(gc.x, gc.y - 1), 0).r * 255.0);
      let nB = u32(textureLoad(fgGridTex, vec2<i32>(gc.x, gc.y + 1), 0).r * 255.0);
      let bgL = u32(textureLoad(bgGridTex, vec2<i32>(gc.x - 1, gc.y), 0).r * 255.0);
      let bgR = u32(textureLoad(bgGridTex, vec2<i32>(gc.x + 1, gc.y), 0).r * 255.0);
      let bgT = u32(textureLoad(bgGridTex, vec2<i32>(gc.x, gc.y - 1), 0).r * 255.0);
      let bgB = u32(textureLoad(bgGridTex, vec2<i32>(gc.x, gc.y + 1), 0).r * 255.0);
      let sL = u32(select(bgL, nL, isFg));
      let sR = u32(select(bgR, nR, isFg));
      let sT = u32(select(bgT, nT, isFg));
      let sB = u32(select(bgB, nB, isFg));

      let wpos = vec2<f32>(f32(gc.x) + cam.originX, f32(gc.y) + cam.originY);
      let noiseUV = wpos + faceUV(in.faceId, lp);
      let noiseVal = hash21(floor(noiseUV * 6.0));

      if (shouldBlend(blockId, sL)) {
        let ed = lp.x;
        let t = 1.0 - clamp(ed / BLEND_WIDTH, 0.0, 1.0);
        if (noiseVal < t && (blendMask == 0.0 || ed < blendEdgeDist)) {
          blendMask = 1.0; blendEdgeDist = ed;
          blendColor = textureLoad(paletteTex, vec2<i32>(i32(sL), 0), 0).rgb;
        }
      }
      if (shouldBlend(blockId, sR)) {
        let ed = 1.0 - lp.x;
        let t = 1.0 - clamp(ed / BLEND_WIDTH, 0.0, 1.0);
        if (noiseVal < t && (blendMask == 0.0 || ed < blendEdgeDist)) {
          blendMask = 1.0; blendEdgeDist = ed;
          blendColor = textureLoad(paletteTex, vec2<i32>(i32(sR), 0), 0).rgb;
        }
      }
      if (shouldBlend(blockId, sT)) {
        let ed = lp.y;
        let t = 1.0 - clamp(ed / BLEND_WIDTH, 0.0, 1.0);
        if (noiseVal < t && (blendMask == 0.0 || ed < blendEdgeDist)) {
          blendMask = 1.0; blendEdgeDist = ed;
          blendColor = textureLoad(paletteTex, vec2<i32>(i32(sT), 0), 0).rgb;
        }
      }
      if (shouldBlend(blockId, sB)) {
        let ed = 1.0 - lp.y;
        let t = 1.0 - clamp(ed / BLEND_WIDTH, 0.0, 1.0);
        if (noiseVal < t && (blendMask == 0.0 || ed < blendEdgeDist)) {
          blendMask = 1.0; blendEdgeDist = ed;
          blendColor = textureLoad(paletteTex, vec2<i32>(i32(sB), 0), 0).rgb;
        }
      }
    }
  }

  // Apply blend: hard switch between own and neighbor color (pixel-art style)
  let finalBlockColor = mix(blockColor, blendColor, blendMask);

  // Procedural texture multiplier — use the current block's texture only.
  // The texture noise is world-aligned (continuous across blocks), so the
  // pattern is the same regardless of which block ID computes it. Switching
  // texMul between block types creates a brightness discontinuity at the
  // dither boundary because different block types have different multiplier
  // ranges. Keeping a single texMul avoids this seam.
  let texMul = blockTexture(blockId, in.gridCoords, in.faceId, in.localPos);

  // Face-dependent shading (2.5D depth illusion)
  // faceId: 0=+X(right), 1=-X(left), 2=+Y(bottom), 3=-Y(top), 4=+Z(front), 5=-Z(back)
  //         6-9=chamfer slopes (45° diagonal, between top and side brightness)
  var faceShade: f32;
  if (in.faceId < 0.5) {
    faceShade = 0.75;  // right side
  } else if (in.faceId < 1.5) {
    faceShade = 0.65;  // left side
  } else if (in.faceId < 2.5) {
    faceShade = 0.45;  // bottom (darkest)
  } else if (in.faceId < 3.5) {
    faceShade = 1.0;   // top (brightest — direct sunlight)
  } else if (in.faceId < 4.5) {
    faceShade = 0.9;   // front (facing camera)
  } else if (in.faceId < 5.5) {
    faceShade = 0.4;   // back (darkest, usually not visible)
  } else {
    // Chamfer faces (6-9): 45° slope facing up-outward.
    // Brighter than sides (0.75) but dimmer than top (1.0) — a 45° surface
    // receives ~70% of direct sunlight. Use 0.85 for a stylized look.
    faceShade = 0.85;
  }

  // Volumetric colored light — no ambient floor.
  // Only actual light sources (sky, torches, emitters) illuminate cells.
  // Unlit explored cells are pure black (indistinguishable from fog-of-war).
  let lightMul = lightColor;

  // Edge bevel: slightly lighten edges of each face for a 3D beveled look.
  // Skip bevel when showing a blended neighbor color — the neighbor block has
  // its own bevel, and doubling up creates a visible bright line at the seam.
  // Chamfer faces get a slightly stronger edge highlight (0.12 vs 0.08) to
  // accentuate the slope edges.
  let edgeDist = min(min(lp.x, 1.0 - lp.x), min(lp.y, 1.0 - lp.y));
  let edgeDistZ = min(lp.z, 1.0 - lp.z);
  let minEdge = min(edgeDist, edgeDistZ);
  let bevelStrength = select(0.12, 0.08, in.faceId < 5.5);
  let bevel = 1.0 + bevelStrength * step(minEdge, 0.08) * (1.0 - blendMask);

  var color = finalBlockColor * texMul * faceShade * lightMul * bevel;

  // Background blocks (Z < 0) are progressively darker based on depth.
  // 4-layer system: Z=0 (layer 1, full bright), Z=-1 (layer 2, 85%),
  // Z=-2 (layer 3, 70%), Z=-3 (layer 4, 55%).
  if (in.instanceZ < 0.0) {
    let d = -in.instanceZ;
    var depthFactor = 0.55; // default: Z=-3 (layer 4, back wall)
    if (d < 1.5) {
      depthFactor = 0.85;  // Z=-1 (layer 2)
    } else if (d < 2.5) {
      depthFactor = 0.70;  // Z=-2 (layer 3, background)
    }
    color *= depthFactor;
  }

  // Mining crack overlay
  if (cam.mineX >= 0.0 && cam.mineY >= 0.0) {
    let mineGridX = i32(cam.mineX);
    let mineGridY = i32(cam.mineY);
    if (in.gridCoords.x == mineGridX && in.gridCoords.y == mineGridY) {
      let dmg = cam.mineDamage;
      let crackNoise = fract(sin(lp.x * 12.9898 + lp.y * 78.233) * 43758.5453);
      let isCrack = step(1.0 - dmg, crackNoise);
      color *= 1.0 - dmg * 0.4 * isCrack;
      color.r += dmg * 0.08;
    }
  }

  // Water is semi-transparent so the player + terrain behind it stay visible.
  // Water is rendered in a separate pass (waterPipeline) with alpha blending
  // and depth-write disabled; opaque blocks always return alpha=1.0.
  var alpha = 1.0;
  if (blockId == BLK_WATER) {
    alpha = 0.65;
  }

  return vec4<f32>(color, alpha);
}
