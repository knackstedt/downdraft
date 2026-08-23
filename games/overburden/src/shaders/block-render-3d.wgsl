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

// Vertex attributes (cube geometry)
struct VertexInput {
  @location(0) localPos: vec3<f32>,   // cube-local position [0, 1]
  @location(1) normal: vec3<f32>,     // face normal
  @location(2) faceId: f32,           // face index (0-5)
};

// Per-instance data
struct InstanceInput {
  @location(3) instancePos: vec3<f32>,  // world position (x, y, z)
  @location(4) instanceData: vec2<f32>,  // x=blockId, y=faceMask
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
};

@vertex
fn vs_main(v: VertexInput, inst: InstanceInput) -> VSOut {
  // Check if this face is visible (face mask bit)
  let faceMask = inst.instanceData.y;
  let faceBit = 1u << u32(v.faceId);
  if ((u32(faceMask) & faceBit) == 0u) {
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
  } else {
    // +Z / -Z front/back: use X and Y
    return vec2<f32>(lp.x, lp.y);
  }
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

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let blockId = u32(in.blockId);
  if (blockId == 0u) {
    discard;
  }

  // Sample light + explored at the block's grid position
  let lightRaw = textureLoad(lightTex, in.gridCoords, 0).r;
  let lightLevel = min(lightRaw * 17.0, 1.0); // 0-15 → 0-1
  let explored = textureLoad(exploredTex, in.gridCoords, 0).r;

  // Fog of war: unexplored cells are dark
  if (explored == 0.0) {
    return vec4<f32>(0.03, 0.03, 0.06, 1.0);
  }

  // Sample block color from palette
  let blockColor = textureLoad(paletteTex, vec2<i32>(i32(blockId), 0), 0).rgb;

  // Procedural texture multiplier
  let texMul = blockTexture(blockId, in.gridCoords, in.faceId, in.localPos);

  // Face-dependent shading (2.5D depth illusion)
  // faceId: 0=+X(right), 1=-X(left), 2=+Y(bottom), 3=-Y(top), 4=+Z(front), 5=-Z(back)
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
  } else {
    faceShade = 0.4;   // back (darkest, usually not visible)
  }

  // Light level with ambient minimum
  let lightMul = max(lightLevel, 0.25);

  // Edge bevel: slightly lighten edges of each face for a 3D beveled look
  let lp = in.localPos;
  let edgeDist = min(min(lp.x, 1.0 - lp.x), min(lp.y, 1.0 - lp.y));
  let edgeDistZ = min(lp.z, 1.0 - lp.z);
  let minEdge = min(edgeDist, edgeDistZ);
  let bevel = 1.0 + 0.08 * step(minEdge, 0.08);

  var color = blockColor * texMul * faceShade * lightMul * bevel;

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

  return vec4<f32>(color, 1.0);
}
