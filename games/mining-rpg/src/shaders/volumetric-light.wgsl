// Volumetric light diffusion — render-pass based (fragment shaders).
//
// Uses standard render targets (no storage textures, no compute shaders) for
// maximum GPU compatibility. Two fragment-shader passes ping-pong between two
// rgba8unorm textures:
//   fs_inject  — seed ambient sky light + world lights into the field
//   fs_diffuse — one Jacobi diffusion iteration (read src, write dst)
//
// The alpha channel stores cell type (0=air, 0.5=water, 1.0=solid), packed
// during inject and preserved through diffuse iterations.
//
// The field textures are half-res (1 texel = 2×2 grid cells) rgba8unorm.

const AIR = 0u;       // Material.Empty
const WATER = 2u;     // Material.Water

// Cell type encoded as alpha: 0.0 = air, 0.5 = water, 1.0 = solid.
const AIR_A = 0.0;
const WATER_A = 0.5;
const SOLID_A = 1.0;

struct VolUniforms {
  fieldW: u32,
  fieldH: u32,
  originX: f32,
  originY: f32,
  surfaceY: f32,
  iterations: u32,
  airPropagation: f32,
  waterPropagation: f32,
  solidPropagation: f32,
  waterAbsorbR: f32,
  waterAbsorbG: f32,
  waterAbsorbB: f32,
  ambientR: f32,
  ambientG: f32,
  ambientB: f32,
  ambientDepthFalloff: f32,
  numLights: u32,
  _pad0: u32,
};

struct LightData {
  pos: vec4<f32>,    // xy = world coords, z = colorR, w = colorG
  params: vec4<f32>, // x = colorB, y = intensity, z = radius, w = pad
};

@group(0) @binding(0) var<uniform> u: VolUniforms;
@group(0) @binding(1) var<storage, read> lightData: array<LightData>;
@group(0) @binding(2) var gridTex: texture_2d<u32>;
// Source field for diffusion (read). Not used by fs_inject.
@group(0) @binding(3) var srcField: texture_2d<f32>;

// --- Fullscreen vertex shader (shared by inject + diffuse) ---
// Uses @builtin(position) in the fragment shader for pixel coordinates.
struct VSOut {
  @builtin(position) pos: vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  // Fullscreen triangle: 3 vertices covering the screen
  let x = select(-1.0, 3.0, vi == 1u);
  let y = select(-1.0, 3.0, vi == 2u);
  var out: VSOut;
  out.pos = vec4<f32>(x, y, 0.0, 1.0);
  return out;
}

// --- Cell type classification ---
fn classifyCell(tx: u32, ty: u32) -> u32 {
  let gx = i32(tx * 2u);
  let gy = i32(ty * 2u);
  var hasWater = false;
  var hasAir = false;
  for (var dy = 0; dy < 2; dy = dy + 1) {
    for (var dx = 0; dx < 2; dx = dx + 1) {
      let packed = textureLoad(gridTex, vec2<i32>(gx + dx, gy + dy), 0).r;
      let matId = packed & 0xffu;
      if (matId == AIR) {
        hasAir = true;
      } else if (matId == WATER) {
        hasWater = true;
      } else {
        return 2u;
      }
    }
  }
  if (hasWater) { return 1u; }
  return 0u;
}

fn cellTypeToAlpha(ct: u32) -> f32 {
  if (ct == 2u) { return SOLID_A; }
  if (ct == 1u) { return WATER_A; }
  return AIR_A;
}

fn alphaToCellType(a: f32) -> u32 {
  if (a > 0.75) { return 2u; }
  if (a > 0.25) { return 1u; }
  return 0u;
}

// --- Inject fragment shader: seed ambient + world lights ---
@fragment
fn fs_inject(in: VSOut) -> @location(0) vec4<f32> {
  let tx = u32(in.pos.x);
  let ty = u32(in.pos.y);

  let cellType = classifyCell(tx, ty);

  // Local coords (relative to active grid origin). Lights are stored in
  // local coords too, so no origin dependency in the shader.
  let localX = f32(tx) * 2.0;
  let localY = f32(ty) * 2.0;

  // Depth below surface (world Y = originY + localY, surfaceY is in world coords)
  let worldY = u.originY + localY;
  let depthCells = max(0.0, worldY - u.surfaceY);
  let t = min(depthCells / max(u.ambientDepthFalloff, 1.0), 1.0);
  let ambientStrength = (1.0 - t) * (1.0 - t);

  var ambient = vec3<f32>(0.0);
  if (cellType == 0u) {
    // Air cells: full sky ambient regardless of depth. Sky light pours into
    // all air cells (both above-ground sky and underground caves) and diffuses
    // into neighboring solid cells. The depth-based falloff only applies to
    // the direct ambient injected into solid cells below — the diffused light
    // from air cells provides the "sky light reaching into tunnels" effect.
    ambient = vec3<f32>(u.ambientR, u.ambientG, u.ambientB);
  } else if (cellType == 1u) {
    // Water: reduced ambient (deeper water is darker)
    ambient = vec3<f32>(u.ambientR * 0.4, u.ambientG * 0.5, u.ambientB * 0.7) * ambientStrength * 0.5;
  } else {
    // Solid: depth-based ambient — bright near the surface, dark deep underground.
    // The diffusion from air cells provides additional light beyond this baseline.
    let minAmbient = 0.03;
    ambient = vec3<f32>(u.ambientR, u.ambientG, u.ambientB) * (ambientStrength * 0.5 + minAmbient);
  }

  var lightAccum = vec3<f32>(0.0);

  // Only inject direct light into AIR and WATER cells.
  if (cellType != 2u) {
    let n = min(u.numLights, 160u);
    for (var i = 0u; i < n; i = i + 1u) {
      let light = lightData[i];
      let lpos = vec2<f32>(light.pos.x, light.pos.y);
      let toLight = lpos - vec2<f32>(localX, localY);
      let dist = length(toLight);
      let radius = light.params.z;
      if (dist > radius) { continue; }
      let lcolor = vec3<f32>(light.pos.z, light.pos.w, light.params.x);
      let intensity = light.params.y;
      let d = dist / max(radius, 0.001);
      let falloff = (1.0 - d) * (1.0 - d);
      lightAccum = lightAccum + lcolor * intensity * falloff;
    }
  }

  let result = ambient + lightAccum;
  return vec4<f32>(result, cellTypeToAlpha(cellType));
}

// --- Diffuse fragment shader: one blur iteration ---
// Uses mix(self, neighborAvg, rate) which is inherently stable (no Jacobi
// checkerboard oscillation). The rate is the total mixing factor (not
// per-neighbor), so 0.20 means 20% of the new value comes from neighbors.
@fragment
fn fs_diffuse(in: VSOut) -> @location(0) vec4<f32> {
  let tx = u32(in.pos.x);
  let ty = u32(in.pos.y);

  let x0 = select(tx - 1u, 0u, tx == 0u);
  let x1 = select(tx + 1u, u.fieldW - 1u, tx >= u.fieldW - 1u);
  let y0 = select(ty - 1u, 0u, ty == 0u);
  let y1 = select(ty + 1u, u.fieldH - 1u, ty >= u.fieldH - 1u);

  let selfVal = textureLoad(srcField, vec2<i32>(i32(tx), i32(ty)), 0);
  let nL = textureLoad(srcField, vec2<i32>(i32(x0), i32(ty)), 0);
  let nR = textureLoad(srcField, vec2<i32>(i32(x1), i32(ty)), 0);
  let nU = textureLoad(srcField, vec2<i32>(i32(tx), i32(y0)), 0);
  let nD = textureLoad(srcField, vec2<i32>(i32(tx), i32(y1)), 0);

  let cellType = alphaToCellType(selfVal.a);

  // Total mixing rate depends on this cell's type.
  // 0.20 = 20% from neighbors, 80% from self. Stable (no oscillation).
  let rate = select(select(u.airPropagation, u.waterPropagation, cellType == 1u), u.solidPropagation, cellType == 2u);

  // Average of 4 neighbors (clamp edges by repeating edge value).
  let neighborAvg = (nL.rgb + nR.rgb + nU.rgb + nD.rgb) * 0.25;

  // Water tint: attenuate light passing through water cells.
  let waterTint = vec3<f32>(u.waterAbsorbR, u.waterAbsorbG, u.waterAbsorbB);
  let tintedAvg = select(neighborAvg, neighborAvg * waterTint, cellType == 1u);

  let newVal = mix(selfVal.rgb, tintedAvg, rate);

  return vec4<f32>(newVal, selfVal.a);
}
