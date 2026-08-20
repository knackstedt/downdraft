// Light accumulation shaders.
// Renders to a half-res rgba8unorm light texture that covers the full active
// grid. Each texture pixel = 2×2 grid cells.
//
// Two sub-passes:
//   1. Ambient fill: fullscreen quad fills with the depth-based base ambient
//      color (surface = warm white, deep = cool dark).
//   2. Light quads: instanced radial-gradient quads for each light (additive
//      blend). Light positions are in ACTIVE-GRID LOCAL coords.
//
// The material shaders sample this texture with textureLoad(lightTex, coords/2, 0)
// to get per-cell lighting. This replaces the old depth-based ambient darkening.

struct AmbientUniforms {
  // Base ambient color (RGB) — depth-driven: surface = warm, deep = cool dark
  color: vec3<f32>,
  pad: f32,
};

struct TexUniforms {
  texW: f32,
  texH: f32,
  pad0: f32,
  pad1: f32,
};

@group(0) @binding(0) var<uniform> ambient: AmbientUniforms;
@group(0) @binding(1) var<uniform> texU: TexUniforms;
@group(0) @binding(2) var<storage, read> lightData: array<vec4<f32>>;

const LIGHT_FLOATS = 8u;
const MAX_LIGHTS = 192u;

// --- Ambient fill vertex shader (fullscreen quad, clip space) ---
@vertex
fn vs_ambient(@location(0) corner: vec2<f32>) -> @builtin(position) vec4<f32> {
  return vec4<f32>(corner.x, corner.y, 0.0, 1.0);
}

// --- Ambient fill fragment shader ---
@fragment
fn fs_ambient() -> @location(0) vec4<f32> {
  return vec4<f32>(ambient.color, 1.0);
}

// --- Light quad vertex shader (instanced) ---
struct LightVsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) localPos: vec2<f32>, // -1..1 within the quad
  @location(1) @interpolate(flat) instanceIdx: i32,
};

@vertex
fn vs_light(
  @location(0) corner: vec2<f32>, // -1..1 quad corner
  @builtin(instance_index) instanceIdx: u32,
) -> LightVsOut {
  if (instanceIdx >= MAX_LIGHTS) {
    return LightVsOut(vec4<f32>(0.0, 0.0, 0.0, 0.0), vec2<f32>(0.0), -1);
  }
  let base = instanceIdx * (LIGHT_FLOATS / 4u);
  // Light position in active-grid LOCAL coords
  let lpos = vec2<f32>(lightData[base].x, lightData[base].y);
  // Light radius in grid cells (struct: x,y,r,g | b,intensity,radius,pad)
  let lradius = lightData[base + 1u].z;

  // Convert to light texture pixel coords (half-res: 1 texture pixel = 2 cells)
  let texPxX = lpos.x * 0.5;
  let texPxY = lpos.y * 0.5;
  // Quad extends radius/2 texture pixels from center (since 1 texel = 2 cells)
  let halfSize = lradius * 0.5;
  let px = texPxX + corner.x * halfSize;
  let py = texPxY + corner.y * halfSize;

  // Convert to clip space (-1..1) using texture dimensions.
  // WebGPU clip space has Y=+1 at the TOP, but textureLoad reads (0,0) at
  // top-left too — so we need to flip Y to match textureLoad's coordinate system.
  let clipX = px / texU.texW * 2.0 - 1.0;
  let clipY = 1.0 - py / texU.texH * 2.0;

  return LightVsOut(vec4<f32>(clipX, clipY, 0.0, 1.0), corner, i32(instanceIdx));
}

// --- Light quad fragment shader (additive) ---
@fragment
fn fs_light(in: LightVsOut) -> @location(0) vec4<f32> {
  if (in.instanceIdx < 0) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }
  let base = u32(in.instanceIdx) * (LIGHT_FLOATS / 4u);
  let lcolor = vec3<f32>(lightData[base].z, lightData[base].w, lightData[base + 1u].x);
  let lintensity = lightData[base + 1u].y;

  // Distance from quad center (0..1), squared
  let dist = length(in.localPos);
  if (dist > 1.0) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }

  // Smooth radial falloff: (1 - dist)^2
  let falloff = (1.0 - dist) * (1.0 - dist);
  let contribution = lcolor * lintensity * falloff;

  return vec4<f32>(contribution, 1.0);
}
