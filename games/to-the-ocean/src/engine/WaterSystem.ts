// ============================================================================
// Water System — flat-shaded low-poly water
// ============================================================================

import { WaterBufferReader } from "@shared/water-buffer";
import { CameraState } from "./CameraSystem";
import { calculateViewProj } from "./mathUtils";
import { WeatherType } from "@shared/types";

// --- Shared WGSL preamble (structs, bindings, common helpers) ---
const PREAMBLE = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  time: f32,
  gridSize: f32,
  patchSize: f32,
  originX: f32,
  originZ: f32,
  visibility: f32,
  weatherType: u32,
  timeOfDay: f32,
  waveHeight: f32,
  windSpeed: f32,
  windDirX: f32,
  windDirZ: f32,
  weatherIntensity: f32,
  sunDirX: f32,
  sunDirY: f32,
  sunDirZ: f32,
  sunIntensity: f32,
  wakeCount: u32,
  shoreCount: u32,
};

const MAX_POINT_LIGHTS = 32u;
const MAX_SPOT_LIGHTS = 8u;

struct PointLight {
  position: vec3<f32>,
  radius: f32,
  color: vec3<f32>,
  intensity: f32,
};

struct SpotLight {
  position: vec3<f32>,
  radius: f32,
  direction: vec3<f32>,
  cosInner: f32,
  color: vec3<f32>,
  cosOuter: f32,
  intensity: f32,
  _pad: f32,
};

struct LightStorage {
  numPointLights: u32,
  numSpotLights: u32,
  _pad0: u32,
  _pad1: u32,
  pointLights: array<PointLight, MAX_POINT_LIGHTS>,
  spotLights: array<SpotLight, MAX_SPOT_LIGHTS>,
};

struct WakeSource {
  pos: vec2<f32>,
  dir: vec2<f32>,
  speed: f32,
  _pad: f32,
};

struct ShoreSource {
  pos: vec2<f32>,
  radius: f32,
  cutoutRadius: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var heightTex: texture_2d<f32>;
@group(0) @binding(2) var normalTex: texture_2d<f32>;
@group(0) @binding(3) var flowTex: texture_2d<f32>;
@group(0) @binding(4) var samp: sampler;
@group(0) @binding(5) var<storage, read> wakeSources: array<WakeSource>;
@group(0) @binding(6) var<storage, read> shoreSources: array<ShoreSource>;
@group(1) @binding(0) var<storage, read> lightData: LightStorage;

struct VertexInput {
  @location(0) position: vec2<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) viewDir: vec3<f32>,
  @location(3) waveHeight: f32,
  @location(4) normal: vec3<f32>,
  @location(5) foam: f32,
};

fn hash21(p: vec2<f32>) -> f32 {
  let q = fract(p * vec2<f32>(0.1031, 0.11369));
  return fract(dot(q, vec2<f32>(127.1, 311.7)) * 43758.5453);
}

fn hash22(p: vec2<f32>) -> vec2<f32> {
  let q = fract(p * vec2<f32>(0.1031, 0.11369));
  return -1.0 + 2.0 * fract(vec2<f32>(
    dot(q, vec2<f32>(127.1, 311.7)),
    dot(q, vec2<f32>(269.5, 183.3))
  ) * 43758.5453);
}

fn perlin2d(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let ga = hash22(i);
  let gb = hash22(i + vec2<f32>(1.0, 0.0));
  let gc = hash22(i + vec2<f32>(0.0, 1.0));
  let gd = hash22(i + vec2<f32>(1.0, 1.0));
  let va = dot(ga, f);
  let vb = dot(gb, f - vec2<f32>(1.0, 0.0));
  let vc = dot(gc, f - vec2<f32>(0.0, 1.0));
  let vd = dot(gd, f - vec2<f32>(1.0, 1.0));
  return mix(mix(va, vb, u.x), mix(vc, vd, u.x), u.y) * 0.5 + 0.5;
}

fn fbm(p: vec2<f32>) -> f32 {
  var v = 0.0;
  var a = 0.5;
  var pp = p;
  for (var i = 0; i < 4; i = i + 1) {
    v = v + a * perlin2d(pp);
    pp = pp * 2.0;
    a = a * 0.5;
  }
  return v;
}

// Wave displacement — high freq for visible chop. 4m grid needs >=16m wavelength (4 cells).
// freq 0.15 = 42m, 0.25 = 25m, 0.4 = 16m. Time very slow so waves roll gently.
fn waveHeight(worldX: f32, worldZ: f32, t: f32, amp: f32) -> f32 {
  let h1 = sin(worldX * 0.15 + t * 0.12) * cos(worldZ * 0.12 + t * 0.10) * 0.6;
  let h2 = sin(worldX * 0.4 - t * 0.2) * cos(worldZ * 0.35 + t * 0.15) * 0.15;
  let h3 = sin((worldX + worldZ) * 0.1 + t * 0.08) * 0.3;
  return (h1 + h2 + h3) * amp;
}

fn computeNormal(wx: f32, wz: f32, t: f32, amp: f32) -> vec3<f32> {
  let eps = 0.5;
  let h0 = waveHeight(wx, wz, t, amp);
  let hx = waveHeight(wx + eps, wz, t, amp);
  let hz = waveHeight(wx, wz + eps, t, amp);
  let dx = (hx - h0) / eps;
  let dz = (hz - h0) / eps;
  return normalize(vec3<f32>(-dx, 1.0, -dz));
}

// --- Wind-scaled chop amplitude: 0.15 calm → 0.8 storm ---
fn windChopAmp() -> f32 {
  let ss = clamp((uniforms.windSpeed - 2.0) / 23.0, 0.0, 1.0);
  return 0.15 + ss * 0.65;
}

// --- Boat wake displacement ---
// V-shaped pair of decaying sine ridges trailing behind a moving boat.
// Returns height displacement and foam factor (in .y).
fn wakeDisplacement(worldX: f32, worldZ: f32) -> vec2<f32> {
  var totalH = 0.0;
  var foam = 0.0;
  let n = uniforms.wakeCount;
  for (var i = 0u; i < n; i = i + 1u) {
    let src = wakeSources[i];
    let dx = worldX - src.pos.x;
    let dz = worldZ - src.pos.y;
    let dist = length(vec2<f32>(dx, dz));

    // Smooth distance fade instead of hard 60m cutoff
    let distFadeFar = 1.0 - smoothstep(50.0, 60.0, dist);
    if (distFadeFar < 0.001) { continue; }

    // Boat heading direction
    let dir = src.dir;
    // Forward offset (along heading) and lateral offset (perpendicular)
    let fwd = dx * dir.x + dz * dir.y;
    let lat = -dx * dir.y + dz * dir.x;

    // Smooth fade in front of the boat instead of hard cutoff
    let fwdFade = 1.0 - smoothstep(2.0, 8.0, fwd);
    if (fwdFade < 0.001) { continue; }

    // V-shape: wake angle ~20° → lateral spread = |fwd| * tan(20°) ≈ 0.36
    let wakeSpread = 0.36;
    let wakeEdge = abs(fwd) * wakeSpread;
    let lateralFade = 1.0 - smoothstep(wakeEdge * 0.7, wakeEdge, abs(lat));
    if (lateralFade < 0.01) { continue; }

    // Distance behind boat
    let behind = -fwd;
    let distFade = exp(-behind * 0.04); // fades over ~50m
    let speedFactor = clamp(src.speed / 10.0, 0.0, 1.5);

    // Combined fade factor
    let fade = distFadeFar * fwdFade;

    // Two wake ridges at slightly different frequencies
    let k = 0.5;
    let ridge1 = sin(behind * k - uniforms.time * 3.0) * 0.15;
    let ridge2 = sin(behind * k * 1.5 - uniforms.time * 4.0) * 0.08;
    let wakeH = (ridge1 + ridge2) * distFade * lateralFade * speedFactor * fade;
    totalH += wakeH;

    // Foam along wake centerline, strongest near boat
    let foamWidth = wakeEdge * 0.5;
    let foamLat = 1.0 - smoothstep(foamWidth * 0.3, foamWidth, abs(lat));
    foam += distFade * foamLat * speedFactor * 0.6 * fade;
  }
  return vec2<f32>(totalH, foam);
}

// --- Shoreline wave displacement ---
// Ring waves traveling toward shore obstacles, damped inside the radius.
// Returns height displacement and foam factor (in .y).
fn shoreDisplacement(worldX: f32, worldZ: f32) -> vec2<f32> {
  var totalH = 0.0;
  var foam = 0.0;
  let n = uniforms.shoreCount;
  for (var i = 0u; i < n; i = i + 1u) {
    let src = shoreSources[i];
    let r = src.radius;
    if (r < 0.001) { continue; } // skip cutout-only sources
    let dx = worldX - src.pos.x;
    let dz = worldZ - src.pos.y;
    let dist = length(vec2<f32>(dx, dz));

    // Match the shoreDamping transition: waves are flat at the beach edge (r)
    // and ramp up to full amplitude at dampR, then decay beyond.
    let flatR = r * 1.0;
    let dampR = r * 1.2 + 8.0;
    let rampUp = smoothstep(flatR, dampR, dist);
    if (rampUp < 0.001) { continue; }

    // Outer fade so ring waves eventually dissipate far from shore
    let bandEnd = dampR + 20.0;
    let fadeW = 8.0; // 2x patchSize transition
    let outerFade = 1.0 - smoothstep(bandEnd - fadeW, bandEnd, dist);
    if (outerFade < 0.001) { continue; }

    // Ring waves traveling inward toward shore (reversed: +time contracts rings)
    let ringDist = dist - r;
    let k = 0.2;
    // Shoaling: waves get taller as they approach shore (closer to flatR = bigger)
    let shoal = 1.0 - rampUp * 0.6; // 1.0 at beach, 0.4 at dampR
    let waveAmp = 0.5 * shoal;
    let ringH = sin(ringDist * k + uniforms.time * 0.35) * waveAmp;
    // Fade with distance from the outer edge of the damping zone
    let distFade = exp(-max(ringDist - (dampR - r), 0.0) * 0.08);
    totalH += ringH * distFade * outerFade;

    // Shore foam removed — it created a perfect white circular ring at the
    // entity scale radius that didn't match the actual irregular shoreline.
    // Ring wave displacement above still provides natural shore wave motion.
  }
  return vec2<f32>(totalH, foam);
}

// --- Shore damping: flatten ALL wave displacement near islands ---
// Returns 0.0 inside islands (flat water at sea level), 1.0 far from shore.
// Prevents the water mesh from clipping over island terrain in shallow areas.
fn shoreDamping(worldX: f32, worldZ: f32) -> f32 {
  var damping = 1.0;
  let n = uniforms.shoreCount;
  for (var i = 0u; i < n; i = i + 1u) {
    let src = shoreSources[i];
    let r = src.radius;
    if (r < 0.001) { continue; } // skip cutout-only sources
    let dx = worldX - src.pos.x;
    let dz = worldZ - src.pos.y;
    let dist = length(vec2<f32>(dx, dz));
    // Fully flat at the beach edge (island radius), full waves at 120% + 8m.
    // Matches the TS shoreDamping in shore-damping.ts.
    let flatR = r * 1.0;
    let dampR = r * 1.2 + 8.0;
    let d = smoothstep(flatR, dampR, dist);
    damping = min(damping, d);
  }
  return damping;
}

fn waterCutout(worldX: f32, worldZ: f32) -> bool {
  let n = uniforms.shoreCount;
  for (var i = 0u; i < n; i = i + 1u) {
    let src = shoreSources[i];
    if (src.cutoutRadius < 0.001) { continue; }
    let dx = worldX - src.pos.x;
    let dz = worldZ - src.pos.y;
    let dist = length(vec2<f32>(dx, dz));
    if (dist < src.cutoutRadius) { return true; }
  }
  return false;
}

fn fogAndNight(dist: f32, color: vec3<f32>) -> vec3<f32> {
  var c = color;
  let fogFactor = min(dist / 800.0, 1.0) * (1.0 - uniforms.visibility);
  c = mix(c, vec3<f32>(0.5, 0.6, 0.7), fogFactor);
  let nightFactor = 1.0 - smoothstep(0.2, 0.5, uniforms.timeOfDay);
  c *= (1.0 - nightFactor * 0.5);
  if (uniforms.weatherType == 4u || uniforms.weatherType == 8u) {
    c *= 0.6;
  }
  return c;
}

fn applyWaterDynamicLights(worldPos: vec3<f32>, N: vec3<f32>, viewDir: vec3<f32>) -> vec3<f32> {
  var color = vec3<f32>(0.0);
  let numPoint = lightData.numPointLights;
  for (var i = 0u; i < MAX_POINT_LIGHTS; i++) {
    if (i >= numPoint) { break; }
    let light = lightData.pointLights[i];
    let toLight = light.position - worldPos;
    let dist = length(toLight);
    if (dist > light.radius) { continue; }
    let L = toLight / max(dist, 0.001);
    let atten = 1.0 - smoothstep(0.0, light.radius, dist);
    let diff = max(dot(N, L), 0.0);
    color += light.color * diff * light.intensity * atten * 0.5;
    let halfDir = normalize(L + viewDir);
    let NdotH = max(dot(N, halfDir), 0.0);
    color += light.color * pow(NdotH, 32.0) * light.intensity * atten * 0.3;
  }
  let numSpot = lightData.numSpotLights;
  for (var i = 0u; i < MAX_SPOT_LIGHTS; i++) {
    if (i >= numSpot) { break; }
    let light = lightData.spotLights[i];
    let toLight = light.position - worldPos;
    let dist = length(toLight);
    if (dist > light.radius) { continue; }
    let L = toLight / max(dist, 0.001);
    let spotCos = dot(-L, light.direction);
    if (spotCos < light.cosOuter) { continue; }
    let spotAtten = smoothstep(light.cosOuter, light.cosInner, spotCos);
    let atten = (1.0 - smoothstep(0.0, light.radius, dist)) * spotAtten;
    let diff = max(dot(N, L), 0.0);
    color += light.color * diff * light.intensity * atten * 0.5;
    let halfDir = normalize(L + viewDir);
    let NdotH = max(dot(N, halfDir), 0.0);
    color += light.color * pow(NdotH, 32.0) * light.intensity * atten * 0.3;
  }
  return color;
}
`;

// ============================================================================
// Flat Shaded water — true flat shading per-triangle via derivatives
// ============================================================================
const WATER_WGSL = PREAMBLE + /* wgsl */ `
@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldX = uniforms.originX + input.position.x * uniforms.patchSize;
  let worldZ = uniforms.originZ + input.position.y * uniforms.patchSize;
  // Sample height from the simulation water buffer — same data BuoyancySystem uses.
  // This ensures visual waves match the waves the boat actually rides.
  let gs = i32(uniforms.gridSize);
  let ogx = i32(uniforms.originX / uniforms.patchSize);
  let ogz = i32(uniforms.originZ / uniforms.patchSize);
  var gx = (ogx + i32(input.position.x)) % gs;
  gx = (gx % gs + gs) % gs;
  var gz = (ogz + i32(input.position.y)) % gs;
  gz = (gz % gs + gs) % gs;
  let h = textureLoad(heightTex, vec2<i32>(gx, gz), 0).r;
  // Add high-frequency visual chop on top of the sim height.
  // This restores the faceted low-poly look — the sim waves are too smooth
  // for visible flat shading. The chop is small enough that it
  // doesn't cause clipping with the boat hull (depth test handles it).
  let t = uniforms.time;
  let chopAmp = windChopAmp();
  let chop = waveHeight(worldX, worldZ, t, chopAmp);

  // Boat wake displacement (visual only — small, doesn't affect buoyancy)
  let wake = wakeDisplacement(worldX, worldZ);
  // Shoreline wave displacement
  let shore = shoreDisplacement(worldX, worldZ);

  // Damp ALL displacement near islands to prevent water clipping over terrain.
  // Shore ring waves are NOT damped — they have their own rampUp that starts at 0
  // at the beach edge, so they're already flat where damping would zero them.
  let damping = shoreDamping(worldX, worldZ);
  let visualH = (h + chop + wake.x) * damping + shore.x;
  let worldPos = vec3<f32>(worldX, visualH, worldZ);
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  output.worldPos = worldPos;
  output.uv = input.position;
  output.viewDir = uniforms.cameraPos - worldPos;
  output.waveHeight = visualH;
  output.foam = wake.y + shore.y;
  // Normal from combined height (sim + chop + wake + shore) via finite differences
  var gx2 = (gx + 1) % gs;
  var gz2 = (gz + 1) % gs;
  let hx_sab = textureLoad(heightTex, vec2<i32>(gx2, gz), 0).r;
  let hz_sab = textureLoad(heightTex, vec2<i32>(gx, gz2), 0).r;
  let dampingX = shoreDamping(worldX + uniforms.patchSize, worldZ);
  let dampingZ = shoreDamping(worldX, worldZ + uniforms.patchSize);
  let hx = (hx_sab + waveHeight(worldX + uniforms.patchSize, worldZ, t, chopAmp) + wakeDisplacement(worldX + uniforms.patchSize, worldZ).x) * dampingX + shoreDisplacement(worldX + uniforms.patchSize, worldZ).x;
  let hz = (hz_sab + waveHeight(worldX, worldZ + uniforms.patchSize, t, chopAmp) + wakeDisplacement(worldX, worldZ + uniforms.patchSize).x) * dampingZ + shoreDisplacement(worldX, worldZ + uniforms.patchSize).x;
  let eps = uniforms.patchSize;
  let dx = (hx - visualH) / eps;
  let dz = (hz - visualH) / eps;
  output.normal = normalize(vec3<f32>(-dx, 1.0, -dz));
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  // Discard water fragments inside island peak blob cutout zones.
  // This creates holes in the water surface for cave openings.
  if (waterCutout(input.worldPos.x, input.worldPos.z)) {
    discard;
  }
  let viewDir = normalize(input.viewDir);
  let dist = length(input.viewDir);

  // True flat shading: compute face normal from screen-space derivatives.
  // Each triangle gets exactly one normal — no interpolation.
  let dpdx = dpdx(input.worldPos);
  let dpdy = dpdy(input.worldPos);
  var faceNormal = normalize(cross(dpdx, dpdy));
  // Ensure normal faces up (screen-space Y is down in WebGPU, cross may flip)
  if (faceNormal.y < 0.0) {
    faceNormal = -faceNormal;
  }

  // Quantize the face normal for discrete diffuse banding only.
  // Keep raw faceNormal for specular — more faces catch the reflection.
  var qn = faceNormal;
  qn.x = round(qn.x / 0.3) * 0.3;
  qn.y = round(qn.y / 0.3) * 0.3;
  qn.z = round(qn.z / 0.3) * 0.3;
  qn = normalize(qn);

  // Lighting from raw face normal — uses sun direction from LightingSystem (passed via uniforms)
  let sunDir = normalize(vec3<f32>(uniforms.sunDirX, uniforms.sunDirY, uniforms.sunDirZ));
  let sunIntensity = uniforms.sunIntensity;
  let diff = max(dot(faceNormal, sunDir), 0.0);
  let diffScaled = mix(0.15, diff, sunIntensity);

  // Color palette — dark, moody tones for deep ocean feel
  let color1 = vec3<f32>(0.01, 0.03, 0.06);   // deep shadow — almost black
  let color2 = vec3<f32>(0.02, 0.08, 0.14);   // shadow — dark blue
  let color3 = vec3<f32>(0.04, 0.16, 0.24);   // mid — dark teal
  let color4 = vec3<f32>(0.08, 0.28, 0.36);   // light — teal
  let color5 = vec3<f32>(0.15, 0.42, 0.48);   // bright — only sun-facing faces

  // Smooth blends between bands instead of hard if-else thresholds
  var waterColor = color1;
  waterColor = mix(waterColor, color2, smoothstep(0.0, 0.15, diffScaled));
  waterColor = mix(waterColor, color3, smoothstep(0.15, 0.35, diffScaled));
  waterColor = mix(waterColor, color4, smoothstep(0.35, 0.6, diffScaled));
  waterColor = mix(waterColor, color5, smoothstep(0.6, 0.9, diffScaled));

  // Specular using RAW face normal — each face reflects individually.
  // Low power + high intensity so many faces show visible sun glints.
  // Dampen heavily in storm conditions — overcast skies scatter sunlight,
  // killing direct specular reflection on the water surface.
  let halfDir = normalize(sunDir + viewDir);
  let NdotH = max(dot(faceNormal, halfDir), 0.0);
  let stormFactor = select(1.0, 0.15, uniforms.weatherType == 4u || uniforms.weatherType == 8u);
  let spec = pow(NdotH, 16.0);
  waterColor += vec3<f32>(1.0, 0.95, 0.8) * spec * 0.8 * stormFactor * sunIntensity;
  // Very wide ambient specular — faces generally facing sun get a glow
  let spec2 = pow(NdotH, 4.0);
  waterColor += vec3<f32>(0.5, 0.65, 0.8) * spec2 * 0.1 * stormFactor * sunIntensity;

  // Height-based tint — smooth transitions for crests/troughs
  let hNorm = input.waveHeight / max(uniforms.waveHeight, 0.01);
  waterColor = mix(waterColor, vec3<f32>(0.0, 0.02, 0.05), smoothstep(0.1, -0.4, hNorm) * 0.4);
  waterColor = mix(waterColor, vec3<f32>(0.12, 0.32, 0.38), smoothstep(0.2, 0.5, hNorm) * 0.2);

  // Edge darkening — detect triangle edges via fwidth of worldPos.
  // Large derivative = near edge between triangles.
  let edge = fwidth(input.worldPos.x) + fwidth(input.worldPos.z);
  let edgeFactor = 1.0 - smoothstep(uniforms.patchSize * 0.3, uniforms.patchSize * 0.48, edge);
  waterColor *= mix(0.5, 1.0, edgeFactor);

  // Fresnel — per-face, subtle sky reflection on grazing angles
  let fresnel = pow(1.0 - max(dot(viewDir, faceNormal), 0.0), 4.0);
  waterColor = mix(waterColor, vec3<f32>(0.3, 0.5, 0.75), fresnel * 0.3);

  // --- Whitecaps: foam on steep faces in high wind ---
  // Faces whose normal deviates strongly from up AND sit near crests
  // get a flat foam color. Coverage scales with wind speed.
  let windSS = clamp((uniforms.windSpeed - 8.0) / 17.0, 0.0, 1.0);
  let steepness = 1.0 - faceNormal.y; // 0 = flat, 1 = vertical
  let crestFactor = smoothstep(0.15, 0.5, hNorm);
  let whitecapMask = smoothstep(0.25, 0.45, steepness) * crestFactor * windSS;
  let foamColor = vec3<f32>(0.75, 0.78, 0.72);
  waterColor = mix(waterColor, foamColor, whitecapMask);

  // --- Wake & shore foam ---
  // Hard-edged bands from the vertex shader foam factor.
  let wakeFoamMask = smoothstep(0.3, 0.5, input.foam);
  waterColor = mix(waterColor, foamColor, wakeFoamMask * 0.8);

  // Dynamic light reflections on water surface
  waterColor += applyWaterDynamicLights(input.worldPos, faceNormal, viewDir);

  let c = fogAndNight(dist, waterColor);

  // Underwater fog — obscure objects viewed through the water surface.
  // Uses water path length (distance / cos(viewAngle)) so looking straight
  // down through shallow water stays clear, while grazing angles and distant
  // water fog out to deep blue.
  let cosTheta = max(dot(viewDir, vec3<f32>(0.0, 1.0, 0.0)), 0.05);
  let waterPath = dist / cosTheta;
  let underwaterFog = 1.0 - exp(-waterPath * 0.015);
  let fogColor = vec3<f32>(0.02, 0.08, 0.12);
  let finalColor = mix(c, fogColor, underwaterFog * 0.7);
  let finalAlpha = mix(0.85, 0.99, underwaterFog);
  return vec4<f32>(finalColor, finalAlpha);
}
`;

export class WaterSystem {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private indexCount = 0;
  private heightTexture: GPUTexture | null = null;
  private normalTexture: GPUTexture | null = null;
  private flowTexture: GPUTexture | null = null;
  private sampler: GPUSampler | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private lightBindGroup: GPUBindGroup | null = null;
  private lightBindGroupLayout: GPUBindGroupLayout | null = null;
  private wakeBuffer: GPUBuffer | null = null;
  private shoreBuffer: GPUBuffer | null = null;
  private wakeData: Float32Array | null = null;
  private shoreData: Float32Array | null = null;
  private wakeCount = 0;
  private shoreCount = 0;
  private time = 0;
  private cachedNormalData: Uint8Array | null = null;
  private cachedHeightData: Float32Array | null = null;

  static readonly MAX_WAKES = 16;
  static readonly MAX_SHORES = 128;
  // WakeSource: pos.x, pos.y, dir.x, dir.y, speed, _pad = 6 floats
  static readonly WAKE_FLOATS = 6;
  // ShoreSource: pos.x, pos.y, radius, cutoutRadius = 4 floats (vec2 + 2 floats, std140 padded to 4 floats)
  static readonly SHORE_FLOATS = 4;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  async init(): Promise<void> {
    // Uniform buffer (256 bytes)
    this.uniformBuffer = this.device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create grid vertices (256x256 quad grid)
    const gridSize = 256;
    const vertices: number[] = [];
    for (let z = 0; z < gridSize; z++) {
      for (let x = 0; x < gridSize; x++) {
        vertices.push(x, z);
      }
    }
    this.vertexBuffer = this.device.createBuffer({
      size: vertices.length * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.vertexBuffer, 0, new Float32Array(vertices));

    // Create index buffer for triangle-list grid
    const indices: number[] = [];
    for (let z = 0; z < gridSize - 1; z++) {
      for (let x = 0; x < gridSize - 1; x++) {
        const i = z * gridSize + x;
        indices.push(i, i + 1, i + gridSize);
        indices.push(i + 1, i + gridSize + 1, i + gridSize);
      }
    }
    this.indexCount = indices.length;
    this.indexBuffer = this.device.createBuffer({
      size: indices.length * 2,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.indexBuffer!, 0, new Uint16Array(indices));

    // Create textures for water data
    this.heightTexture = this.device.createTexture({
      size: [gridSize, gridSize],
      format: "r32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.normalTexture = this.device.createTexture({
      size: [gridSize, gridSize],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.flowTexture = this.device.createTexture({
      size: [gridSize, gridSize],
      format: "rg16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    this.sampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });

    // Storage buffers for dynamic wave sources (wakes + shores)
    const wakeBufSize = WaterSystem.MAX_WAKES * WaterSystem.WAKE_FLOATS * 4;
    const shoreBufSize = WaterSystem.MAX_SHORES * WaterSystem.SHORE_FLOATS * 4;
    this.wakeBuffer = this.device.createBuffer({
      size: wakeBufSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.shoreBuffer = this.device.createBuffer({
      size: shoreBufSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.wakeData = new Float32Array(WaterSystem.MAX_WAKES * WaterSystem.WAKE_FLOATS);
    this.shoreData = new Float32Array(WaterSystem.MAX_SHORES * WaterSystem.SHORE_FLOATS);

    // Bind group layout
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "unfilterable-float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 5, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 6, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      ],
    });

    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.heightTexture.createView() },
        { binding: 2, resource: this.normalTexture.createView() },
        { binding: 3, resource: this.flowTexture.createView() },
        { binding: 4, resource: this.sampler },
        { binding: 5, resource: { buffer: this.wakeBuffer } },
        { binding: 6, resource: { buffer: this.shoreBuffer } },
      ],
    });

    // Light bind group layout (group 1 — shared with entity renderer)
    this.lightBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout, this.lightBindGroupLayout],
    });

    const vertexLayout = {
      arrayStride: 8,
      attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" as GPUVertexFormat }],
    };

    const blendState: GPUBlendState = {
      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    };

    const shaderModule = this.device.createShaderModule({ code: WATER_WGSL });
    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
        buffers: [vertexLayout],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.format, blend: blendState }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

    console.log(`[Water] Initialized flat-shaded water`);
  }

  setLightBindGroup(bg: GPUBindGroup): void {
    this.lightBindGroup = bg;
  }

  updateDynamics(
    wakes: Float32Array,
    wakeCount: number,
    shores: Float32Array,
    shoreCount: number,
  ): void {
    if (!this.wakeBuffer || !this.shoreBuffer || !this.wakeData || !this.shoreData) return;
    const wc = Math.min(wakeCount, WaterSystem.MAX_WAKES);
    const sc = Math.min(shoreCount, WaterSystem.MAX_SHORES);
    this.wakeData.set(wakes.subarray(0, wc * WaterSystem.WAKE_FLOATS));
    this.shoreData.set(shores.subarray(0, sc * WaterSystem.SHORE_FLOATS));
    this.device.queue.writeBuffer(this.wakeBuffer, 0, this.wakeData as unknown as Float32Array<ArrayBuffer>);
    this.device.queue.writeBuffer(this.shoreBuffer, 0, this.shoreData as unknown as Float32Array<ArrayBuffer>);
    this.wakeCount = wc;
    this.shoreCount = sc;
  }

  render(
    passEncoder: GPURenderPassEncoder,
    camera: CameraState,
    waterReader: WaterBufferReader,
    timeOfDay: number,
    weatherType: WeatherType,
    visibility: number,
    windSpeed: number,
    windDirX: number,
    windDirZ: number,
    weatherIntensity: number,
    sunDir: [number, number, number],
    sunIntensity: number,
  ): void {
    if (!this.pipeline || !this.bindGroup || !this.uniformBuffer) return;
    if (!waterReader.isValid()) return;

    this.time += 0.016;

    // Update height texture from SAB
    const gridSize = waterReader.getGridSize();
    if (gridSize === 0) return;
    const heightBytes = gridSize * gridSize;
    if (!this.cachedHeightData || this.cachedHeightData.length !== heightBytes) {
      this.cachedHeightData = new Float32Array(heightBytes);
    }
    this.cachedHeightData.set(waterReader.heights);
    this.device.queue.writeTexture(
      { texture: this.heightTexture! },
      this.cachedHeightData as unknown as Float32Array<ArrayBuffer>,
      { bytesPerRow: gridSize * 4 },
      { width: gridSize, height: gridSize },
    );

    // Update normal texture (cached — normals don't change)
    if (!this.cachedNormalData) {
      const gs = waterReader.getGridSize();
      this.cachedNormalData = new Uint8Array(gs * gs * 4);
      for (let i = 0; i < gs * gs; i++) {
        this.cachedNormalData[i * 4 + 0] = 128;
        this.cachedNormalData[i * 4 + 1] = 128;
        this.cachedNormalData[i * 4 + 2] = 255;
        this.cachedNormalData[i * 4 + 3] = 255;
      }
    }
    this.device.queue.writeTexture(
      { texture: this.normalTexture! },
      this.cachedNormalData as unknown as Uint8Array<ArrayBuffer>,
      { bytesPerRow: waterReader.getGridSize() * 4 },
      { width: waterReader.getGridSize(), height: waterReader.getGridSize() },
    );

    // Calculate view-projection matrix
    const viewProj = calculateViewProj(camera);
    const patchSize = waterReader.getPatchSize();
    const halfGrid = (gridSize * patchSize) / 2;
    const originX = Math.round((camera.target[0] - halfGrid) / patchSize) * patchSize;
    const originZ = Math.round((camera.target[2] - halfGrid) / patchSize) * patchSize;

    // Write uniforms (38 f32 + 2 u32 = 152 bytes, fits in 256-byte buffer)
    const uniforms = new Float32Array(38);
    for (let i = 0; i < 16; i++) uniforms[i] = viewProj[i];
    uniforms[16] = camera.position[0];
    uniforms[17] = camera.position[1];
    uniforms[18] = camera.position[2];
    uniforms[19] = this.time;
    uniforms[20] = gridSize;
    uniforms[21] = patchSize;
    uniforms[22] = originX;
    uniforms[23] = originZ;
    uniforms[24] = visibility;
    // weatherType is u32 — write via DataView at byte offset 100
    const dv = new DataView(uniforms.buffer);
    dv.setUint32(100, weatherType, true);
    uniforms[26] = timeOfDay;
    uniforms[27] = 2.0; // wave height amplitude (sim ~1.77 + chop ~0.8)
    uniforms[28] = windSpeed;
    uniforms[29] = windDirX;
    uniforms[30] = windDirZ;
    uniforms[31] = weatherIntensity;
    uniforms[32] = sunDir[0];
    uniforms[33] = sunDir[1];
    uniforms[34] = sunDir[2];
    uniforms[35] = sunIntensity;
    // wakeCount and shoreCount are u32 — write as Uint32View at byte offset 144
    const uniformU32 = new Uint32Array(uniforms.buffer, 144, 2);
    uniformU32[0] = this.wakeCount;
    uniformU32[1] = this.shoreCount;

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this.bindGroup);
    if (this.lightBindGroup) {
      passEncoder.setBindGroup(1, this.lightBindGroup);
    }
    passEncoder.setVertexBuffer(0, this.vertexBuffer);
    passEncoder.setIndexBuffer(this.indexBuffer!, "uint16");
    passEncoder.drawIndexed(this.indexCount);
  }
}
