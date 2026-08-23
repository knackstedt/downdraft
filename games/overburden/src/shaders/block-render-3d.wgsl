// ============================================================================
// Block render 3D shader — renders blocks as 3D cubes with perspective.
//
// Uses instanced rendering: one cube geometry, many instances.
// Per-instance data: world position (x, y, z), block ID, face mask.
// Light and explored levels are sampled from textures at the block's grid pos.
//
// 2.5D effect: blocks are 3D cubes viewed from a slight angle, showing
// top and side faces. Background blocks are at Z=-1 (behind foreground).
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

  var color = blockColor * faceShade * lightMul * bevel;

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
