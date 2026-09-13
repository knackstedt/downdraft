// ============================================================================
// WebGPU Renderer — sandbox rendering engine
// Extends GameRenderer for device/surface init, runs a custom render loop
// for skybox, ground plane, and prop model rendering.
//
// Visual overhaul: scene renders into the PostProcessStack HDR scene target
// (rgba16float) via the engine FrameGraph, then bloom + tonemap + FXAA +
// vignette are applied and blitted to the LDR swapchain.
// ============================================================================

import {
    BindlessFrameBindings, BindlessMaterialManager, BindlessTextureRegistry,
    DEPTH_FORMAT, ENT, GameRenderer,
    InputBufferWriter, InterpolationBuffer,
    MSAA_SAMPLE_COUNT, SimBufferReader,
    calculateViewProjInto,
    type CameraState,
    type RenderContext, type TextureHandle
} from "@downdraft/core";
import { ModelRenderer } from "@downdraft/library-entities";
import { loadModel, type ModelData } from "@downdraft/library-models";
import { PostProcessStack } from "@downdraft/library-postfx";
import { ENT_DATA, SIM_TICK_DT } from "@sandbox/shared/constants/buffer";
import { EntityType } from "@sandbox/shared/types";
import { mat4 } from "wgpu-matrix";
import { computeConvexHullFaces, computeConvexHullPoints } from "./hull";
import { SandboxLighting, type PointLight } from "./lighting";
import { MipmapHelper } from "./mipmap-helper";
import { SceneRenderPass, type SceneDrawFn, type ScenePassState } from "./passes/scene-pass";
import { SandboxShadows } from "./shadows";

// Skybox gradient shader — uses inverse view-projection to reconstruct the
// world-space view direction per pixel, so the gradient is based on the
// actual look direction (up = zenith, horizon = bright, down = ground haze).
const SKY_SHADER = /* wgsl */ `
struct SkyUniforms {
  invViewProj: mat4x4f,
  cameraPos: vec3f,
};
@group(0) @binding(0) var<uniform> u: SkyUniforms;

struct VertexOut {
  @builtin(position) clipPos: vec4f,
  @location(0) ndc: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VertexOut {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0),
  );
  var out: VertexOut;
  out.clipPos = vec4f(pos[vi], 0.999, 1.0);
  out.ndc = pos[vi];
  return out;
}

@fragment
fn fs(in: VertexOut) -> @location(0) vec4f {
  // Reconstruct world-space view direction from NDC (z = 1.0 = far plane)
  let ndc = vec4f(in.ndc, 1.0, 1.0);
  let world = u.invViewProj * ndc;
  let worldDir = normalize(world.xyz / world.w - u.cameraPos);

  // Use the world-space direction Y component for the gradient.
  // up = +1 (zenith), horizon = 0, down = -1 (ground haze)
  let t = clamp(worldDir.y, -1.0, 1.0);

  // Sky gradient: ground haze → horizon → mid sky → zenith
  let groundHaze = vec3f(0.08, 0.07, 0.06);
  let horizon = vec3f(0.12, 0.13, 0.16);
  let mid = vec3f(0.07, 0.10, 0.18);
  let zenith = vec3f(0.02, 0.05, 0.12);

  var color: vec3f;
  if (t < 0.0) {
    // Below horizon — ground haze
    color = mix(horizon, groundHaze, smoothstep(0.0, -0.3, t));
  } else {
    // Above horizon — horizon → mid → zenith
    color = mix(horizon, mid, smoothstep(0.0, 0.4, t));
    color = mix(color, zenith, smoothstep(0.3, 1.0, t));
  }
  return vec4f(color, 1.0);
}
`;

// Ground plane shader — multi-tier grid with distance markers and numeric labels
const GROUND_SHADER = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4f,
  cameraPos: vec3f,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(1) @binding(0) var paintTex: texture_2d<f32>;
@group(1) @binding(1) var paintSampler: sampler;
@group(1) @binding(2) var digitTex: texture_2d<f32>;

struct FrameLighting {
  sunDir: vec3f,
  ambientIntensity: f32,
  sunColor: vec3f,
  pointLightCount: u32,
  skyAmbient: vec3f,
  _pad0: u32,
  groundAmbient: vec3f,
  _pad1: u32,
  pointLights: array<vec4f, 16>,
};
@group(2) @binding(0) var<uniform> lighting: FrameLighting;

struct ShadowUniforms {
  lightVP: mat4x4f,
  texelSize: f32,
  bias: f32,
  normalBias: f32,
  shadowStrength: f32,
};
@group(3) @binding(0) var<uniform> shadowU: ShadowUniforms;
@group(3) @binding(1) var shadowMap: texture_depth_2d;
@group(3) @binding(2) var shadowSampler: sampler_comparison;

fn pcfShadow(worldPos: vec3f, N: vec3f) -> f32 {
  let shadowCoord = shadowU.lightVP * vec4f(worldPos, 1.0);
  let shadowUV = vec2f(
    shadowCoord.x / shadowCoord.w * 0.5 + 0.5,
    1.0 - (shadowCoord.y / shadowCoord.w * 0.5 + 0.5),
  );
  let shadowDepth = shadowCoord.z / shadowCoord.w * 0.5 + 0.5;
  if (shadowUV.x < 0.0 || shadowUV.x > 1.0 || shadowUV.y < 0.0 || shadowUV.y > 1.0) {
    return 1.0;
  }
  let lightDir = normalize(lighting.sunDir);
  let slopeScale = clamp(1.0 - dot(N, lightDir), 0.0, 1.0);
  let adjustedBias = shadowU.bias + shadowU.normalBias * slopeScale;
  // 3x3 PCF
  var shadow = 0.0;
  let texel = shadowU.texelSize;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let offset = vec2f(f32(x), f32(y)) * texel;
      shadow += textureSampleCompareLevel(shadowMap, shadowSampler, shadowUV + offset, shadowDepth - adjustedBias);
    }
  }
  shadow = shadow / 9.0;
  return mix(1.0, shadow, shadowU.shadowStrength);
}

// Returns a grid line intensity for a given world coordinate.
// 'spacing' is the grid cell size in meters; 'width' is the line thickness.
// Lines are centered on multiples of 'spacing' (including 0).
// Uses fwidth for screen-space anti-aliasing — lines fade out smoothly
// when they become sub-pixel, preventing moiré/aliasing at distance.
fn gridLine(coord: f32, spacing: f32, width: f32) -> f32 {
  let p = abs(fract(coord / spacing - 0.5) - 0.5) * spacing;
  // Screen-space pixel size in world units for this coordinate
  let px = fwidth(coord);
  // Line half-width in world units, at least 1 pixel for AA
  let hw = max(width, px * 1.5);
  return 1.0 - smoothstep(hw - px, hw, p);
}

// Concentric distance ring at a given radius from origin.
// Uses fwidth for screen-space anti-aliasing.
fn distanceRing(worldXZ: vec2f, radius: f32, width: f32) -> f32 {
  let d = length(worldXZ);
  let ringDist = abs(d - radius);
  let px = fwidth(d);
  let hw = max(width, px * 1.5);
  return 1.0 - smoothstep(hw - px, hw, ringDist);
}

// Extract the digit at position 'digitIndex' (0=ones, 1=tens, 2=hundreds).
fn extractDigit(number: i32, digitIndex: i32) -> i32 {
  var n = number;
  for (var i = 0; i < digitIndex; i++) {
    n = n / 10;
  }
  return n % 10;
}

fn numDigits(n: i32) -> i32 {
  if (n < 10) { return 1; }
  if (n < 100) { return 2; }
  return 3;
}

// Render a number along the X axis at markerX (digits extend in X, height in Z).
// Returns text coverage [0,1]. Uses the digit atlas (10 digits in a 640x96 strip).
// digitW/h are world-space dimensions per digit.
fn renderNumberX(worldPos: vec3f, markerX: f32, number: i32, digitW: f32, digitH: f32) -> f32 {
  let nd = numDigits(number);
  let totalW = f32(nd) * digitW;
  let halfW = totalW * 0.5;
  let halfH = digitH * 0.5;

  let dx = worldPos.x - markerX;
  let dz = worldPos.z;

  if (abs(dz) > halfH || abs(dx) > halfW) { return 0.0; }

  let localX = dx + halfW;
  let digitIdx = i32(clamp(localX / digitW, 0.0, f32(nd) - 1.0));
  let digitLocalU = fract(localX / digitW);

  let digitVal = extractDigit(number, nd - 1 - digitIdx);
  let atlasU = (f32(digitVal) + digitLocalU) / 10.0;
  let atlasV = (dz + halfH) / digitH;

  // textureSampleLevel (not textureSample) — allowed in non-uniform control flow.
  let sample = textureSampleLevel(digitTex, paintSampler, vec2f(atlasU, atlasV), 0.0);
  return sample.a;
}

// Render a number along the Z axis at markerZ (digits extend in Z, height in X).
fn renderNumberZ(worldPos: vec3f, markerZ: f32, number: i32, digitW: f32, digitH: f32) -> f32 {
  let nd = numDigits(number);
  let totalW = f32(nd) * digitW;
  let halfW = totalW * 0.5;
  let halfH = digitH * 0.5;

  let dz = worldPos.z - markerZ;
  let dx = worldPos.x;

  if (abs(dx) > halfH || abs(dz) > halfW) { return 0.0; }

  let localZ = dz + halfW;
  let digitIdx = i32(clamp(localZ / digitW, 0.0, f32(nd) - 1.0));
  // Mirror horizontally — the Z axis reads from the +X side, so digits
  // need to be flipped to appear correctly when viewed from that direction.
  let digitLocalU = 1.0 - fract(localZ / digitW);

  let digitVal = extractDigit(number, nd - 1 - digitIdx);
  let atlasU = (f32(digitVal) + digitLocalU) / 10.0;
  let atlasV = (dx + halfH) / digitH;

  let sample = textureSampleLevel(digitTex, paintSampler, vec2f(atlasU, atlasV), 0.0);
  return sample.a;
}

struct VertexOut {
  @builtin(position) clipPos: vec4f,
  @location(0) worldPos: vec3f,
};

@vertex
fn vs(@location(0) pos: vec3f) -> VertexOut {
  var out: VertexOut;
  out.clipPos = u.viewProj * vec4f(pos, 1.0);
  out.worldPos = pos;
  return out;
}

@fragment
fn fs(in: VertexOut) -> @location(0) vec4f {
  let worldPos = in.worldPos;
  let xz = worldPos.xz;

  // Distance from camera (for grid line anti-aliasing / fade)
  let camDist = length(xz - u.cameraPos.xz);

  // ── Base floor color ──
  let baseColor = vec3f(0.18, 0.19, 0.22);

  // ── Multi-tier grid ──
  // fwidth in gridLine() handles distance-based fade automatically —
  // lines smoothly disappear when they become sub-pixel.
  let minorX = gridLine(worldPos.x, 1.0, 0.03);
  let minorZ = gridLine(worldPos.z, 1.0, 0.03);
  let minorGrid = max(minorX, minorZ);

  let medX = gridLine(worldPos.x, 10.0, 0.06);
  let medZ = gridLine(worldPos.z, 10.0, 0.06);
  let medGrid = max(medX, medZ);

  let majorX = gridLine(worldPos.x, 100.0, 0.12);
  let majorZ = gridLine(worldPos.z, 100.0, 0.12);
  let majorGrid = max(majorX, majorZ);

  // Grid colors
  let minorColor = vec3f(0.28, 0.30, 0.34);
  let medColor   = vec3f(0.38, 0.42, 0.48);
  let majorColor = vec3f(0.55, 0.60, 0.68);

  var color = baseColor;
  color = mix(color, minorColor, minorGrid * 0.5);
  color = mix(color, medColor,   medGrid * 0.7);
  color = mix(color, majorColor, majorGrid * 0.9);

  // ── Axis lines (X = warm red, Z = cool blue) ──
  // fwidth-based AA for crisp lines that don't alias at distance.
  {
    let pxZ = fwidth(worldPos.z);
    let pxX = fwidth(worldPos.x);
    let axisWidth = 0.04;
    let hwZ = max(axisWidth, pxZ * 1.5);
    let hwX = max(axisWidth, pxX * 1.5);
    let xAxisLine = 1.0 - smoothstep(hwZ - pxZ, hwZ, abs(worldPos.z));
    let zAxisLine = 1.0 - smoothstep(hwX - pxX, hwX, abs(worldPos.x));
    let xAxisFade = clamp(1.0 - abs(worldPos.x) / 250.0, 0.0, 1.0);
    let zAxisFade = clamp(1.0 - abs(worldPos.z) / 250.0, 0.0, 1.0);
    color = mix(color, vec3f(0.85, 0.3, 0.15), xAxisLine * xAxisFade * 0.8);
    color = mix(color, vec3f(0.15, 0.4, 0.85), zAxisLine * zAxisFade * 0.8);
  }

  // ── Distance rings (concentric, from origin) ──
  var ringIntensity = 0.0;
  var ringColor = vec3f(0.0);

  let r10 = distanceRing(xz, 10.0, 0.08);
  ringIntensity = max(ringIntensity, r10 * 0.4);
  ringColor = mix(ringColor, vec3f(0.4, 0.5, 0.55), r10);

  let r50 = distanceRing(xz, 50.0, 0.15);
  ringIntensity = max(ringIntensity, r50 * 0.5);
  ringColor = mix(ringColor, vec3f(0.5, 0.55, 0.6), r50);

  let r100 = distanceRing(xz, 100.0, 0.25);
  ringIntensity = max(ringIntensity, r100 * 0.6);
  ringColor = mix(ringColor, vec3f(0.6, 0.6, 0.65), r100);

  let r200 = distanceRing(xz, 200.0, 0.4);
  ringIntensity = max(ringIntensity, r200 * 0.7);
  ringColor = mix(ringColor, vec3f(0.7, 0.65, 0.6), r200);

  let r500 = distanceRing(xz, 500.0, 0.6);
  ringIntensity = max(ringIntensity, r500 * 0.8);
  ringColor = mix(ringColor, vec3f(0.8, 0.7, 0.55), r500);

  color = mix(color, ringColor, ringIntensity);

  // ── Numeric distance markers along axes ──
  // Numbers at every 10m along both axes, showing the coordinate value.
  // Digit size: 0.4m wide, 0.6m tall — small but crisp.
  let markerSpacing = 10.0;
  let digitW = 0.4;
  let digitH = 0.6;
  let textColor = vec3f(0.9, 0.92, 0.95);

  // X axis: numbers at x = ±10, ±20, ..., ±250
  let nearestMarkerX = round(worldPos.x / markerSpacing) * markerSpacing;
  var textCoverage = 0.0;
  if (abs(nearestMarkerX) > 0.5 && abs(nearestMarkerX) < 251.0) {
    let num = i32(abs(nearestMarkerX));
    textCoverage = max(textCoverage, renderNumberX(worldPos, nearestMarkerX, num, digitW, digitH));
  }
  // Z axis: numbers at z = ±10, ±20, ..., ±250
  let nearestMarkerZ = round(worldPos.z / markerSpacing) * markerSpacing;
  if (abs(nearestMarkerZ) > 0.5 && abs(nearestMarkerZ) < 251.0) {
    let num = i32(abs(nearestMarkerZ));
    textCoverage = max(textCoverage, renderNumberZ(worldPos, nearestMarkerZ, num, digitW, digitH));
  }
  color = mix(color, textColor, textCoverage * 0.85);

  // ── Paint texture (512m ground, 512px texture, 1m = 1px) ──
  let paintUV = vec2f(worldPos.x / 512.0 + 0.5, worldPos.z / 512.0 + 0.5);
  let paint = textureSample(paintTex, paintSampler, paintUV);
  let finalColor = mix(color, paint.rgb, paint.a);

  // ── Lighting: ground normal is up (0,1,0) ──
  let N = vec3f(0.0, 1.0, 0.0);
  let sunDir = normalize(lighting.sunDir);
  let sunShadow = pcfShadow(worldPos, N);
  let diffuse = max(dot(N, sunDir), 0.0) * lighting.sunColor * sunShadow;
  let hemisphere = lighting.skyAmbient;
  var litColor = finalColor * (hemisphere * lighting.ambientIntensity + diffuse);

  // Point lights
  let plCount = lighting.pointLightCount;
  for (var i = 0u; i < plCount; i++) {
    let pl0 = lighting.pointLights[i * 2u];
    let pl1 = lighting.pointLights[i * 2u + 1u];
    let plPos = pl0.xyz;
    let plRadius = pl0.w;
    let plColor = pl1.xyz;
    let plIntensity = pl1.w;
    let L = plPos - worldPos;
    let dist = length(L);
    if (dist < plRadius) {
      let atten = 1.0 / (1.0 + dist * dist / (plRadius * plRadius));
      let ndotl = max(dot(N, normalize(L)), 0.0);
      litColor += finalColor * plColor * plIntensity * atten * ndotl;
    }
  }

  // Distance fog — match sky ambient color
  let fog = clamp(1.0 - camDist / 400.0, 0.0, 1.0);
  let fogColor = lighting.skyAmbient;
  return vec4f(mix(fogColor, litColor, fog), 1.0);
}
`;

// Procedural cube shader with paint texture support + colored lighting.
const CUBE_SHADER = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4f,
  cameraPos: vec3f,
  time: f32,
};
struct Instance {
  model: mat4x4f,
  color: vec4f,
  hasPaint: u32,
  _pad0: u32,
  _pad1: u32,
  ghostMode: u32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> instances: array<Instance>;
@group(1) @binding(0) var paintTex: texture_2d<f32>;
@group(1) @binding(1) var paintSampler: sampler;

struct FrameLighting {
  sunDir: vec3f,
  ambientIntensity: f32,
  sunColor: vec3f,
  pointLightCount: u32,
  skyAmbient: vec3f,
  _pad0: u32,
  groundAmbient: vec3f,
  _pad1: u32,
  pointLights: array<vec4f, 16>,
};
@group(2) @binding(0) var<uniform> lighting: FrameLighting;

struct ShadowUniforms {
  lightVP: mat4x4f,
  texelSize: f32,
  bias: f32,
  normalBias: f32,
  shadowStrength: f32,
};
@group(3) @binding(0) var<uniform> shadowU: ShadowUniforms;
@group(3) @binding(1) var shadowMap: texture_depth_2d;
@group(3) @binding(2) var shadowSampler: sampler_comparison;

fn pcfShadow(worldPos: vec3f, N: vec3f) -> f32 {
  let shadowCoord = shadowU.lightVP * vec4f(worldPos, 1.0);
  let shadowUV = vec2f(
    shadowCoord.x / shadowCoord.w * 0.5 + 0.5,
    1.0 - (shadowCoord.y / shadowCoord.w * 0.5 + 0.5),
  );
  let shadowDepth = shadowCoord.z / shadowCoord.w * 0.5 + 0.5;
  if (shadowUV.x < 0.0 || shadowUV.x > 1.0 || shadowUV.y < 0.0 || shadowUV.y > 1.0) {
    return 1.0;
  }
  let lightDir = normalize(lighting.sunDir);
  let slopeScale = clamp(1.0 - dot(N, lightDir), 0.0, 1.0);
  let adjustedBias = shadowU.bias + shadowU.normalBias * slopeScale;
  var shadow = 0.0;
  let texel = shadowU.texelSize;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let offset = vec2f(f32(x), f32(y)) * texel;
      shadow += textureSampleCompareLevel(shadowMap, shadowSampler, shadowUV + offset, shadowDepth - adjustedBias);
    }
  }
  shadow = shadow / 9.0;
  return mix(1.0, shadow, shadowU.shadowStrength);
}

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) normal: vec3f,
  @location(2) worldPos: vec3f,
  @location(3) color: vec4f,
  @location(4) hasPaint: f32,
  @location(5) ghostMode: f32,
}

@vertex
fn vs(@builtin(instance_index) ii: u32, @location(0) pos: vec3f, @location(1) uv: vec2f, @location(2) normal: vec3f) -> VertexOut {
  let inst = instances[ii];
  var out: VertexOut;
  let worldPos4 = inst.model * vec4f(pos, 1.0);
  out.position = u.viewProj * worldPos4;
  out.uv = uv;
  // Transform normal by model matrix (assuming uniform scale)
  let n = (inst.model * vec4f(normal, 0.0)).xyz;
  out.normal = normalize(n);
  out.worldPos = worldPos4.xyz;
  out.color = inst.color;
  out.hasPaint = f32(inst.hasPaint);
  out.ghostMode = f32(inst.ghostMode);
  return out;
}

@fragment
fn fs(in: VertexOut) -> @location(0) vec4f {
  let baseColor = in.color.rgb;
  // Always sample the paint texture (textureSampleLevel doesn't require
  // uniform control flow, unlike textureSample). Use in.hasPaint as a mix
  // multiplier so unpainted cubes (hasPaint=0) keep their base color.
  let paint = textureSampleLevel(paintTex, paintSampler, in.uv, 0.0);
  let paintMask = paint.a * in.hasPaint;
  var color = mix(baseColor, paint.rgb, paintMask);
  // Colored directional lighting from the frame-lighting UBO
  let N = normalize(in.normal);
  let sunDir = normalize(lighting.sunDir);
  let sunShadow = pcfShadow(in.worldPos, N);
  let diffuse = max(dot(N, sunDir), 0.0) * lighting.sunColor * sunShadow;
  // Hemisphere ambient: blend sky/ground based on normal direction
  let hemiMix = N.y * 0.5 + 0.5;
  let hemisphere = mix(lighting.groundAmbient, lighting.skyAmbient, hemiMix);
  var litColor = color * (hemisphere * lighting.ambientIntensity + diffuse);
  // Point lights
  let plCount = lighting.pointLightCount;
  for (var i = 0u; i < plCount; i++) {
    let pl0 = lighting.pointLights[i * 2u];
    let pl1 = lighting.pointLights[i * 2u + 1u];
    let plPos = pl0.xyz;
    let plRadius = pl0.w;
    let plColor = pl1.xyz;
    let plIntensity = pl1.w;
    let L = plPos - in.worldPos;
    let dist = length(L);
    if (dist < plRadius) {
      let atten = 1.0 / (1.0 + dist * dist / (plRadius * plRadius));
      let ndotl = max(dot(N, normalize(L)), 0.0);
      litColor += color * plColor * plIntensity * atten * ndotl;
    }
  }
  // Distance fog — match sky ambient color
  let dist = length(in.worldPos - u.cameraPos);
  let fog = clamp(1.0 - dist / 400.0, 0.0, 1.0);
  let fogColor = lighting.skyAmbient;
  let outColor = mix(fogColor, litColor, fog);

  // Ghost hologram override (ghostMode == 1): cyan fresnel rim + vertical
  // scanline pulse. Hover outline is handled by a separate inverted-hull
  // pipeline (SHAPE_OUTLINE_SHADER) — see renderHoverOutline below.
  if (in.ghostMode > 0.5) {
    let viewDir = normalize(u.cameraPos - in.worldPos);
    let fresnel = pow(1.0 - max(dot(N, viewDir), 0.0), 2.5);
    let pulse = 0.65 + 0.35 * sin(u.time * 5.0 + in.worldPos.y * 3.0);
    let scan = 0.5 + 0.5 * sin((in.worldPos.y + u.time * 2.0) * 20.0);
    let ghostBase = vec3f(0.15, 0.75, 0.95);
    let ghostRim = vec3f(0.7, 1.0, 1.0);
    var ghostCol = mix(ghostBase, ghostRim, fresnel) * pulse;
    ghostCol = ghostCol + ghostRim * scan * 0.15 * fresnel;
    return vec4f(ghostCol, 1.0);
  }

  return vec4f(outColor, 1.0);
}
`;

// ── Post-process outline: mask shader + composite shader ──────────────────
// The mask shader renders the hovered entity as solid white to a mask
// texture.  The composite shader reads the mask + scene color, detects edges
// in screen space, and draws the outline color.  Works on ALL models
// regardless of winding order or geometry complexity.

const MASK_SHADER = /* wgsl */ `
struct MaskUniforms {
  viewProj: mat4x4f,
  model: mat4x4f,
};
@group(0) @binding(0) var<uniform> u: MaskUniforms;

@vertex
fn vs_mask(@location(0) pos: vec3f) -> @builtin(position) vec4f {
  return u.viewProj * u.model * vec4f(pos, 1.0);
}

@fragment
fn fs_mask() -> @location(0) vec4f {
  return vec4f(1.0, 1.0, 1.0, 1.0);
}
`;

const OUTLINE_COMPOSITE_SHADER = /* wgsl */ `
struct CompositeUniforms {
  texelSize: vec2f,
  outlineWidth: f32,
  _pad: f32,
  outlineColor: vec3f,
  _pad2: f32,
};
@group(0) @binding(0) var sceneTex: texture_2d<f32>;
@group(0) @binding(1) var maskTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: CompositeUniforms;

@vertex
fn vs_composite(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  // Fullscreen triangle that covers the entire screen.
  // Vertices: (-1,-1), (3,-1), (-1,3) — the hypotenuse from (3,-1) to
  // (-1,3) passes above the top-right corner (1,1), so the whole
  // screen is covered.
  let x = f32(vi & 1u) * 4.0 - 1.0;
  let y = f32(vi >> 1u) * 4.0 - 1.0;
  return vec4f(x, y, 0.0, 1.0);
}

@fragment
fn fs_composite(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let dims = textureDimensions(maskTex);
  let coords = vec2u(u32(fragCoord.x), u32(fragCoord.y));
  let center = textureLoad(maskTex, coords, 0).r;
  let sceneColor = textureLoad(sceneTex, coords, 0).rgb;

  // If this pixel IS part of the hovered entity, keep the scene color.
  if (center > 0.5) {
    return vec4f(sceneColor, 1.0);
  }

  // Edge detection: check 8 neighbors at outlineWidth texels distance.
  // If any neighbor is part of the entity, this pixel is an outline pixel.
  let w = max(1u, u32(u.outlineWidth));
  var hit = 0.0;
  for (var dy = -1; dy <= 1; dy = dy + 1) {
    for (var dx = -1; dx <= 1; dx = dx + 1) {
      if (dx == 0 && dy == 0) { continue; }
      let sc = clamp(vec2i(coords) + vec2i(dx, dy) * i32(w),
                     vec2i(0, 0),
                     vec2i(i32(dims.x) - 1, i32(dims.y) - 1));
      let s = textureLoad(maskTex, vec2u(sc), 0).r;
      hit = max(hit, s);
    }
  }
  if (hit > 0.5) {
    return vec4f(u.outlineColor, 1.0);
  }
  return vec4f(sceneColor, 1.0);
}
`;

// Cube vertices: position(3) + uv(2) + normal(3) per vertex, 24 vertices (4 per face)
// UV atlas: 4×4 grid on a 512×512 paint texture. Each face gets a 128×128
// cell so paint strokes only appear on the face they're applied to.
//   Col 0    Col 1    Col 2    Col 3
//   +X       -X       +Y       (empty)   ← Row 0
//   -Y       +Z       -Z       (empty)   ← Row 1
const AW = 0.25; // atlas cell width  (1/4)
const AH = 0.25; // atlas cell height (1/4)
// Half-texel inset to prevent linear filtering from bleeding across atlas
// cell boundaries. Paint texture is 512×512, so half a texel = 0.5/512.
const HT = 0.5 / 512;
const CUBE_VERTICES = new Float32Array([
  // +X face (normal: 1,0,0) — atlas cell (0,0): offset (0, 0)
   0.5, -0.5, -0.5,  0.0 + HT,  0.0 + HT,  1.0, 0.0, 0.0,
   0.5,  0.5, -0.5,  0.0 + HT,  AH - HT,   1.0, 0.0, 0.0,
   0.5,  0.5,  0.5,  AW - HT,   AH - HT,   1.0, 0.0, 0.0,
   0.5, -0.5,  0.5,  AW - HT,   0.0 + HT,  1.0, 0.0, 0.0,
  // -X face (normal: -1,0,0) — atlas cell (1,0): offset (AW, 0)
  -0.5, -0.5,  0.5,  AW + HT,      0.0 + HT,  -1.0, 0.0, 0.0,
  -0.5,  0.5,  0.5,  AW + HT,      AH - HT,   -1.0, 0.0, 0.0,
  -0.5,  0.5, -0.5,  AW * 2 - HT,  AH - HT,   -1.0, 0.0, 0.0,
  -0.5, -0.5, -0.5,  AW * 2 - HT,  0.0 + HT,  -1.0, 0.0, 0.0,
  // +Y face (normal: 0,1,0) — atlas cell (2,0): offset (AW*2, 0)
  -0.5,  0.5, -0.5,  AW * 2 + HT,  0.0 + HT,  0.0, 1.0, 0.0,
  -0.5,  0.5,  0.5,  AW * 2 + HT,  AH - HT,   0.0, 1.0, 0.0,
   0.5,  0.5,  0.5,  AW * 3 - HT,  AH - HT,   0.0, 1.0, 0.0,
   0.5,  0.5, -0.5,  AW * 3 - HT,  0.0 + HT,  0.0, 1.0, 0.0,
  // -Y face (normal: 0,-1,0) — atlas cell (0,1): offset (0, AH)
  -0.5, -0.5,  0.5,  0.0 + HT,  AH + HT,        0.0, -1.0, 0.0,
  -0.5, -0.5, -0.5,  0.0 + HT,  AH * 2 - HT,    0.0, -1.0, 0.0,
   0.5, -0.5, -0.5,  AW - HT,   AH * 2 - HT,    0.0, -1.0, 0.0,
   0.5, -0.5,  0.5,  AW - HT,   AH + HT,        0.0, -1.0, 0.0,
  // +Z face (normal: 0,0,1) — atlas cell (1,1): offset (AW, AH)
  -0.5, -0.5,  0.5,  AW + HT,      AH + HT,        0.0, 0.0, 1.0,
   0.5, -0.5,  0.5,  AW + HT,      AH * 2 - HT,    0.0, 0.0, 1.0,
   0.5,  0.5,  0.5,  AW * 2 - HT,  AH * 2 - HT,    0.0, 0.0, 1.0,
  -0.5,  0.5,  0.5,  AW * 2 - HT,  AH + HT,        0.0, 0.0, 1.0,
  // -Z face (normal: 0,0,-1) — atlas cell (2,1): offset (AW*2, AH)
   0.5, -0.5, -0.5,  AW * 2 + HT,  AH + HT,        0.0, 0.0, -1.0,
  -0.5, -0.5, -0.5,  AW * 2 + HT,  AH * 2 - HT,    0.0, 0.0, -1.0,
  -0.5,  0.5, -0.5,  AW * 3 - HT,  AH * 2 - HT,    0.0, 0.0, -1.0,
   0.5,  0.5, -0.5,  AW * 3 - HT,  AH + HT,        0.0, 0.0, -1.0,
]);

const CUBE_INDICES = new Uint16Array([
  0, 1, 2,  0, 2, 3,    // +X
  4, 5, 6,  4, 6, 7,    // -X
  8, 9, 10, 8, 10, 11,  // +Y
  12, 13, 14, 12, 14, 15, // -Y
  16, 17, 18, 16, 18, 19, // +Z
  20, 21, 22, 20, 22, 23, // -Z
]);

// Generate sphere vertices: position(3) + uv(2) + normal(3) = 8 floats per vertex
function generateSphere(radius: number, segments: number, rings: number): { vertices: Float32Array; indices: Uint16Array } {
  const verts: number[] = [];
  const idx: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const theta = (r / rings) * Math.PI; // 0..PI
    const sinT = Math.sin(theta), cosT = Math.cos(theta);
    for (let s = 0; s <= segments; s++) {
      const phi = (s / segments) * 2 * Math.PI; // 0..2PI
      const sinP = Math.sin(phi), cosP = Math.cos(phi);
      const x = radius * sinT * cosP;
      const y = radius * cosT;
      const z = radius * sinT * sinP;
      const u = s / segments;
      const v = r / rings;
      // Normal = normalized position
      const nx = sinT * cosP, ny = cosT, nz = sinT * sinP;
      verts.push(x, y, z, u, v, nx, ny, nz);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s;
      const b = a + segments + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return { vertices: new Float32Array(verts), indices: new Uint16Array(idx) };
}

const SPHERE_GEO = generateSphere(0.5, 24, 16);
const SPHERE_VERTICES = SPHERE_GEO.vertices;
const SPHERE_INDICES = SPHERE_GEO.indices;

// ── Hitbox / collider wireframe geometry (line-list, unit-sized) ──
// Used by the F1 "show hitboxes" debug overlay. Box is -0.5..0.5 (halfExtent
// 0.5); sphere is radius 0.5; both are scaled by the prop's model matrix so
// they match the physics collider (box halfExtent = 0.5*scale, sphere radius
// = 0.5*scale — matches getPropColliders()). Capsule is generated per-dimensions
// for the player (see generateCapsuleWireframe).
const WIRE_BOX_VERTICES = new Float32Array([
  // 12 edges of a unit cube (line-list, 24 vertices)
  -0.5, -0.5, -0.5,  0.5, -0.5, -0.5,
   0.5, -0.5, -0.5,  0.5,  0.5, -0.5,
   0.5,  0.5, -0.5, -0.5,  0.5, -0.5,
  -0.5,  0.5, -0.5, -0.5, -0.5, -0.5,
  -0.5, -0.5,  0.5,  0.5, -0.5,  0.5,
   0.5, -0.5,  0.5,  0.5,  0.5,  0.5,
   0.5,  0.5,  0.5, -0.5,  0.5,  0.5,
  -0.5,  0.5,  0.5, -0.5, -0.5,  0.5,
  -0.5, -0.5, -0.5, -0.5, -0.5,  0.5,
   0.5, -0.5, -0.5,  0.5, -0.5,  0.5,
   0.5,  0.5, -0.5,  0.5,  0.5,  0.5,
  -0.5,  0.5, -0.5, -0.5,  0.5,  0.5,
]);
const WIRE_BOX_VERTEX_COUNT = WIRE_BOX_VERTICES.length / 3;

/** Wireframe sphere (line-list): latitude rings + longitude great circles. */
function generateWireSphere(radius: number, latRings: number, lonLines: number, segs: number): Float32Array<ArrayBuffer> {
  const verts: number[] = [];
  // Latitude rings (horizontal circles, skip the poles)
  for (let r = 1; r < latRings; r++) {
    const theta = (r / latRings) * Math.PI;
    const y = radius * Math.cos(theta);
    const rr = radius * Math.sin(theta);
    for (let s = 0; s < segs; s++) {
      const a0 = (s / segs) * 2 * Math.PI;
      const a1 = ((s + 1) / segs) * 2 * Math.PI;
      verts.push(rr * Math.cos(a0), y, rr * Math.sin(a0));
      verts.push(rr * Math.cos(a1), y, rr * Math.sin(a1));
    }
  }
  // Longitude great circles (through the poles)
  for (let m = 0; m < lonLines; m++) {
    const phi = (m / lonLines) * Math.PI;
    for (let s = 0; s < segs; s++) {
      const t0 = (s / segs) * Math.PI;
      const t1 = ((s + 1) / segs) * Math.PI;
      verts.push(radius * Math.sin(t0) * Math.cos(phi), radius * Math.cos(t0), radius * Math.sin(t0) * Math.sin(phi));
      verts.push(radius * Math.sin(t1) * Math.cos(phi), radius * Math.cos(t1), radius * Math.sin(t1) * Math.sin(phi));
    }
  }
  return new Float32Array(verts);
}
const WIRE_SPHERE_VERTICES = generateWireSphere(0.5, 7, 12, 24);
const WIRE_SPHERE_VERTEX_COUNT = WIRE_SPHERE_VERTICES.length / 3;

/**
 * Wireframe capsule (line-list), centered at the origin with the cylinder
 * centered at y=0. The two hemispheres cap the top (y = +cylHalfHeight) and
 * bottom (y = -cylHalfHeight). Total height = 2*cylHalfHeight + 2*radius.
 * Regenerated per player-pose dimensions (see setPlayerHitbox).
 */
function generateCapsuleWireframe(radius: number, cylHalfHeight: number, segments = 16, meridians = 8): Float32Array<ArrayBuffer> {
  const verts: number[] = [];
  const topY = cylHalfHeight;
  const botY = -cylHalfHeight;
  // Top + bottom latitude circles of the cylinder.
  for (const y of [topY, botY]) {
    for (let s = 0; s < segments; s++) {
      const a0 = (s / segments) * 2 * Math.PI;
      const a1 = ((s + 1) / segments) * 2 * Math.PI;
      verts.push(radius * Math.cos(a0), y, radius * Math.sin(a0));
      verts.push(radius * Math.cos(a1), y, radius * Math.sin(a1));
    }
  }
  // Vertical lines connecting the two circles.
  for (let m = 0; m < meridians; m++) {
    const a = (m / meridians) * 2 * Math.PI;
    const x = radius * Math.cos(a), z = radius * Math.sin(a);
    verts.push(x, botY, z);
    verts.push(x, topY, z);
  }
  // Hemisphere meridians (top + bottom).
  const hemiSegs = 6;
  for (let m = 0; m < meridians; m++) {
    const a = (m / meridians) * 2 * Math.PI;
    const cx = Math.cos(a), cz = Math.sin(a);
    for (let i = 0; i < hemiSegs; i++) {
      const ang0 = (i / hemiSegs) * (Math.PI / 2);
      const ang1 = ((i + 1) / hemiSegs) * (Math.PI / 2);
      // Top hemisphere
      verts.push(radius * Math.cos(ang0) * cx, topY + radius * Math.sin(ang0), radius * Math.cos(ang0) * cz);
      verts.push(radius * Math.cos(ang1) * cx, topY + radius * Math.sin(ang1), radius * Math.cos(ang1) * cz);
      // Bottom hemisphere
      verts.push(radius * Math.cos(ang0) * cx, botY - radius * Math.sin(ang0), radius * Math.cos(ang0) * cz);
      verts.push(radius * Math.cos(ang1) * cx, botY - radius * Math.sin(ang1), radius * Math.cos(ang1) * cz);
    }
  }
  return new Float32Array(verts);
}

const GROUND_SIZE = 512; // 512×512m ground plane

export class WebGPURenderer extends GameRenderer {
  private simReader: SimBufferReader | null = null;
  private inputWriter: InputBufferWriter | null = null;
  private modelRenderer: ModelRenderer | null = null;
  private bindlessRegistry: BindlessTextureRegistry | null = null;
  private bindlessMaterialManager: BindlessMaterialManager | null = null;
  private bindlessFrameBindings: BindlessFrameBindings | null = null;

  // Post-process stack (HDR scene target + bloom/tonemap/FXAA/vignette chain)
  private postProcessStack: PostProcessStack | null = null;

  // Mipmap generation helper for standalone (non-bindless) textures
  private mipmapHelper: MipmapHelper | null = null;

  // Frame-global lighting (sun color + hemisphere ambient + point lights)
  private lighting: SandboxLighting | null = null;
  // Per-pipeline lighting bind groups (auto-layout pipelines need per-pipeline BGs)
  private groundLightingBg: GPUBindGroup | null = null;
  private cubeLightingBg: GPUBindGroup | null = null;
  private sphereLightingBg: GPUBindGroup | null = null;
  // ModelRenderer frame-lighting bind group (group 2 of the model pipeline)
  private modelLightingBg: GPUBindGroup | null = null;

  // Shadow mapping
  private shadows: SandboxShadows | null = null;
  private shadowsEnabled = true;
  // Per-pipeline shadow bind groups (group 3 for procedural pipelines)
  private groundShadowBg: GPUBindGroup | null = null;
  private cubeShadowBg: GPUBindGroup | null = null;
  private sphereShadowBg: GPUBindGroup | null = null;
  // Depth-only pipelines for the shadow pass
  private depthOnlyShader: GPUShaderModule | null = null;
  private depthOnlyGroundPipeline: GPURenderPipeline | null = null;
  private depthOnlyCubePipeline: GPURenderPipeline | null = null;
  private depthOnlySpherePipeline: GPURenderPipeline | null = null;
  private depthOnlyCubeUniformBuffer: GPUBuffer | null = null;

  // FrameGraph handles for the imported scene color/depth views
  private graphColorHandle: TextureHandle | null = null;
  private graphDepthHandle: TextureHandle | null = null;
  private graphCompiled = false;

  // Skybox pipeline
  private skyPipeline: GPURenderPipeline | null = null;
  private skyUniformBuffer: GPUBuffer | null = null;
  private skyBindGroup: GPUBindGroup | null = null;
  // Ground plane pipeline + buffers
  private groundPipeline: GPURenderPipeline | null = null;
  private groundVertexBuffer: GPUBuffer | null = null;
  private groundUniformBuffer: GPUBuffer | null = null;
  private groundBindGroup: GPUBindGroup | null = null;
  private groundPaintTexture: GPUTexture | null = null;
  private groundPaintSampler: GPUSampler | null = null;
  private groundPaintBindGroup: GPUBindGroup | null = null;
  // Digit atlas for distance markers (10 digits, 64x96 each, in a 640x96 strip)
  private digitTexture: GPUTexture | null = null;

  // Procedural cube pipeline (for builtin props without model files)
  private cubePipeline: GPURenderPipeline | null = null;
  private cubeVertexBuffer: GPUBuffer | null = null;
  private cubeIndexBuffer: GPUBuffer | null = null;
  private cubeIndexCount = CUBE_INDICES.length;
  private cubeUniformBuffer: GPUBuffer | null = null;
  private cubeInstanceBuffer: GPUBuffer | null = null;
  // 96 bytes per instance (mat4x4 + vec4 + 4 u32). Storage buffer — no 256-byte
  // dynamic-offset alignment needed, so we pack instances tightly.
  private cubeInstanceStride = 96;
  // Reusable staging buffer for instance data (24 floats × 96 bytes per instance).
  // Pre-allocated to maxEntities to avoid per-frame GC.
  private instanceStaging = new Float32Array(4096 * 24);
  // Temporary buffer for repacking painted/unpainted entities in renderShapeBatch.
  // copyWithin on instanceStaging can overwrite data for entities that haven't
  // been processed yet (e.g. a painted entity moved to the end overwrites a
  // later unpainted entity's slot, causing it to inherit hasPaint=1 and render
  // white via the default 1×1 opaque texture). We snapshot the batch into this
  // temp buffer first, then repack from it back into instanceStaging.
  private repackTemp = new Float32Array(4096 * 24);
  // Reusable staging for the shadow-pass light VP matrix (16 floats = 64 bytes).
  private lightVPStaging = new Float32Array(16);
  private cubeBindGroup0Layout: GPUBindGroupLayout | null = null;
  private cubeSampler: GPUSampler | null = null;
  private cubeDefaultTexture: GPUTexture | null = null;
  // Cached bind groups for the default (no-paint) texture to avoid per-frame allocation
  private cubeDefaultBindGroup1: GPUBindGroup | null = null;
  private sphereDefaultBindGroup1: GPUBindGroup | null = null;
  // Single shared bind group 0 per pipeline (binds uniform + instance storage buffer).
  // Replaces the former per-instance bg0Cache — one bind group for all instances.
  private cubeBindGroup0: GPUBindGroup | null = null;
  private sphereBindGroup0: GPUBindGroup | null = null;
  // Depth-only bind group 0 per pipeline (binds lightVP uniform + instance storage).
  private depthCubeBindGroup0: GPUBindGroup | null = null;
  private depthSphereBindGroup0: GPUBindGroup | null = null;
  // Per-entity bind group 1 cache (paint textures) keyed by entityId
  private paintBindGroupCache = new Map<number, GPUBindGroup>();
  // Ground depth-only bind group (cached once — no per-instance variation)
  private groundDepthBindGroup: GPUBindGroup | null = null;
  private spherePipeline: GPURenderPipeline | null = null;
  private sphereVertexBuffer: GPUBuffer | null = null;
  private sphereIndexBuffer: GPUBuffer | null = null;
  private sphereIndexCount = 0;

  // ── Post-process outline (mask + composite) ──
  private maskTexture: GPUTexture | null = null;
  private maskTextureView: GPUTextureView | null = null;
  private maskPipeline: GPURenderPipeline | null = null;
  private maskUniformBuffer: GPUBuffer | null = null;
  private maskBindGroup: GPUBindGroup | null = null;
  private maskStaging = new Float32Array(32); // viewProj(16) + model(16)
  private compositePipeline: GPURenderPipeline | null = null;
  private compositeUniformBuffer: GPUBuffer | null = null;
  private compositeBindGroup: GPUBindGroup | null = null;
  private compositeSampler: GPUSampler | null = null;
  private compositeTempTexture: GPUTexture | null = null;
  private compositeTempView: GPUTextureView | null = null;

  // Render loop
  private rafHandle = 0;
  private sandboxRunning = false;
  private sandboxLastTime = 0;
  private _elapsedTime = 0;
  private _deviceLost = false;

  // Camera state
  private camPos: [number, number, number] = [0, 5, 10];
  private camTarget: [number, number, number] = [0, 0, 0];
  private camUp: [number, number, number] = [0, 1, 0];
  private camFov = 60;
  private camNear = 0.1;
  private camFar = 2000;

  // Model loading: contentId → ModelData (cached)
  private modelCache = new Map<string, ModelData>();
  // Collider hull cache: contentId → downsampled point cloud (mesh-local space).
  // Computed once per unique model, reused for every spawn of that contentId.
  private hullCache = new Map<string, Float32Array | null>();
  // nodeId → contentId mapping
  private nodeToContent = new Map<string, string>();
  private nextNodeId = 1;

  // Depth texture (used when postfx is disabled — fallback direct-to-canvas path)
  private depthTexture: GPUTexture | null = null;
  private depthTextureW = 0;
  private depthTextureH = 0;

  // ── Graphics settings (runtime-toggleable, see Phase 6) ──
  private fxaaEnabled = true;
  private bloomEnabled = true;
  private tonemapEnabled = true;
  private vignetteEnabled = true;
  private mipmapsEnabled = true;

  // ── Entity transform interpolation ──
  // Double-buffered prev/curr transform snapshots from the sim, interpolated
  // each render frame using alpha = elapsedSinceTick / SIM_TICK_DT.
  // This smooths motion at render rates > sim rate (e.g. 144Hz render, 60Hz
  // sim) without extrapolation — rendered positions are always between two
  // known-good physics states, so objects never clip through walls.
  private static readonly INTERP_MAX_ENTITIES = 4096;
  private interpBuffer: InterpolationBuffer | null = null;
  // Output buffer for readInterpolated — 8 floats per entity (pos.xyz + rot.xyzw + scale).
  private interpOut: Float32Array | null = null;
  private interpLastTick = -1;
  private interpLastTickTime = 0;
  // Reusable scratch buffer for writeTick's readFn (avoids per-tick allocation).
  private interpScratch: Float32Array | null = null;

  // ── Precomputed render entity collection ──
  // Built once per frame in collectRenderEntities(), reused by both the
  // shadow depth pass and the scene color pass. This eliminates duplicate
  // entity iteration, getEntitySlot object allocation, and composeModelMatrixInto
  // calls (previously computed independently in both passes).
  // Cubes/spheres entity indices, packed contiguously.
  private renderCubes: number[] = [];
  private renderSpheres: number[] = [];
  // Per-entity paint flag (indexed by entity slot index, 1 = has paint texture).
  private renderPaintFlags: Uint8Array = new Uint8Array(WebGPURenderer.INTERP_MAX_ENTITIES);
  // Precomputed hue-based colors (3 floats per entity × max entities).
  // Formula: hue = (i * 0.15) % 1.0, RGB from sin offsets — deterministic, computed once.
  private renderColors: Float32Array = new Float32Array(WebGPURenderer.INTERP_MAX_ENTITIES * 3);

  setSimReader(sab: SharedArrayBuffer): void {
    this.simReader = new SimBufferReader(sab);
    // Create the interpolation buffer and pre-assign all slots so reseed()
    // can find any entity index without runtime assignSlot calls.
    this.interpBuffer = new InterpolationBuffer(WebGPURenderer.INTERP_MAX_ENTITIES);
    this.interpOut = new Float32Array(WebGPURenderer.INTERP_MAX_ENTITIES * 8);
    this.interpScratch = new Float32Array(WebGPURenderer.INTERP_MAX_ENTITIES * 8);
    for (let i = 0; i < WebGPURenderer.INTERP_MAX_ENTITIES; i++) {
      this.interpBuffer.assignSlot(i);
      // Precompute hue-based colors — deterministic per entity index, no
      // need to recompute Math.sin every frame.
      const hue = (i * 0.15) % 1.0;
      const off = i * 3;
      this.renderColors[off]     = 0.5 + 0.4 * Math.sin(hue * Math.PI * 2);
      this.renderColors[off + 1] = 0.5 + 0.4 * Math.sin(hue * Math.PI * 2 + 2.094);
      this.renderColors[off + 2] = 0.5 + 0.4 * Math.sin(hue * Math.PI * 2 + 4.189);
    }
  }

  setInputWriter(sab: SharedArrayBuffer): void {
    this.inputWriter = new InputBufferWriter(sab);
  }

  // ── Entity lifecycle hooks for interpolation ──
  // Called from main.tsx event handlers to reseed the interpolation buffer
  // when a prop spawns (avoids interpolating from stale/garbage prev state)
  // or is removed (releases the slot for potential recycling).
  onPropSpawned(entityId: number): void {
    if (!this.interpBuffer || !this.simReader) return;
    const slotIdx = entityId - 1; // entityId = slotIdx + 1
    if (slotIdx < 0 || slotIdx >= WebGPURenderer.INTERP_MAX_ENTITIES) return;
    const slot = this.simReader.getEntitySlot(slotIdx);
    this.interpBuffer.reseed(
      slotIdx,
      [slot.f32[ENT.POS_X], slot.f32[ENT.POS_Y], slot.f32[ENT.POS_Z]],
      [slot.f32[ENT.ROT_X], slot.f32[ENT.ROT_Y], slot.f32[ENT.ROT_Z], slot.f32[ENT.ROT_W]],
      slot.f32[ENT.SCALE] || 1.0,
    );
  }

  onPropRemoved(entityId: number): void {
    if (!this.interpBuffer) return;
    const slotIdx = entityId - 1;
    if (slotIdx < 0 || slotIdx >= WebGPURenderer.INTERP_MAX_ENTITIES) return;
    this.interpBuffer.releaseSlot(slotIdx);
    // Re-assign so a future spawn at the same slot index can reseed.
    this.interpBuffer.assignSlot(slotIdx);
  }

  getModelRenderer(): ModelRenderer | null { return this.modelRenderer; }
  getBindlessRegistry(): BindlessTextureRegistry | null { return this.bindlessRegistry; }
  getBindlessMaterialManager(): BindlessMaterialManager | null { return this.bindlessMaterialManager; }
  getBindlessFrameBindings(): BindlessFrameBindings | null { return this.bindlessFrameBindings; }

  async init(): Promise<boolean> {
    const ok = await super.init();
    if (!ok) return false;

    try {
      const device = this.getDevice()!;
      const format = this.getFormat();

      device.lost.then(() => { this._deviceLost = true; });

      // Bindless material binding model
      this.bindlessRegistry = new BindlessTextureRegistry(device);
      this.bindlessMaterialManager = new BindlessMaterialManager(device);
      this.bindlessFrameBindings = new BindlessFrameBindings(
        device, this.bindlessRegistry, this.bindlessMaterialManager,
      );

      // Model renderer for props — use HDR format since scene renders into rgba16float
      const hdrFormat: GPUTextureFormat = "rgba16float";
      this.modelRenderer = new ModelRenderer(device, hdrFormat);
      this.modelRenderer.setBindlessDeps({
        registry: this.bindlessRegistry,
        materialManager: this.bindlessMaterialManager,
        bindGroupLayout: this.bindlessFrameBindings.getBindGroupLayout(),
      });
      await this.modelRenderer.init();

      // Post-process stack: HDR scene target + effect chain
      this.postProcessStack = new PostProcessStack(device, format, { depthFormat: DEPTH_FORMAT });
      this.postProcessStack.init();
      this.applyDefaultPostfxSettings();

      // Mipmap helper for standalone paint textures
      this.mipmapHelper = new MipmapHelper(device);

      // Shadow mapping (single-cascade sun shadow)
      this.shadows = new SandboxShadows(device);

      // Frame-global lighting
      this.lighting = new SandboxLighting(device);

      // Create a frame-lighting bind group for the ModelRenderer (group 2).
      // The model pipeline's group(2) layout is the frameLightingLayout.
      const modelLightLayout = this.modelRenderer!.getFrameLightingLayout();
      if (modelLightLayout) {
        this.modelLightingBg = device.createBindGroup({
          label: "model-lighting-bg",
          layout: modelLightLayout,
          entries: [{ binding: 0, resource: { buffer: this.lighting.getUniformBuffer() } }],
        });
      }

      // Procedural pipelines render into the HDR scene target (rgba16float),
      // not the swapchain — the PostProcessStack handles the final blit.
      this.createSkyPipeline(device, hdrFormat);
      this.createGroundPipeline(device, hdrFormat);
      this.createCubePipeline(device, hdrFormat);
      this.createSpherePipeline(device, hdrFormat);
      this.createHitboxPipeline(device, hdrFormat);
      this.createDepthOnlyPipelines(device);

      // Create per-pipeline shadow bind groups (group 3 for procedural pipelines).
      // The shadow bind group layout is owned by the ShadowMapSystem.
      const shadowSys = this.shadows!.getShadowSystem();
      const shadowBuf = shadowSys.getShadowUniformBuffer();
      const shadowView = shadowSys.getShadowDepthView();
      const shadowSamp = shadowSys.getShadowSampler();
      if (shadowBuf && shadowView && shadowSamp) {
        const shadowEntries: GPUBindGroupEntry[] = [
          { binding: 0, resource: { buffer: shadowBuf } },
          { binding: 1, resource: shadowView },
          { binding: 2, resource: shadowSamp },
        ];
        this.groundShadowBg = device.createBindGroup({
          label: "ground-shadow-bg",
          layout: this.groundPipeline!.getBindGroupLayout(3),
          entries: shadowEntries,
        });
        this.cubeShadowBg = device.createBindGroup({
          label: "cube-shadow-bg",
          layout: this.cubePipeline!.getBindGroupLayout(3),
          entries: shadowEntries,
        });
        this.sphereShadowBg = device.createBindGroup({
          label: "sphere-shadow-bg",
          layout: this.spherePipeline!.getBindGroupLayout(3),
          entries: shadowEntries,
        });
      }

      // Create per-pipeline lighting bind groups (auto-layout pipelines need
      // bind groups created from each pipeline's own group(2) layout).
      const lightBuf = this.lighting!.getUniformBuffer();
      this.groundLightingBg = device.createBindGroup({
        label: "ground-lighting-bg",
        layout: this.groundPipeline!.getBindGroupLayout(2),
        entries: [{ binding: 0, resource: { buffer: lightBuf } }],
      });
      this.cubeLightingBg = device.createBindGroup({
        label: "cube-lighting-bg",
        layout: this.cubePipeline!.getBindGroupLayout(2),
        entries: [{ binding: 0, resource: { buffer: lightBuf } }],
      });
      this.sphereLightingBg = device.createBindGroup({
        label: "sphere-lighting-bg",
        layout: this.spherePipeline!.getBindGroupLayout(2),
        entries: [{ binding: 0, resource: { buffer: lightBuf } }],
      });

      this.setViewportCount(1);
      this.sandboxRunning = true;
      this.sandboxLastTime = performance.now();
      this.rafHandle = requestAnimationFrame(this.frameLoop);
      return true;
    } catch (err) {
      console.error("[WebGPURenderer] Init failed:", err);
      return false;
    }
  }

  /** Apply the default enabled effects + parameter defaults. */
  private applyDefaultPostfxSettings(): void {
    const s = this.postProcessStack!;
    s.setEnabled("fxaa", this.fxaaEnabled);
    s.setEnabled("bloom", this.bloomEnabled);
    s.setEnabled("tonemap", this.tonemapEnabled);
    s.setEnabled("vignette", this.vignetteEnabled);
    // Sensible defaults for the sandbox
    s.setBloomThreshold(0.85);
    s.setBloomStrength(0.6);
    s.setBloomMipCount(5);
    s.setExposure(1.1);
    s.setVignette(0.25);
  }

  private createSkyPipeline(device: GPUDevice, format: GPUTextureFormat): void {
    // Uniform: invViewProj (64) + cameraPos (12) + pad (4) = 80 bytes
    this.skyUniformBuffer = device.createBuffer({
      label: "sky-uniforms",
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const shader = device.createShaderModule({ label: "sky", code: SKY_SHADER });
    this.skyPipeline = device.createRenderPipeline({
      label: "sky",
      layout: "auto",
      vertex: { module: shader, entryPoint: "vs" },
      fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        format: DEPTH_FORMAT as GPUTextureFormat,
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
    });

    this.skyBindGroup = device.createBindGroup({
      label: "sky-bindgroup",
      layout: this.skyPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.skyUniformBuffer } }],
    });
  }

  private createGroundPipeline(device: GPUDevice, format: GPUTextureFormat): void {
    const h = GROUND_SIZE / 2;
    const vertices = new Float32Array([
      -h, 0, -h,  h, 0, -h,  h, 0,  h,
      -h, 0, -h,  h, 0,  h,  -h, 0,  h,
    ]);
    this.groundVertexBuffer = device.createBuffer({
      label: "ground-vertices",
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.groundVertexBuffer, 0, vertices);

    this.groundUniformBuffer = device.createBuffer({
      label: "ground-uniforms",
      size: 80, // mat4x4 (64) + vec3 (12) + padding (4)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const shader = device.createShaderModule({ label: "ground", code: GROUND_SHADER });
    this.groundPipeline = device.createRenderPipeline({
      label: "ground",
      layout: "auto",
      vertex: {
        module: shader, entryPoint: "vs",
        buffers: [{
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
        }],
      },
      fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        format: DEPTH_FORMAT as GPUTextureFormat,
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

    this.groundBindGroup = device.createBindGroup({
      label: "ground-bindgroup",
      layout: this.groundPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.groundUniformBuffer } }],
    });

    // Ground paint texture (512×512, updated by paint system) — with mip chain
    const groundMipCount = MipmapHelper.mipLevelCount(512, 512);
    this.groundPaintTexture = device.createTexture({
      label: "ground-paint",
      size: [512, 512],
      format: "rgba8unorm",
      mipLevelCount: groundMipCount,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    // Clear to transparent
    const clearData = new Uint8Array(512 * 512 * 4); // all zeros = transparent
    device.queue.writeTexture(
      { texture: this.groundPaintTexture },
      clearData,
      { bytesPerRow: 512 * 4 },
      { width: 512, height: 512 },
    );
    this.groundPaintSampler = device.createSampler({
      label: "ground-paint-sampler",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
    });

    // ── Digit atlas for distance markers ──
    // 10 digits (0-9) in a 2560x384 strip (256x384 per digit, 2:3 aspect).
    // High resolution for crisp text when viewed at shallow angles.
    const DIGIT_W = 256;
    const DIGIT_H = 384;
    const digitCanvas = document.createElement("canvas");
    digitCanvas.width = DIGIT_W * 10;
    digitCanvas.height = DIGIT_H;
    const dctx = digitCanvas.getContext("2d")!;
    dctx.clearRect(0, 0, DIGIT_W * 10, DIGIT_H);
    dctx.fillStyle = "white";
    dctx.font = `bold ${Math.floor(DIGIT_H * 0.8)}px monospace`;
    dctx.textAlign = "center";
    dctx.textBaseline = "middle";
    for (let i = 0; i < 10; i++) {
      dctx.fillText(String(i), i * DIGIT_W + DIGIT_W / 2, DIGIT_H / 2);
    }
    const digitImageData = dctx.getImageData(0, 0, DIGIT_W * 10, DIGIT_H);
    this.digitTexture = device.createTexture({
      label: "digit-atlas",
      size: [DIGIT_W * 10, DIGIT_H],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.digitTexture },
      digitImageData.data,
      { bytesPerRow: DIGIT_W * 10 * 4 },
      { width: DIGIT_W * 10, height: DIGIT_H },
    );

    this.groundPaintBindGroup = device.createBindGroup({
      label: "ground-paint-bindgroup",
      layout: this.groundPipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: this.groundPaintTexture.createView() },
        { binding: 1, resource: this.groundPaintSampler },
        { binding: 2, resource: this.digitTexture.createView() },
      ],
    });
  }

  private createCubePipeline(device: GPUDevice, format: GPUTextureFormat): void {
    // Vertex buffer: position(3) + uv(2) = 20 bytes per vertex
    this.cubeVertexBuffer = device.createBuffer({
      label: "cube-vertices",
      size: CUBE_VERTICES.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.cubeVertexBuffer, 0, CUBE_VERTICES);

    // Index buffer
    this.cubeIndexBuffer = device.createBuffer({
      label: "cube-indices",
      size: CUBE_INDICES.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.cubeIndexBuffer, 0, CUBE_INDICES);

    // Uniform buffer: viewProj(64) + cameraPos(12) + pad(4) = 80 bytes
    this.cubeUniformBuffer = device.createBuffer({
      label: "cube-uniforms",
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Instance buffer: model(64) + color(16) + hasPaint(4) + pad(12) = 96 bytes per entity.
    // Bound as a storage buffer (array<Instance>) so all instances share one bind group
    // and are drawn in a single drawIndexedInstanced call. Capacity matches the physics
    // maxEntities (4096) so spawning many props doesn't overflow.
    this.cubeInstanceStride = 96;
    this.cubeInstanceBuffer = device.createBuffer({
      label: "cube-instance",
      size: this.cubeInstanceStride * 4096,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Default white texture (1×1) for props without paint
    this.cubeDefaultTexture = device.createTexture({
      label: "cube-default-tex",
      size: [1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const white = new Uint8Array([255, 255, 255, 255]);
    device.queue.writeTexture(
      { texture: this.cubeDefaultTexture },
      white,
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    );

    // Sampler
    this.cubeSampler = device.createSampler({
      label: "cube-sampler",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
    });

    const shader = device.createShaderModule({ label: "cube", code: CUBE_SHADER });
    this.cubePipeline = device.createRenderPipeline({
      label: "cube",
      layout: "auto",
      vertex: {
        module: shader, entryPoint: "vs",
        buffers: [{
          arrayStride: 32,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x2" },
            { shaderLocation: 2, offset: 20, format: "float32x3" },
          ],
        }],
      },
      fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: {
        format: DEPTH_FORMAT as GPUTextureFormat,
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });
    // Store the bind group layout for compatibility
    this.cubeBindGroup0Layout = this.cubePipeline.getBindGroupLayout(0);
    // Single shared bind group 0: uniform + instance storage buffer.
    // One bind group serves ALL cube instances — no per-instance bind groups.
    this.cubeBindGroup0 = device.createBindGroup({
      layout: this.cubeBindGroup0Layout,
      entries: [
        { binding: 0, resource: { buffer: this.cubeUniformBuffer! } },
        { binding: 1, resource: { buffer: this.cubeInstanceBuffer! } },
      ],
    });
    // Pre-create the default (no-paint) bind group 1 for cubes
    this.cubeDefaultBindGroup1 = device.createBindGroup({
      layout: this.cubePipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: this.cubeDefaultTexture.createView() },
        { binding: 1, resource: this.cubeSampler },
      ],
    });
  }

  private createSpherePipeline(device: GPUDevice, format: GPUTextureFormat): void {
    this.sphereVertexBuffer = device.createBuffer({
      label: "sphere-vertices",
      size: SPHERE_VERTICES.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.sphereVertexBuffer, 0, SPHERE_VERTICES.buffer);

    this.sphereIndexBuffer = device.createBuffer({
      label: "sphere-indices",
      size: SPHERE_INDICES.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.sphereIndexBuffer, 0, SPHERE_INDICES.buffer);
    this.sphereIndexCount = SPHERE_INDICES.length;

    // Reuse the same shader, uniform buffer, instance buffer, sampler, and default texture
    const shader = device.createShaderModule({ label: "sphere", code: CUBE_SHADER });
    this.spherePipeline = device.createRenderPipeline({
      label: "sphere",
      layout: "auto",
      vertex: {
        module: shader, entryPoint: "vs",
        buffers: [{
          arrayStride: 32,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x2" },
            { shaderLocation: 2, offset: 20, format: "float32x3" },
          ],
        }],
      },
      fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: {
        format: DEPTH_FORMAT as GPUTextureFormat,
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });
    // Single shared bind group 0 for spheres: uniform + instance storage buffer.
    this.sphereBindGroup0 = device.createBindGroup({
      layout: this.spherePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cubeUniformBuffer! } },
        { binding: 1, resource: { buffer: this.cubeInstanceBuffer! } },
      ],
    });
    // Pre-create the default (no-paint) bind group 1 for spheres
    this.sphereDefaultBindGroup1 = device.createBindGroup({
      layout: this.spherePipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: this.cubeDefaultTexture!.createView() },
        { binding: 1, resource: this.cubeSampler! },
      ],
    });

    // ── Post-process outline: mask + composite pipelines ──
    // Mask pipeline: renders geometry as solid white to a mask texture.
    // Uses depth testing (depthCompare "less-equal", no write) so the mask
    // respects occlusion by other objects already in the depth buffer.
    this.maskUniformBuffer = device.createBuffer({
      label: "outline-mask-uniform",
      size: 128, // viewProj(64) + model(64)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const maskShader = device.createShaderModule({ label: "outline-mask", code: MASK_SHADER });
    this.maskPipeline = device.createRenderPipeline({
      label: "outline-mask",
      layout: "auto",
      vertex: {
        module: maskShader, entryPoint: "vs_mask",
        buffers: [{
          arrayStride: 32,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
        }],
      },
      fragment: { module: maskShader, entryPoint: "fs_mask", targets: [{ format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: {
        format: DEPTH_FORMAT as GPUTextureFormat,
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
    });
    this.maskBindGroup = device.createBindGroup({
      layout: this.maskPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.maskUniformBuffer } }],
    });

    // Composite pipeline: fullscreen pass that reads scene color + mask,
    // detects edges, and draws the outline.  No depth test.
    this.compositeUniformBuffer = device.createBuffer({
      label: "outline-composite-uniform",
      // texelSize(8) + outlineWidth(4) + pad(4) + outlineColor(12) + pad(4) = 32 bytes
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.compositeSampler = device.createSampler({
      label: "outline-composite-sampler",
      magFilter: "nearest",
      minFilter: "nearest",
    });
    const compositeShader = device.createShaderModule({ label: "outline-composite", code: OUTLINE_COMPOSITE_SHADER });
    this.compositePipeline = device.createRenderPipeline({
      label: "outline-composite",
      layout: "auto",
      vertex: { module: compositeShader, entryPoint: "vs_composite" },
      fragment: { module: compositeShader, entryPoint: "fs_composite", targets: [{ format: "rgba16float" }] },
      primitive: { topology: "triangle-list" },
    });
  }

  /** Wireframe hitbox overlay pipeline (line-list, always-on-top, HDR target). */
  private createHitboxPipeline(device: GPUDevice, format: GPUTextureFormat): void {
    const HITBOX_SHADER = /* wgsl */ `
struct Uniforms { viewProj: mat4x4f };
struct Instance { model: mat4x4f, color: vec4f };
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> instances: array<Instance>;
struct VOut { @builtin(position) pos: vec4f, @location(0) color: vec3f };
@vertex
fn vs(@builtin(instance_index) ii: u32, @location(0) pos: vec3f) -> VOut {
  var out: VOut;
  out.pos = u.viewProj * instances[ii].model * vec4f(pos, 1.0);
  out.color = instances[ii].color.rgb;
  return out;
}
@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  return vec4f(in.color, 1.0);
}`;
    // Uniform buffer: viewProj (64 bytes)
    this.hitboxUniformBuffer = device.createBuffer({
      label: "hitbox-uniforms",
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Instance storage buffer: mat4(64) + color(16) = 80 bytes per instance.
    this.hitboxInstanceBuffer = device.createBuffer({
      label: "hitbox-instances",
      size: 80 * (WebGPURenderer.INTERP_MAX_ENTITIES + 1),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // Unit wireframe geometry buffers.
    this.hitboxBoxVB = device.createBuffer({
      label: "hitbox-box-vb",
      size: WIRE_BOX_VERTICES.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.hitboxBoxVB, 0, WIRE_BOX_VERTICES);
    this.hitboxSphereVB = device.createBuffer({
      label: "hitbox-sphere-vb",
      size: WIRE_SPHERE_VERTICES.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.hitboxSphereVB, 0, WIRE_SPHERE_VERTICES);
    // Capsule vertex buffer is (re)created when dimensions change — start with
    // a 1-byte placeholder so the buffer exists.
    this.hitboxCapsuleVB = device.createBuffer({
      label: "hitbox-capsule-vb",
      size: 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    const shader = device.createShaderModule({ label: "hitbox", code: HITBOX_SHADER });
    this.hitboxPipeline = device.createRenderPipeline({
      label: "hitbox",
      layout: "auto",
      vertex: {
        module: shader, entryPoint: "vs",
        buffers: [{
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
        }],
      },
      fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "line-list" },
      depthStencil: {
        format: DEPTH_FORMAT as GPUTextureFormat,
        // Always visible (drawn on top of the scene) so hitboxes show through
        // walls and the prop's own mesh — typical debug-overlay behavior.
        depthWriteEnabled: false,
        depthCompare: "always",
      },
    });
    this.hitboxBindGroup = device.createBindGroup({
      label: "hitbox-bg0",
      layout: this.hitboxPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.hitboxUniformBuffer } },
        { binding: 1, resource: { buffer: this.hitboxInstanceBuffer } },
      ],
    });
  }

  private createDepthOnlyPipelines(device: GPUDevice): void {
    // Instanced depth-only shader: vertex transforms by lightVP * instances[ii].model.
    // Shares the same 96-byte Instance layout as the scene shader so both passes
    // can use the same instance storage buffer.
    const DEPTH_ONLY_SHADER = /* wgsl */ `
struct Uniforms {
  lightVP: mat4x4f,
};
struct Instance {
  model: mat4x4f,
  color: vec4f,
  hasPaint: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> instances: array<Instance>;
@vertex
fn vs(@builtin(instance_index) ii: u32, @location(0) pos: vec3f) -> @builtin(position) vec4f {
  return u.lightVP * instances[ii].model * vec4f(pos, 1.0);
}
`;
    this.depthOnlyShader = device.createShaderModule({ label: "depth-only", code: DEPTH_ONLY_SHADER });

    // Ground depth-only shader: no instance buffer (ground is a single static mesh).
    const GROUND_DEPTH_SHADER = /* wgsl */ `
struct Uniforms {
  lightVP: mat4x4f,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@vertex
fn vs(@location(0) pos: vec3f) -> @builtin(position) vec4f {
  return u.lightVP * vec4f(pos, 1.0);
}
`;
    const groundDepthShader = device.createShaderModule({ label: "depth-only-ground", code: GROUND_DEPTH_SHADER });

    // Uniform buffer for the light VP matrix (64 bytes).
    this.depthOnlyCubeUniformBuffer = device.createBuffer({
      label: "depth-only-uniforms",
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const depthStencil: GPUDepthStencilState = {
      format: "depth32float" as GPUTextureFormat,
      depthWriteEnabled: true,
      depthCompare: "less",
    };

    // Ground depth-only pipeline (uses the same ground vertex buffer: vec3 positions)
    this.depthOnlyGroundPipeline = device.createRenderPipeline({
      label: "depth-only-ground",
      layout: "auto",
      vertex: {
        module: groundDepthShader, entryPoint: "vs",
        buffers: [{
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
        }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil,
    });
    this.groundDepthBindGroup = device.createBindGroup({
      label: "ground-depth-bg0",
      layout: this.depthOnlyGroundPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.depthOnlyCubeUniformBuffer } }],
    });

    // Cube/sphere depth-only pipeline (uses the same vertex layout: pos3 + uv2 + normal3 = 32 bytes)
    const cubeVertexLayout: GPUVertexBufferLayout = {
      arrayStride: 32,
      attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
    };
    this.depthOnlyCubePipeline = device.createRenderPipeline({
      label: "depth-only-cube",
      layout: "auto",
      vertex: { module: this.depthOnlyShader, entryPoint: "vs", buffers: [cubeVertexLayout] },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil,
    });
    this.depthOnlySpherePipeline = device.createRenderPipeline({
      label: "depth-only-sphere",
      layout: "auto",
      vertex: { module: this.depthOnlyShader, entryPoint: "vs", buffers: [cubeVertexLayout] },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil,
    });
    // Single shared bind group 0 per depth pipeline: lightVP uniform + instance storage.
    this.depthCubeBindGroup0 = device.createBindGroup({
      label: "depth-cube-bg0",
      layout: this.depthOnlyCubePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.depthOnlyCubeUniformBuffer } },
        { binding: 1, resource: { buffer: this.cubeInstanceBuffer! } },
      ],
    });
    this.depthSphereBindGroup0 = device.createBindGroup({
      label: "depth-sphere-bg0",
      layout: this.depthOnlySpherePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.depthOnlyCubeUniformBuffer } },
        { binding: 1, resource: { buffer: this.cubeInstanceBuffer! } },
      ],
    });
  }

  // ── Load a model and upload it to the ModelRenderer ──
  async loadPropModel(contentId: string, modelUri: string): Promise<string> {
    const nodeId = `prop-${this.nextNodeId++}`;
    // Base URL for resolving relative texture URIs (e.g. "Textures/colormap.png")
    const modelBaseUrl = modelUri.substring(0, modelUri.lastIndexOf("/") + 1);
    if (this.modelCache.has(contentId)) {
      const model = this.modelCache.get(contentId)!;
      this.modelRenderer!.uploadModel(nodeId, model.meshes, model.materials, modelBaseUrl);
      this.nodeToContent.set(nodeId, contentId);
      return nodeId;
    }
    try {
      const resp = await fetch(modelUri);
      const buffer = await resp.arrayBuffer();
      const filename = modelUri.split("/").pop() ?? "model.glb";
      const model = await loadModel(buffer, filename) as ModelData;
      this.modelCache.set(contentId, model);
      this.modelRenderer!.uploadModel(nodeId, model.meshes, model.materials, modelBaseUrl);
      this.nodeToContent.set(nodeId, contentId);
      return nodeId;
    } catch (err) {
      console.error(`[WebGPURenderer] Failed to load model ${modelUri}:`, err);
      return "";
    }
  }

  /**
   * Compute (and cache) a downsampled convex-hull point cloud for a loaded
   * model, in mesh-local space. Returns null if the model has no geometry or
   * isn't loaded yet. Callers scale the result by the prop's spawn scale and
   * send it to the sim, which builds a Rapier convex collider from the points.
   */
  getColliderHull(contentId: string): Float32Array | null {
    if (this.hullCache.has(contentId)) return this.hullCache.get(contentId)!;
    const model = this.modelCache.get(contentId);
    let result: Float32Array | null = null;
    if (model && model.meshes.length > 0) {
      const hull = computeConvexHullPoints(model.meshes);
      result = hull ? hull.vertices : null;
    }
    this.hullCache.set(contentId, result);
    return result;
  }

  /**
   * Build (and cache) a line-list wireframe of the convex hull for the F1
   * debug overlay. Returns the vertex buffer + vertex count, or null if the
   * model has no hull. The wireframe is in mesh-local space (same as the
   * hull points); the caller transforms it via the instance model matrix.
   */
  private getHullWireframe(contentId: string): { vb: GPUBuffer; vertCount: number } | null {
    if (this.hullWireCache.has(contentId)) return this.hullWireCache.get(contentId) ?? null;
    const device = this.getDevice();
    const hull = this.getColliderHull(contentId);
    let result: { vb: GPUBuffer; vertCount: number } | null = null;
    if (device && hull && hull.length >= 9) {
      const faces = computeConvexHullFaces(hull);
      console.log(`[HullWire] ${contentId}: pts=${hull.length / 3} faces=${faces ? faces.length / 3 : "null"}`);
      if (faces && faces.length >= 6) {
        // Build line-list: each triangle (a,b,c) → edges a-b, b-c, c-a.
        // 3 edges × 2 verts = 6 verts per face.
        const lines = new Float32Array(faces.length * 2);
        for (let f = 0; f < faces.length; f += 3) {
          const a = faces[f], b = faces[f + 1], c = faces[f + 2];
          // a-b
          lines[f * 2]     = hull[a * 3];
          lines[f * 2 + 1] = hull[a * 3 + 1];
          lines[f * 2 + 2] = hull[a * 3 + 2];
          lines[f * 2 + 3] = hull[b * 3];
          lines[f * 2 + 4] = hull[b * 3 + 1];
          lines[f * 2 + 5] = hull[b * 3 + 2];
          // b-c
          lines[f * 2 + 6] = hull[b * 3];
          lines[f * 2 + 7] = hull[b * 3 + 1];
          lines[f * 2 + 8] = hull[b * 3 + 2];
          lines[f * 2 + 9] = hull[c * 3];
          lines[f * 2 + 10] = hull[c * 3 + 1];
          lines[f * 2 + 11] = hull[c * 3 + 2];
          // c-a
          lines[f * 2 + 12] = hull[c * 3];
          lines[f * 2 + 13] = hull[c * 3 + 1];
          lines[f * 2 + 14] = hull[c * 3 + 2];
          lines[f * 2 + 15] = hull[a * 3];
          lines[f * 2 + 16] = hull[a * 3 + 1];
          lines[f * 2 + 17] = hull[a * 3 + 2];
        }
        const vb = device.createBuffer({
          label: `hull-wire-${contentId}`,
          size: lines.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(vb, 0, lines);
        result = { vb, vertCount: lines.length / 3 };
      }
    }
    this.hullWireCache.set(contentId, result);
    return result;
  }

  // ── Camera control ──
  setCameraPosition(pos: [number, number, number]): void { this.camPos = pos; }
  setCameraTarget(target: [number, number, number]): void { this.camTarget = target; }
  getCameraPosition(): [number, number, number] { return this.camPos; }
  getCameraTarget(): [number, number, number] { return this.camTarget; }

  /** Returns prop collider info: [centerX, centerY, centerZ, halfX, halfY, halfZ] for boxes, [cx,cy,cz,radius] for spheres. */
  getPropColliders(): Array<{ pos: [number, number, number]; halfExtents: [number, number, number] | null; radius: number; shape: number }> {
    if (!this.simReader) return [];
    const count = this.simReader.getEntityCount();
    const result: Array<{ pos: [number, number, number]; halfExtents: [number, number, number] | null; radius: number; shape: number }> = [];
    for (let i = 0; i < count; i++) {
      const slot = this.simReader.getEntitySlot(i);
      const type = slot.u32[ENT.TYPE];
      if (type === 255 || (type !== EntityType.Prop && type !== EntityType.Mannequin)) continue;
      const px = slot.f32[ENT.POS_X];
      const py = slot.f32[ENT.POS_Y];
      const pz = slot.f32[ENT.POS_Z];
      const scale = slot.f32[ENT.SCALE] || 1.0;
      const shape = slot.f32[ENT_DATA.SHAPE + ENT.DATA];
      if (shape === 1) {
        result.push({ pos: [px, py, pz], halfExtents: null, radius: 0.5 * scale, shape: 1 });
      } else {
        const half = 0.5 * scale;
        result.push({ pos: [px, py, pz], halfExtents: [half, half, half], radius: 0, shape: 0 });
      }
    }
    return result;
  }

  // ── Paint texture upload ──
  private paintTextures = new Map<number, GPUTexture>();
  // Entity id currently grabbed by the physgun in Ghost mode (null otherwise).
  // The model + builtin prop shaders render this entity as a cyan hologram so
  // the player can tell at a glance that the grab ignores collisions.
  private ghostGrabEntity: number | null = null;
  /** Set/clear the entity id rendered with the ghost-mode hologram shader. */
  setGhostGrabEntity(entityId: number | null): void { this.ghostGrabEntity = entityId; }
  // Entity id currently under the physgun crosshair (null otherwise). The
  // shaders render this entity with a bright rim outline so the player can
  // see which prop a grab would target.
  private hoverEntity: number | null = null;
  /** Set/clear the entity id rendered with the hover outline shader. */
  setHoverEntity(entityId: number | null): void { this.hoverEntity = entityId; }

  // ── Hitbox / collider debug overlay (F1) ──
  // When enabled, renders wireframe colliders for every prop + the player
  // capsule on top of the scene. Props use box/sphere wireframes scaled by the
  // prop's model matrix (matches getPropColliders); the player uses a capsule
  // regenerated from the current pose dimensions.
  private showHitboxes = false;
  private hitboxPipeline: GPURenderPipeline | null = null;
  private hitboxUniformBuffer: GPUBuffer | null = null;
  private hitboxInstanceBuffer: GPUBuffer | null = null;
  private hitboxBindGroup: GPUBindGroup | null = null;
  private hitboxBoxVB: GPUBuffer | null = null;
  private hitboxSphereVB: GPUBuffer | null = null;
  private hitboxCapsuleVB: GPUBuffer | null = null;
  private hitboxCapsuleVertexCount = 0;
  // Instance staging: mat4(16) + color(4) = 20 floats per instance. +1 for player.
  private hitboxStaging = new Float32Array((WebGPURenderer.INTERP_MAX_ENTITIES + 1) * 20);
  // Player capsule dimensions (set from main.tsx each frame). Position is feet.
  private playerHitbox: { x: number; y: number; z: number; height: number; radius: number } | null = null;
  // Cached capsule key so we only regenerate geometry when dimensions change.
  private capsuleCacheKey = "";
  // Hull wireframe cache: contentId → { vertex buffer, line count } for the
  // F1 debug overlay. Built from the hull point cloud + computed faces.
  private hullWireCache = new Map<string, { vb: GPUBuffer; vertCount: number } | null>();
  /** Toggle the hitbox/collider debug overlay. */
  setShowHitboxes(v: boolean): void { this.showHitboxes = v; }
  isShowHitboxes(): boolean { return this.showHitboxes; }
  /** Update the player capsule collider for the hitbox overlay (feet position).
   * Pass null to disable (e.g. in first-person where the camera is inside it). */
  setPlayerHitbox(x: number | null, y: number, z: number, height: number, radius: number): void {
    if (x === null) { this.playerHitbox = null; return; }
    this.playerHitbox = { x, y, z, height, radius };
  }
  // Slot index + shape of the hovered builtin prop (set by collectRenderEntities).
  private hoverOutlineSlot: number = -1;
  private hoverOutlineIsSphere: boolean = false;
  // Model matrix (16 floats) of the hovered builtin prop, copied from the
  // instance staging buffer during collectRenderEntities.
  private hoverModelMatrix = new Float32Array(16);
  // Hovered model prop tracking (set when the hovered entity has a model).
  private hoverModelNodeId: string | null = null;
  private hoverModelPos: [number, number, number] = [0, 0, 0];
  private hoverModelRot: [number, number, number, number] = [0, 0, 0, 1];
  private hoverModelScale: [number, number, number] = [1, 1, 1];
  uploadPaintTexture(entityId: number, data: Uint8ClampedArray, width: number, height: number): void {
    const device = this.getDevice();
    if (!device) return;
    if (!this.paintTextures.has(entityId)) {
      const mipCount = MipmapHelper.mipLevelCount(width, height);
      const tex = device.createTexture({
        label: `paint-${entityId}`,
        size: [width, height],
        format: "rgba8unorm",
        mipLevelCount: mipCount,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.paintTextures.set(entityId, tex);
    }
    const tex = this.paintTextures.get(entityId)!;
    device.queue.writeTexture(
      { texture: tex },
      new Uint8Array(data),
      { bytesPerRow: width * 4 },
      { width, height },
    );
    if (this.mipmapsEnabled && this.mipmapHelper && tex.mipLevelCount > 1) {
      this.mipmapHelper.generateMipmaps(tex, "rgba8unorm", width, height);
    }
  }

  uploadGroundPaintTexture(data: Uint8ClampedArray, width: number, height: number): void {
    const device = this.getDevice();
    if (!device || !this.groundPaintTexture) return;
    device.queue.writeTexture(
      { texture: this.groundPaintTexture },
      new Uint8Array(data),
      { bytesPerRow: width * 4 },
      { width, height },
    );
    if (this.mipmapsEnabled && this.mipmapHelper && this.groundPaintTexture.mipLevelCount > 1) {
      this.mipmapHelper.generateMipmaps(this.groundPaintTexture, "rgba8unorm", width, height);
    }
  }

  // ── Graphics settings setters (Phase 6 wiring) ──
  setFXAAEnabled(enabled: boolean): void {
    this.fxaaEnabled = enabled;
    this.postProcessStack?.setEnabled("fxaa", enabled);
  }
  setBloomEnabled(enabled: boolean): void {
    this.bloomEnabled = enabled;
    this.postProcessStack?.setEnabled("bloom", enabled);
  }
  setBloomStrength(v: number): void { this.postProcessStack?.setBloomStrength(v); }
  setBloomThreshold(v: number): void { this.postProcessStack?.setBloomThreshold(v); }
  setTonemapEnabled(enabled: boolean): void {
    this.tonemapEnabled = enabled;
    this.postProcessStack?.setEnabled("tonemap", enabled);
  }
  setExposure(v: number): void { this.postProcessStack?.setExposure(v); }
  setVignetteEnabled(enabled: boolean): void {
    this.vignetteEnabled = enabled;
    this.postProcessStack?.setEnabled("vignette", enabled);
  }
  setVignetteStrength(v: number): void { this.postProcessStack?.setVignette(v); }
  setMipmapsEnabled(enabled: boolean): void { this.mipmapsEnabled = enabled; }
  setSunColor(r: number, g: number, b: number): void { this.lighting?.setSunColor([r, g, b]); }
  setSunDirection(x: number, y: number, z: number): void { this.lighting?.setSunDirection([x, y, z]); }
  setSkyAmbient(r: number, g: number, b: number): void { this.lighting?.setSkyAmbient([r, g, b]); }
  setGroundAmbient(r: number, g: number, b: number): void { this.lighting?.setGroundAmbient([r, g, b]); }
  setAmbientIntensity(v: number): void { this.lighting?.setAmbientIntensity(v); }
  setPointLights(lights: PointLight[]): void { this.lighting?.setPointLights(lights); }
  setPointLightsEnabled(enabled: boolean): void { this.lighting?.setPointLightsEnabled(enabled); }
  setShadowsEnabled(enabled: boolean): void { this.shadowsEnabled = enabled; this.shadows?.setEnabled(enabled); }
  getShadows(): SandboxShadows | null { return this.shadows; }
  getLighting(): SandboxLighting | null { return this.lighting; }
  getPostProcessStack(): PostProcessStack | null { return this.postProcessStack; }

  // ── Render loop ──
  private frameLoop = (): void => {
    if (!this.sandboxRunning || this._deviceLost) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.sandboxLastTime) / 1000);
    this.sandboxLastTime = now;
    this._elapsedTime += dt;

    try {
      this.drawFrame(dt);
    } catch (err) {
      console.error(`[WebGPURenderer] Frame error: ${(err as Error).message}`);
    }
    this.rafHandle = requestAnimationFrame(this.frameLoop);
  };

  /** Collect point lights from the sim (projectiles emit warm light). */
  private collectPointLights(): void {
    if (!this.lighting || !this.simReader) return;
    const interp = this.interpOut;
    const count = this.simReader.getEntityCount();
    const lights: PointLight[] = [];
    for (let i = 0; i < count && lights.length < 8; i++) {
      // Direct slot access — avoids getEntitySlot object allocation.
      const sv = this.simReader.getEntitySlotDirect(i);
      const type = sv.u32[ENT.TYPE];
      if (type === 255) continue;
      if (type === EntityType.Projectile) {
        // Projectiles emit a warm orange glow.
        // Use interpolated position so the light matches the rendered projectile.
        const off = i * 8;
        const px = interp ? interp[off]     : sv.f32[ENT.POS_X];
        const py = interp ? interp[off + 1] : sv.f32[ENT.POS_Y];
        const pz = interp ? interp[off + 2] : sv.f32[ENT.POS_Z];
        lights.push({
          position: [px, py, pz],
          color: [1.0, 0.6, 0.2],
          intensity: 2.0,
          radius: 8.0,
        });
      }
    }
    this.lighting.setPointLights(lights);
  }

  // ── Entity transform interpolation ──
  // Called once per frame at the top of drawFrame, before any rendering.
  // Detects sim tick changes, snapshots transforms into the InterpolationBuffer,
  // and produces an interpolated transform buffer for this frame's alpha.
  private updateInterpolation(): void {
    if (!this.simReader || !this.interpBuffer || !this.interpOut || !this.interpScratch) return;

    const tick = this.simReader.getTick();
    if (tick !== this.interpLastTick) {
      const count = Math.min(this.simReader.getEntityCount(), WebGPURenderer.INTERP_MAX_ENTITIES);

      // Read all entity transforms from the SAB into the scratch buffer, then
      // feed to writeTick which swaps prev/curr internally.
      const scratch = this.interpScratch;
      for (let i = 0; i < count; i++) {
        const slot = this.simReader.getEntitySlot(i);
        const off = i * 8;
        scratch[off]     = slot.f32[ENT.POS_X];
        scratch[off + 1] = slot.f32[ENT.POS_Y];
        scratch[off + 2] = slot.f32[ENT.POS_Z];
        scratch[off + 3] = slot.f32[ENT.ROT_X];
        scratch[off + 4] = slot.f32[ENT.ROT_Y];
        scratch[off + 5] = slot.f32[ENT.ROT_Z];
        scratch[off + 6] = slot.f32[ENT.ROT_W];
        scratch[off + 7] = slot.f32[ENT.SCALE];
      }

      this.interpBuffer.writeTick(
        0, // realmId — unused (sandbox has a single realm)
        (_realmId: number, buf: Float32Array, entityCount: number) => { buf.set(scratch.subarray(0, entityCount * 8)); },
        count,
      );

      this.interpLastTick = tick;
      this.interpLastTickTime = performance.now();
    }

    // Alpha: how far we are between the last tick and the next expected tick.
    // Clamped to [0, 1] — at render rates > sim rate, alpha stalls at 1.0
    // until the next tick arrives (showing the curr state, no extrapolation).
    const now = performance.now();
    const alpha = SIM_TICK_DT > 0
      ? Math.min(1, (now - this.interpLastTickTime) / (SIM_TICK_DT * 1000))
      : 1;

    const count = Math.min(this.simReader.getEntityCount(), WebGPURenderer.INTERP_MAX_ENTITIES);
    this.interpBuffer.readInterpolated(alpha, this.interpOut, count);
  }

  private drawFrame(dt: number): void {
    const device = this.getDevice();
    const context = this.getContext();
    if (!device || !context || !this.skyPipeline || !this.groundPipeline) return;
    if (!this.postProcessStack) return;

    // Update interpolated transforms before any rendering (shadows + scene).
    this.updateInterpolation();

    const canvas = this.getCanvas();
    const w = canvas.width;
    const h = canvas.height;

    // Camera view-projection
    const aspect = w / h;
    const cameraState: CameraState = {
      position: this.camPos,
      target: this.camTarget,
      up: this.camUp,
      fov: this.camFov,
      aspect,
      near: this.camNear,
      far: this.camFar,
    };
    const viewProj = new Float32Array(16);
    calculateViewProjInto(cameraState, viewProj);

    // Compute separate proj/view/invProj for the postfx stack (needed by
    // SSAO/SSR/TAA in later phases; cheap to wire now).
    const fovRad = (this.camFov * Math.PI) / 180;
    const proj = mat4.perspective(fovRad, aspect, this.camNear, this.camFar);
    const view = mat4.lookAt(this.camPos, this.camTarget, this.camUp);
    const invProj = mat4.invert(proj);
    const viewProjMat = mat4.multiply(proj, view);
    const invViewProj = mat4.invert(viewProjMat);
    this.postProcessStack.setCameraMatrices(proj, invProj, view);
    this.postProcessStack.update(dt);

    // Update ground uniforms
    const uniformData = new Float32Array(20);
    uniformData.set(viewProj, 0);
    uniformData[16] = this.camPos[0];
    uniformData[17] = this.camPos[1];
    uniformData[18] = this.camPos[2];
    device.queue.writeBuffer(this.groundUniformBuffer!, 0, uniformData);

    // Update sky uniforms (inverse view-proj + camera position)
    const skyUniformData = new Float32Array(20);
    skyUniformData.set(invViewProj as Float32Array, 0);
    skyUniformData[16] = this.camPos[0];
    skyUniformData[17] = this.camPos[1];
    skyUniformData[18] = this.camPos[2];
    device.queue.writeBuffer(this.skyUniformBuffer!, 0, skyUniformData);

    // Prepare bindless frame bindings (flush material SSBO + (re)build the
    // bind group if the layout/version changed). Called once per frame; the
    // returned bind group is handed to the ModelRenderer below.
    const bindlessBg = this.bindlessFrameBindings?.prepareFrame() ?? null;

    // Upload frame-global lighting state
    if (this.lighting) {
      this.collectPointLights();
      this.lighting.upload();
    }
    // Provide the lighting bind group to the model renderer (group 2).
    if (this.modelRenderer && this.modelLightingBg) {
      this.modelRenderer.setFrameLightingBindGroup(this.modelLightingBg);
    }
    // Per-frame camera + light state for the ModelRenderer. beginFrame() sets
    // viewProjCache + cameraPosCache — without it, ModelRenderer.render()
    // early-returns (viewProjCache stays null) and model-based props (e.g. the
    // crate plugin's GLB) are never drawn, so they appear invisible. Builtin
    // cubes/spheres use the sandbox's own procedural pipelines and are
    // unaffected, which is why only model props were invisible.
    if (this.modelRenderer) {
      this.modelRenderer.beginFrame(cameraState);
      // Provide the bindless material bind group (group 3) for the model
      // pipeline. Without this, bindlessBindGroup stays null and render()
      // skips setBindGroup(3), leaving a stale group-3 bind group from the
      // builtin sphere/cube pipelines (e.g. sphere-shadow-bg, an auto-layout
      // bind group) bound — which is incompatible with the model pipeline's
      // explicit bindlessLayout → WebGPU uncaptured error on the model draw.
      this.modelRenderer.setBindlessBindGroup(bindlessBg);
      if (this.lighting) {
        this.modelRenderer.setLightState(
          this.lighting.getSunDirection(),
          this.lighting.getAmbientIntensity(),
          0.5,
        );
      }
    }

    // Collect visible builtin entities once — reused by both shadow + scene passes.
    this.collectRenderEntities();

    // Update + render the shadow map (before the main scene render).
    if (this.shadows && this.shadows.isEnabled() && this.lighting) {
      this.shadows.updateLightVP(this.lighting.getSunDirection(), this.camTarget);
      const shadowEncoder = device.createCommandEncoder();
      this.shadows.renderShadowMap({
        device,
        encoder: shadowEncoder,
        renderDepth: (pass) => this.renderShadowDepth(pass),
      });
      device.queue.submit([shadowEncoder.finish()]);
    }

    const usePP = this.postProcessStack.hasEnabledEffects();

    if (usePP) {
      // ── HDR path: render scene into PostProcessStack targets via FrameGraph ──
      this.postProcessStack.ensureTargets(w, h);
      const sceneColorView = this.postProcessStack.getSceneColorView();
      const sceneDepthView = this.postProcessStack.getSceneDepthView();

      const graph = this.getGraph();
      if (!this.graphColorHandle) {
        this.graphColorHandle = graph.importTextureView("color", null);
        this.graphDepthHandle = graph.importTextureView("depth", null);
        graph.markDirty();
      }
      graph.setImportedTextureView(this.graphColorHandle, sceneColorView);
      graph.setImportedTextureView(this.graphDepthHandle, sceneDepthView);

      const viewport = { x: 0, y: 0, w, h };
      const sceneState: ScenePassState = {
        viewportIdx: 0,
        viewport,
        camera: cameraState,
        viewProj,
        loadOp: "clear",
        clearValue: { r: 0.25, g: 0.35, b: 0.45, a: 1 },
      };

      graph.clearPasses();
      graph.markDirty();
      const scenePass = new SceneRenderPass(
        this.graphColorHandle,
        this.graphDepthHandle,
        sceneState,
        this.drawScene,
      );
      graph.addPass(scenePass);
      graph.compile(device, w, h);
      this.graphCompiled = true;

      const encoder = device.createCommandEncoder();
      const ctx: RenderContext = {
        device,
        encoder,
        pass: null,
        camera: cameraState,
        viewport,
        viewportIdx: 0,
        viewportCount: 1,
        dt,
        elapsedTime: this._elapsedTime,
        isFirstViewport: true,
        isLastViewport: true,
        width: w,
        height: h,
        viewProj,
        invViewProj,
        prevViewProj: undefined,
        cameraPos: this.camPos,
        lightData: null,
        lightViewProj: undefined,
        mesh: null,
        modelMatrix: undefined,
        shadowsEnabled: false,
        bloomEnabled: this.bloomEnabled,
        shadowSampler: null,
        debugQueue: null,
        opaqueVertexBuffer: null,
        opaqueIndexBuffer: null,
        opaqueIndexCount: 0,
        opaqueIndexFormat: "uint32",
        getView: (handle: TextureHandle) => graph.getTextureView(handle),
        getTexture: (handle: TextureHandle) => graph.getTexture(handle),
        addDrawCalls: () => {},
        addTriangles: () => {},
      };
      graph.execute(ctx);

      // ── Post-process outline: render hovered entity to mask, then
      // composite the edge-detected outline over the scene color. ──
      if (this.hoverEntity !== null && this.hoverEntity > 0) {
        this.renderOutlinePostProcess(encoder, w, h, viewProj, cameraState);
      }

      // Apply the post-process chain → canvas
      const canvasView = context.getCurrentTexture().createView();
      this.postProcessStack.applyChain(encoder, this.postProcessStack.getSceneDepthView(), canvasView, w, h, this._elapsedTime);
      device.queue.submit([encoder.finish()]);
    } else {
      // ── Fallback: render directly to the swapchain (no postfx enabled) ──
      const colorView = context.getCurrentTexture().createView();
      const depthTexture = this.getOrCreateDepthTexture(w, h);
      const depthView = depthTexture.createView();

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: colorView,
          clearValue: { r: 0.25, g: 0.35, b: 0.45, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        }],
        depthStencilAttachment: {
          view: depthView,
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });
      const viewport = { x: 0, y: 0, w, h };
      const sceneState: ScenePassState = {
        viewportIdx: 0,
        viewport,
        camera: cameraState,
        viewProj,
        loadOp: "clear",
        clearValue: { r: 0.25, g: 0.35, b: 0.45, a: 1 },
      };
      this.drawScene(pass, sceneState, encoder);
      pass.end();
      device.queue.submit([encoder.finish()]);
    }
  }

  /** Render scene depth-only into the shadow map from the sun's perspective. */
  private renderShadowDepth(pass: GPURenderPassEncoder): void {
    if (!this.shadows || !this.depthOnlyGroundPipeline || !this.depthOnlyCubePipeline) return;
    const lightVP = this.shadows.getLightVP();
    const device = this.getDevice()!;
    const shadowSize = this.shadows.getShadowMapSize();
    pass.setViewport(0, 0, shadowSize, shadowSize, 0, 1);

    // Write the light VP to the depth-only uniform buffer (64 bytes = 16 floats)
    this.lightVPStaging.set(lightVP);
    device.queue.writeBuffer(this.depthOnlyCubeUniformBuffer!, 0, this.lightVPStaging);

    // Ground — no instance buffer (uses the dedicated ground depth-only shader)
    pass.setPipeline(this.depthOnlyGroundPipeline!);
    pass.setBindGroup(0, this.groundDepthBindGroup!);
    pass.setVertexBuffer(0, this.groundVertexBuffer!);
    pass.draw(6);

    // Props (cubes + spheres) — instanced depth-only into the shadow map
    if (this.simReader) {
      this.renderBuiltinPropsDepth(pass);
      // Model-based props (e.g. crate GLB) — depth-only via ModelRenderer.
      if (this.modelRenderer) this.renderModelPropsDepth(pass, lightVP);
    }
  }

  /** Render builtin props (cubes + spheres) depth-only into the shadow map. */
  private renderBuiltinPropsDepth(pass: GPURenderPassEncoder): void {
    if (!this.simReader || !this.depthOnlyCubePipeline || !this.cubeVertexBuffer || !this.cubeIndexBuffer) return;
    if (!this.depthOnlyCubeUniformBuffer || !this.cubeInstanceBuffer) return;
    const device = this.getDevice()!;

    // Use precomputed entity lists + staging data from collectRenderEntities().
    const cubes = this.renderCubes;
    const spheres = this.renderSpheres;

    const stride = this.cubeInstanceStride;
    const maxInstances = Math.floor(this.cubeInstanceBuffer.size / stride);
    const staging = this.instanceStaging;

    const renderBatch = (
      indices: number[],
      pipeline: GPURenderPipeline,
      vertexBuffer: GPUBuffer,
      indexBuffer: GPUBuffer,
      indexCount: number,
      baseOffset: number,
      bg0: GPUBindGroup,
    ) => {
      const drawCount = Math.min(indices.length, maxInstances - baseOffset);
      if (drawCount <= 0) return;

      // Model matrices already in staging from collectRenderEntities().
      // Shadow pass uses the same packed order (no painted/unpainted split).
      // The staging data is at [0, drawCount*24) for this batch — but
      // collectRenderEntities wrote cubes at [0, cubes.length*24) and spheres
      // at [cubes.length, (cubes.length+spheres.length)*24). We need to
      // adjust the source offset for spheres.
      const srcOffset = baseOffset * 24 * 4;
      device.queue.writeBuffer(
        this.cubeInstanceBuffer!,
        baseOffset * stride,
        staging.buffer,
        srcOffset,
        drawCount * stride,
      );

      pass.setPipeline(pipeline);
      pass.setVertexBuffer(0, vertexBuffer);
      pass.setIndexBuffer(indexBuffer, "uint16");
      pass.setBindGroup(0, bg0);
      pass.drawIndexed(indexCount, drawCount, 0, 0, baseOffset);
    };

    if (cubes.length > 0) {
      renderBatch(cubes, this.depthOnlyCubePipeline, this.cubeVertexBuffer, this.cubeIndexBuffer, this.cubeIndexCount, 0, this.depthCubeBindGroup0!);
    }
    if (spheres.length > 0 && this.depthOnlySpherePipeline && this.sphereVertexBuffer && this.sphereIndexBuffer) {
      renderBatch(spheres, this.depthOnlySpherePipeline, this.sphereVertexBuffer, this.sphereIndexBuffer, this.sphereIndexCount, cubes.length, this.depthSphereBindGroup0!);
    }
  }

  /** Render model-based props depth-only into the shadow map. */
  private renderModelPropsDepth(pass: GPURenderPassEncoder, lightVP: Float32Array): void {
    if (!this.modelRenderer || !this.simReader) return;
    const interp = this.interpOut;
    const count = this.simReader.getEntityCount();
    for (let i = 0; i < count; i++) {
      const sv = this.simReader.getEntitySlotDirect(i);
      const u32 = sv.u32;
      const f32 = sv.f32;
      const type = u32[ENT.TYPE];
      if (type === 255 || (type !== EntityType.Prop && type !== EntityType.Mannequin)) continue;
      const nodeIdRaw = u32[ENT.ID];
      if (nodeIdRaw === 0) continue; // builtin prop — handled by renderBuiltinPropsDepth
      const nodeId = `prop-${nodeIdRaw}`;
      if (!this.nodeToContent.has(nodeId)) continue;

      const ioff = i * 8;
      const px = interp ? interp[ioff]       : f32[ENT.POS_X];
      const py = interp ? interp[ioff + 1]   : f32[ENT.POS_Y];
      const pz = interp ? interp[ioff + 2]   : f32[ENT.POS_Z];
      const scale = interp ? interp[ioff + 7] : f32[ENT.SCALE];
      const rx = interp ? interp[ioff + 3]   : f32[ENT.ROT_X];
      const ry = interp ? interp[ioff + 4]   : f32[ENT.ROT_Y];
      const rz = interp ? interp[ioff + 5]   : f32[ENT.ROT_Z];
      const rw = interp ? interp[ioff + 6]   : f32[ENT.ROT_W];
      // SQUISH_AXIS is a signed code (±1/±2/±3): axis = |code| - 1, sign = impact side.
      const squishAmount = f32[ENT_DATA.SQUISH_AMOUNT + ENT.DATA] || 0;
      const squishCode = f32[ENT_DATA.SQUISH_AXIS + ENT.DATA] | 0;
      const squishAxis = Math.abs(squishCode) - 1;
      const [sx, sy, sz] = this.applySquishScale(scale, squishAmount, squishAxis);
      // Anchor the squish at the impact point so the depth pass matches the
      // color pass (impact face stays put, far face compresses toward it).
      const [ox, oy, oz] = this.squishOffset(scale, squishAmount, squishCode, rx, ry, rz, rw);

      this.modelRenderer.renderDepth(
        pass, lightVP, nodeId,
        [px + ox, py + oy, pz + oz], [rx, ry, rz, rw], [sx, sy, sz],
      );
    }
  }

  // ── Scene draw (delegated to SceneRenderPass via the FrameGraph) ──
  private drawScene: SceneDrawFn = (
    pass: GPURenderPassEncoder,
    state: ScenePassState,
    _encoder: GPUCommandEncoder,
  ): void => {
    const viewProj = state.viewProj;

    // Sky (full-screen triangle, depth = far)
    pass.setPipeline(this.skyPipeline!);
    if (this.skyBindGroup) pass.setBindGroup(0, this.skyBindGroup);
    pass.draw(3);

    // Ground plane
    pass.setPipeline(this.groundPipeline!);
    pass.setBindGroup(0, this.groundBindGroup!);
    if (this.groundPaintBindGroup) pass.setBindGroup(1, this.groundPaintBindGroup);
    if (this.groundLightingBg) pass.setBindGroup(2, this.groundLightingBg);
    if (this.groundShadowBg) pass.setBindGroup(3, this.groundShadowBg);
    pass.setVertexBuffer(0, this.groundVertexBuffer!);
    pass.draw(6);

    // Props — builtin (procedural cubes) + model-based
    if (this.simReader) {
      this.renderBuiltinProps(pass, viewProj);
      if (this.modelRenderer) this.renderProps(pass);
    }

    // Hitbox / collider debug overlay (F1)
    if (this.showHitboxes) this.renderHitboxes(pass, viewProj);
  };

  private renderProps(pass: GPURenderPassEncoder): void {
    if (!this.modelRenderer || !this.simReader) return;
    const interp = this.interpOut;
    const count = this.simReader.getEntityCount();
    for (let i = 0; i < count; i++) {
      // Direct slot access — avoids getEntitySlot object allocation.
      const sv = this.simReader.getEntitySlotDirect(i);
      const u32 = sv.u32;
      const f32 = sv.f32;
      const type = u32[ENT.TYPE];
      if (type === 255 || (type !== EntityType.Prop && type !== EntityType.Mannequin)) continue;
      const nodeIdRaw = u32[ENT.ID];
      if (nodeIdRaw === 0) continue; // builtin prop (rendered as cube) or not yet uploaded
      const nodeId = `prop-${nodeIdRaw}`;
      if (!this.nodeToContent.has(nodeId)) continue;

      const ioff = i * 8;
      const px = interp ? interp[ioff]       : f32[ENT.POS_X];
      const py = interp ? interp[ioff + 1]   : f32[ENT.POS_Y];
      const pz = interp ? interp[ioff + 2]   : f32[ENT.POS_Z];
      const scale = interp ? interp[ioff + 7] : f32[ENT.SCALE];
      const rx = interp ? interp[ioff + 3]   : f32[ENT.ROT_X];
      const ry = interp ? interp[ioff + 4]   : f32[ENT.ROT_Y];
      const rz = interp ? interp[ioff + 5]   : f32[ENT.ROT_Z];
      const rw = interp ? interp[ioff + 6]   : f32[ENT.ROT_W];
      // SQUISH_AXIS is a signed code (±1/±2/±3): axis = |code| - 1, sign = impact side.
      const squishAmount = f32[ENT_DATA.SQUISH_AMOUNT + ENT.DATA] || 0;
      const squishCode = f32[ENT_DATA.SQUISH_AXIS + ENT.DATA] | 0;
      const squishAxis = Math.abs(squishCode) - 1;
      const [sx, sy, sz] = this.applySquishScale(scale, squishAmount, squishAxis);
      // Anchor the squish at the impact point: shift the center toward the
      // impact side so the impact face stays put and the far face compresses in.
      const [ox, oy, oz] = this.squishOffset(scale, squishAmount, squishCode, rx, ry, rz, rw);
      const tpx = px + ox;
      const tpy = py + oy;
      const tpz = pz + oz;

      this.modelRenderer.render(
        pass,
        nodeId,
        [tpx, tpy, tpz],
        [rx, ry, rz, rw],
        [sx, sy, sz],
        0,
        // Ghost hologram when this is the physgun's ghost-grabbed prop.
        (i + 1) === this.ghostGrabEntity ? 1 : 0,
      );

      // Track the hovered model prop for the post-process outline mask.
      if ((i + 1) === this.hoverEntity) {
        this.hoverModelNodeId = nodeId;
        this.hoverModelPos = [tpx, tpy, tpz];
        this.hoverModelRot = [rx, ry, rz, rw];
        this.hoverModelScale = [sx, sy, sz];
      }
    }
  }

  // ── Hitbox / collider debug overlay (F1) ─────────────────────────────────
  // Renders wireframe colliders for every prop (box or sphere, scaled by the
  // prop's interpolated model matrix — matches getPropColliders) plus the
  // player capsule. Drawn on top of the scene (depthCompare "always") in the
  // scene color pass so it composites through the postfx chain.
  private renderHitboxes(pass: GPURenderPassEncoder, viewProj: Float32Array): void {
    if (!this.hitboxPipeline || !this.hitboxBindGroup || !this.simReader || !this.interpOut) return;
    if (!this.hitboxUniformBuffer || !this.hitboxInstanceBuffer) return;
    // Capture locals before any `this` method calls — calling this.getDevice()
    // below would invalidate narrowing of this.simReader / this.interpOut.
    const reader = this.simReader;
    const interp = this.interpOut;
    const staging = this.hitboxStaging;
    const device = this.getDevice()!;

    // Write the viewProj uniform. Copy into an ArrayBuffer-backed view first —
    // viewProj is a Float32Array parameter (ArrayBufferLike), which isn't
    // assignable to GPUAllowSharedBufferSource on TS 5.7+ @webgpu/types.
    const vp = new Float32Array(16);
    vp.set(viewProj);
    device.queue.writeBuffer(this.hitboxUniformBuffer, 0, vp);

    // Pack boxes first, then spheres, then the player capsule last.
    let boxCount = 0;
    let sphereCount = 0;
    const count = reader.getEntityCount();
    for (let i = 0; i < count; i++) {
      const sv = reader.getEntitySlotDirect(i);
      const u32 = sv.u32;
      const f32 = sv.f32;
      const type = u32[ENT.TYPE];
      if (type === 255) continue;
      if (type !== EntityType.Prop && type !== EntityType.Mannequin && type !== EntityType.Projectile) continue;

      const ioff = i * 8;
      const px = interp[ioff];
      const py = interp[ioff + 1];
      const pz = interp[ioff + 2];
      const scale = interp[ioff + 7] || 1.0;
      const rx = interp[ioff + 3];
      const ry = interp[ioff + 4];
      const rz = interp[ioff + 5];
      const rw = interp[ioff + 6];
      const shape = f32[ENT_DATA.SHAPE + ENT.DATA];
      // shape: 0=box, 1=sphere, 2=hull (convex hull collider — drawn as
      // magenta wireframe in the second loop below). Skip the placeholder
      // box/sphere for hull-backed props so we don't draw both.
      if (shape === 2) continue;
      const isSphere = shape === 1;

      // Per-type wireframe color.
      let cr = 0.15, cg = 1.0, cb = 0.25; // Prop — green
      if (type === EntityType.Projectile) { cr = 1.0; cg = 0.85; cb = 0.1; } // yellow
      else if (type === EntityType.Mannequin) { cr = 0.2; cg = 0.9; cb = 1.0; } // cyan

      // Compose model matrix = T * R * S (column-major, matching the cube shader).
      const ql = Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw) || 1;
      const qx = rx / ql, qy = ry / ql, qz = rz / ql, qw = rw / ql;
      const r00 = 1 - 2 * (qy * qy + qz * qz);
      const r01 = 2 * (qx * qy - qz * qw);
      const r02 = 2 * (qx * qz + qy * qw);
      const r10 = 2 * (qx * qy + qz * qw);
      const r11 = 1 - 2 * (qx * qx + qz * qz);
      const r12 = 2 * (qy * qz - qx * qw);
      const r20 = 2 * (qx * qz - qy * qw);
      const r21 = 2 * (qy * qz + qx * qw);
      const r22 = 1 - 2 * (qx * qx + qy * qy);

      const slot = isSphere ? (boxCount + sphereCount) : boxCount;
      if (!isSphere) boxCount++;
      else sphereCount++;
      const off = slot * 20;
      staging[off]      = r00 * scale;
      staging[off + 1]  = r10 * scale;
      staging[off + 2]  = r20 * scale;
      staging[off + 3]  = 0;
      staging[off + 4]  = r01 * scale;
      staging[off + 5]  = r11 * scale;
      staging[off + 6]  = r21 * scale;
      staging[off + 7]  = 0;
      staging[off + 8]  = r02 * scale;
      staging[off + 9]  = r12 * scale;
      staging[off + 10] = r22 * scale;
      staging[off + 11] = 0;
      staging[off + 12] = px;
      staging[off + 13] = py;
      staging[off + 14] = pz;
      staging[off + 15] = 1;
      staging[off + 16] = cr;
      staging[off + 17] = cg;
      staging[off + 18] = cb;
      staging[off + 19] = 1;
    }

    // Player capsule instance (packed after the spheres).
    let capsuleFirst = 0;
    let capsuleVertCount = 0;
    if (this.playerHitbox && this.hitboxCapsuleVB) {
      const ph = this.playerHitbox;
      const cylHalfHeight = Math.max(0, (ph.height - 2 * ph.radius) / 2);
      // Regenerate capsule geometry when dimensions change.
      const key = `${ph.radius}|${cylHalfHeight}`;
      if (key !== this.capsuleCacheKey) {
        const geo = generateCapsuleWireframe(ph.radius, cylHalfHeight);
        // Recreate the vertex buffer at the new size.
        this.hitboxCapsuleVB.destroy();
        this.hitboxCapsuleVB = device.createBuffer({
          label: "hitbox-capsule-vb",
          size: geo.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this.hitboxCapsuleVB, 0, geo);
        this.hitboxCapsuleVertexCount = geo.length / 3;
        this.capsuleCacheKey = key;
      }
      capsuleVertCount = this.hitboxCapsuleVertexCount;
      capsuleFirst = boxCount + sphereCount;
      const off = capsuleFirst * 20;
      // Capsule is centered at origin (cylinder at y=0); translate to feet + height/2.
      const cy = ph.y + ph.height / 2;
      // Identity rotation + uniform scale 1 (geometry already at dimensions).
      staging[off]      = 1; staging[off + 1] = 0; staging[off + 2]  = 0; staging[off + 3]  = 0;
      staging[off + 4]  = 0; staging[off + 5] = 1; staging[off + 6]  = 0; staging[off + 7]  = 0;
      staging[off + 8]  = 0; staging[off + 9] = 0; staging[off + 10] = 1; staging[off + 11] = 0;
      staging[off + 12] = ph.x;
      staging[off + 13] = cy;
      staging[off + 14] = ph.z;
      staging[off + 15] = 1;
      // Player — bright red.
      staging[off + 16] = 1.0;
      staging[off + 17] = 0.15;
      staging[off + 18] = 0.1;
      staging[off + 19] = 1;
    }

    const totalInstances = boxCount + sphereCount + (capsuleVertCount > 0 ? 1 : 0);

    pass.setPipeline(this.hitboxPipeline);
    pass.setBindGroup(0, this.hitboxBindGroup);

    // Collect hull wireframe instances into staging (after box/sphere/capsule
    // slots). Each hull has a unique vertex buffer (per contentId), so we
    // can't GPU-instance across different hulls — but we CAN write all
    // instance matrices into one buffer and draw each hull with the correct
    // instance_index offset. This avoids the bug where multiple per-draw
    // writeBuffer calls in the same pass all overwrite slot 0.
    //
    // The SAB SHAPE field is the single source of truth: the sim writes 2
    // when it successfully created a convex hull collider, 0/1 otherwise.
    // We only draw a hull wireframe when the sim says shape=2. We never
    // guess based on model availability — that was the source of the
    // debug/physics divergence.
    const nodeToContent = this.nodeToContent;
    const hullDraws: { vb: GPUBuffer; vertCount: number; instanceIdx: number }[] = [];
    let hullInstanceIdx = totalInstances;
    for (let i = 0; i < count; i++) {
      const sv = reader.getEntitySlotDirect(i);
      const u32 = sv.u32;
      const f32 = sv.f32;
      const type = u32[ENT.TYPE];
      if (type !== EntityType.Prop) continue;
      // Only draw hull wireframe when the sim says this entity has a hull.
      const shape = f32[ENT_DATA.SHAPE + ENT.DATA];
      if (shape !== 2) continue;
      const nodeIdRaw = u32[ENT.ID];
      if (nodeIdRaw === 0) continue;
      const contentId = nodeToContent.get(`prop-${nodeIdRaw}`);
      if (!contentId) continue;
      const hw = this.getHullWireframe(contentId);
      if (!hw) continue;
      const ioff = i * 8;
      const px = interp[ioff];
      const py = interp[ioff + 1];
      const pz = interp[ioff + 2];
      const scale = interp[ioff + 7] || 1.0;
      const rx = interp[ioff + 3];
      const ry = interp[ioff + 4];
      const rz = interp[ioff + 5];
      const rw = interp[ioff + 6];
      const ql = Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw) || 1;
      const qx = rx / ql, qy = ry / ql, qz = rz / ql, qw = rw / ql;
      const r00 = 1 - 2 * (qy * qy + qz * qz);
      const r01 = 2 * (qx * qy - qz * qw);
      const r02 = 2 * (qx * qz + qy * qw);
      const r10 = 2 * (qx * qy + qz * qw);
      const r11 = 1 - 2 * (qx * qx + qz * qz);
      const r12 = 2 * (qy * qz - qx * qw);
      const r20 = 2 * (qx * qz - qy * qw);
      const r21 = 2 * (qy * qz + qx * qw);
      const r22 = 1 - 2 * (qx * qx + qy * qy);
      const off = hullInstanceIdx * 20;
      staging[off]      = r00 * scale;
      staging[off + 1]  = r10 * scale;
      staging[off + 2]  = r20 * scale;
      staging[off + 3]  = 0;
      staging[off + 4]  = r01 * scale;
      staging[off + 5]  = r11 * scale;
      staging[off + 6]  = r21 * scale;
      staging[off + 7]  = 0;
      staging[off + 8]  = r02 * scale;
      staging[off + 9]  = r12 * scale;
      staging[off + 10] = r22 * scale;
      staging[off + 11] = 0;
      staging[off + 12] = px;
      staging[off + 13] = py;
      staging[off + 14] = pz;
      staging[off + 15] = 1;
      staging[off + 16] = 1.0; // magenta
      staging[off + 17] = 0.1;
      staging[off + 18] = 0.9;
      staging[off + 19] = 1;
      hullDraws.push({ vb: hw.vb, vertCount: hw.vertCount, instanceIdx: hullInstanceIdx });
      hullInstanceIdx++;
    }

    // Upload ALL instances (boxes + spheres + capsule + hulls) in one write.
    const grandTotal = hullInstanceIdx;
    if (grandTotal === 0) return;
    const upload = new Float32Array(grandTotal * 20);
    upload.set(staging.subarray(0, grandTotal * 20));
    device.queue.writeBuffer(this.hitboxInstanceBuffer, 0, upload);

    // Boxes (instances [0, boxCount))
    if (boxCount > 0 && this.hitboxBoxVB) {
      pass.setVertexBuffer(0, this.hitboxBoxVB);
      pass.draw(WIRE_BOX_VERTEX_COUNT, boxCount, 0, 0);
    }
    // Spheres (instances [boxCount, boxCount + sphereCount))
    if (sphereCount > 0 && this.hitboxSphereVB) {
      pass.setVertexBuffer(0, this.hitboxSphereVB);
      pass.draw(WIRE_SPHERE_VERTEX_COUNT, sphereCount, 0, boxCount);
    }
    // Player capsule (instance at capsuleFirst)
    if (capsuleVertCount > 0 && this.hitboxCapsuleVB) {
      pass.setVertexBuffer(0, this.hitboxCapsuleVB);
      pass.draw(capsuleVertCount, 1, 0, capsuleFirst);
    }
    // Hull wireframes (each at its own instance slot, one draw per hull).
    for (const hd of hullDraws) {
      pass.setVertexBuffer(0, hd.vb);
      pass.draw(hd.vertCount, 1, 0, hd.instanceIdx);
    }
  }

  // ── Post-process outline: mask + composite ──────────────────────────────
  // Renders the hovered entity to a mask texture (solid white), then runs a
  // fullscreen edge-detection pass that composites the outline over the scene
  // color.  Works on ALL models regardless of winding order or geometry.

  /** Ensure the mask + composite temp textures exist at the given size. */
  private ensureOutlineTargets(w: number, h: number): void {
    const device = this.getDevice()!;
    if (this.maskTexture && this.maskTexture.width === w && this.maskTexture.height === h) return;
    this.maskTexture?.destroy();
    this.compositeTempTexture?.destroy();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    this.maskTexture = device.createTexture({
      label: "outline-mask",
      size: [w, h],
      format: "rgba8unorm",
      usage,
    });
    this.maskTextureView = this.maskTexture.createView();
    this.compositeTempTexture = device.createTexture({
      label: "outline-composite-temp",
      size: [w, h],
      format: "rgba16float",
      usage,
    });
    this.compositeTempView = this.compositeTempTexture.createView();
  }

  /** Render the hovered entity to the mask texture as solid white. */
  private renderHoverMask(pass: GPURenderPassEncoder, viewProj: Float32Array): void {
    if (!this.maskPipeline || !this.maskUniformBuffer || !this.maskBindGroup) return;
    const device = this.getDevice()!;
    const ud = this.maskStaging;
    ud.set(viewProj, 0);
    ud.set(this.hoverModelMatrix, 16);
    device.queue.writeBuffer(this.maskUniformBuffer, 0, ud);
    pass.setPipeline(this.maskPipeline);
    pass.setBindGroup(0, this.maskBindGroup);
    if (this.hoverOutlineIsSphere && this.sphereVertexBuffer && this.sphereIndexBuffer) {
      pass.setVertexBuffer(0, this.sphereVertexBuffer);
      pass.setIndexBuffer(this.sphereIndexBuffer, "uint16");
      pass.drawIndexed(this.sphereIndexCount);
    } else if (this.cubeVertexBuffer && this.cubeIndexBuffer) {
      pass.setVertexBuffer(0, this.cubeVertexBuffer);
      pass.setIndexBuffer(this.cubeIndexBuffer, "uint16");
      pass.drawIndexed(this.cubeIndexCount);
    }
  }

  /** Full post-process outline: mask → composite → copy back to scene color. */
  private renderOutlinePostProcess(
    encoder: GPUCommandEncoder,
    w: number, h: number,
    viewProj: Float32Array,
    _cameraState: object,
  ): void {
    if (!this.maskPipeline || !this.compositePipeline || !this.compositeSampler) return;
    if (!this.maskUniformBuffer || !this.compositeUniformBuffer) return;
    if (!this.postProcessStack) return;
    const device = this.getDevice()!;

    this.ensureOutlineTargets(w, h);
    const maskView = this.maskTextureView;
    const tempView = this.compositeTempView;
    const tempTex = this.compositeTempTexture;
    if (!maskView || !tempView || !tempTex) return;

    // Get the scene color + depth views from the PostProcessStack.
    const sceneColorView = this.postProcessStack.getSceneColorView();
    const sceneDepthView = this.postProcessStack.getSceneDepthView();

    // ── Pass 1: Mask — clear to black, render hovered entity as solid white.
    //    Depth: load the scene depth (read-only) so the mask respects
    //    occlusion by other objects.
    {
      const pass = encoder.beginRenderPass({
        label: "outline-mask",
        colorAttachments: [{
          view: maskView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        }],
        depthStencilAttachment: {
          view: sceneDepthView,
          depthReadOnly: true,
        },
      });
      // Render builtin prop to mask
      if (this.hoverOutlineSlot >= 0) {
        this.renderHoverMask(pass, viewProj);
      }
      // Render model prop to mask
      if (this.modelRenderer && this.hoverModelNodeId) {
        this.modelRenderer.renderMask(
          pass, this.hoverModelNodeId,
          this.hoverModelPos, this.hoverModelRot, this.hoverModelScale,
        );
      }
      pass.end();
    }

    // ── Pass 2: Composite — fullscreen edge detection.
    //    Reads scene color + mask, writes outline to temp texture.
    {
      // Write composite uniforms: texelSize + outlineWidth + outlineColor.
      const ud = new Float32Array(8);
      ud[0] = 1.0 / w;  // texelSize.x
      ud[1] = 1.0 / h;  // texelSize.y
      ud[2] = 3.0;      // outlineWidth (texels)
      ud[3] = 0.0;      // pad
      // #5EE6A8 in linear space (sRGB → linear conversion).
      // The scene color is HDR rgba16float; the postfx chain applies
      // tonemapping + sRGB encoding before display.
      ud[4] = 0.113;    // outlineColor.r
      ud[5] = 0.803;    // outlineColor.g
      ud[6] = 0.398;    // outlineColor.b
      ud[7] = 0.0;      // pad
      device.queue.writeBuffer(this.compositeUniformBuffer, 0, ud);

      const bindGroup = device.createBindGroup({
        layout: this.compositePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: sceneColorView },
          { binding: 1, resource: maskView },
          { binding: 2, resource: { buffer: this.compositeUniformBuffer } },
        ],
      });

      const pass = encoder.beginRenderPass({
        label: "outline-composite",
        colorAttachments: [{
          view: tempView,
          loadOp: "clear",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          storeOp: "store",
        }],
      });
      pass.setPipeline(this.compositePipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3); // fullscreen triangle
      pass.end();
    }

    // ── Copy the composited result back to the scene color texture.
    encoder.copyTextureToTexture(
      { texture: tempTex },
      { texture: this.postProcessStack.getSceneColorTexture() },
      [w, h, 1],
    );
  }

  // ── Collect visible builtin entities once per frame ──
  // Iterates all entities a single time, splits into cubes/spheres arrays,
  // and computes model matrices into the staging buffer. Both the shadow
  // depth pass and the scene color pass read from the same precomputed data,
  // eliminating duplicate iteration + matrix composition.

  /**
   * Apply the sim-driven squish deformation as a per-axis scale. Positive
   * amount = compress along the impact axis (expand the other two for
   * approximate volume preservation). Negative amount = stretch along the
   * axis (the spring overshoot / jelly wobble on recovery).
   */
  private applySquishScale(
    scale: number,
    amount: number,
    axis: number,
  ): [number, number, number] {
    if (Math.abs(amount) < 0.001 || axis < 0) return [scale, scale, scale];
    const compress = 1 - amount;
    const expand = 1 + amount * 0.5;
    if (axis === 0) return [scale * compress, scale * expand, scale * expand];
    if (axis === 1) return [scale * expand, scale * compress, scale * expand];
    return [scale * expand, scale * expand, scale * compress];
  }

  /**
   * World-space position offset so the squish deforms FROM the point of impact
   * instead of toward the prop's center. The impact face stays anchored at the
   * contact point while the opposite (far) face compresses toward it — the
   * prop's center shifts toward the impact side by half the compression.
   *
   * `axisCode` is the signed SAB code (±1/±2/±3): the sign is the impact-side
   * direction in the prop's local frame. The center shifts toward the impact
   * side, so the local offset along the axis is `+sign * 0.5 * scale * amount`,
   * rotated into world space by the prop's quaternion. Returns [0,0,0] when
   * there's no squish.
   */
  private squishOffset(
    scale: number,
    amount: number,
    axisCode: number,
    rx: number, ry: number, rz: number, rw: number,
  ): [number, number, number] {
    if (Math.abs(amount) < 0.001 || axisCode === 0) return [0, 0, 0];
    const axis = Math.abs(axisCode) - 1;
    const impactSign = axisCode < 0 ? -1 : 1;
    // Shift the center toward the impact side so the impact face stays put.
    const mag = impactSign * 0.5 * scale * amount;
    let lox = 0, loy = 0, loz = 0;
    if (axis === 0) lox = mag;
    else if (axis === 1) loy = mag;
    else loz = mag;
    // Rotate the local offset into world space (quaternion → matrix form).
    const ql = Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw) || 1;
    const qx = rx / ql, qy = ry / ql, qz = rz / ql, qw = rw / ql;
    const r00 = 1 - 2 * (qy * qy + qz * qz);
    const r01 = 2 * (qx * qy - qz * qw);
    const r02 = 2 * (qx * qz + qy * qw);
    const r10 = 2 * (qx * qy + qz * qw);
    const r11 = 1 - 2 * (qx * qx + qz * qz);
    const r12 = 2 * (qy * qz - qx * qw);
    const r20 = 2 * (qx * qz - qy * qw);
    const r21 = 2 * (qy * qz + qx * qw);
    const r22 = 1 - 2 * (qx * qx + qy * qy);
    return [
      r00 * lox + r01 * loy + r02 * loz,
      r10 * lox + r11 * loy + r12 * loz,
      r20 * lox + r21 * loy + r22 * loz,
    ];
  }

  private collectRenderEntities(): void {
    if (!this.simReader || !this.interpOut) return;
    const reader = this.simReader;
    const interp = this.interpOut;
    const staging = this.instanceStaging;
    const colors = this.renderColors;
    const paintFlags = this.renderPaintFlags;

    this.renderCubes.length = 0;
    this.renderSpheres.length = 0;
    // Reset hover tracking — set fresh if the hovered entity is found below.
    this.hoverOutlineSlot = -1;
    this.hoverModelNodeId = null;

    const count = reader.getEntityCount();
    for (let i = 0; i < count; i++) {
      // Direct slot access — avoids getEntitySlot object allocation.
      const sv = reader.getEntitySlotDirect(i);
      const u32 = sv.u32;
      const f32 = sv.f32;
      const type = u32[ENT.TYPE];
      if (type === 255) continue;
      if (type !== EntityType.Prop && type !== EntityType.Mannequin && type !== EntityType.Projectile) continue;
      const nodeIdRaw = u32[ENT.ID];
      if (nodeIdRaw !== 0) continue; // has a model — skip (rendered by modelRenderer)

      const shape = f32[ENT_DATA.SHAPE + ENT.DATA];
      if (shape === 1) this.renderSpheres.push(i);
      else this.renderCubes.push(i);

      // Read interpolated transform (always from interp — no ternary needed).
      const ioff = i * 8;
      const px = interp[ioff];
      const py = interp[ioff + 1];
      const pz = interp[ioff + 2];
      const scale = interp[ioff + 7] || 1.0;
      const rx = interp[ioff + 3];
      const ry = interp[ioff + 4];
      const rz = interp[ioff + 5];
      const rw = interp[ioff + 6];
      // Squish deformation lives in the SAB DATA area (not interpolated — it's a
      // scalar that eases in the sim, so linear interp would be fine but isn't
      // worth the extra interp slots). Read directly from the entity slot.
      // SQUISH_AXIS is a signed code (±1/±2/±3): axis = |code| - 1, sign = impact side.
      const squishAmount = f32[ENT_DATA.SQUISH_AMOUNT + ENT.DATA] || 0;
      const squishCode = f32[ENT_DATA.SQUISH_AXIS + ENT.DATA] | 0;
      const squishAxis = Math.abs(squishCode) - 1;
      const [sx, sy, sz] = this.applySquishScale(scale, squishAmount, squishAxis);
      // Anchor the squish at the impact point: shift the center toward the
      // impact side so the impact face stays put and the far face compresses in.
      const [ox, oy, oz] = this.squishOffset(scale, squishAmount, squishCode, rx, ry, rz, rw);
      const tpx = px + ox;
      const tpy = py + oy;
      const tpz = pz + oz;

      // Determine the instance slot offset. Cubes are packed first, then
      // spheres, matching the baseOffset convention in renderShapeBatch.
      const isCube = shape !== 1;
      const slotIdx = isCube ? this.renderCubes.length - 1 : this.renderCubes.length + this.renderSpheres.length - 1;
      const off = slotIdx * 24;

      // Compose model matrix inline (avoids method call overhead per entity).
      const ql = Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw) || 1;
      const qx = rx / ql, qy = ry / ql, qz = rz / ql, qw = rw / ql;
      const r00 = 1 - 2 * (qy * qy + qz * qz);
      const r01 = 2 * (qx * qy - qz * qw);
      const r02 = 2 * (qx * qz + qy * qw);
      const r10 = 2 * (qx * qy + qz * qw);
      const r11 = 1 - 2 * (qx * qx + qz * qz);
      const r12 = 2 * (qy * qz - qx * qw);
      const r20 = 2 * (qx * qz - qy * qw);
      const r21 = 2 * (qy * qz + qx * qw);
      const r22 = 1 - 2 * (qx * qx + qy * qy);
      staging[off]      = r00 * sx;
      staging[off + 1]  = r10 * sx;
      staging[off + 2]  = r20 * sx;
      staging[off + 3]  = 0;
      staging[off + 4]  = r01 * sy;
      staging[off + 5]  = r11 * sy;
      staging[off + 6]  = r21 * sy;
      staging[off + 7]  = 0;
      staging[off + 8]  = r02 * sz;
      staging[off + 9]  = r12 * sz;
      staging[off + 10] = r22 * sz;
      staging[off + 11] = 0;
      staging[off + 12] = tpx;
      staging[off + 13] = tpy;
      staging[off + 14] = tpz;
      staging[off + 15] = 1;

      // Color: use precomputed hue colors, override for special types.
      if (type === EntityType.Projectile) {
        staging[off + 16] = 0.95; staging[off + 17] = 0.3; staging[off + 18] = 0.15;
      } else if (type === EntityType.Mannequin) {
        staging[off + 16] = 0.7; staging[off + 17] = 0.65; staging[off + 18] = 0.55;
      } else {
        const coff = i * 3;
        staging[off + 16] = colors[coff];
        staging[off + 17] = colors[coff + 1];
        staging[off + 18] = colors[coff + 2];
      }
      staging[off + 19] = 1.0;

      // Paint flag — check paintTextures once, store for scene pass.
      const entityId = i + 1;
      const hasPaint = this.paintTextures.has(entityId) ? 1 : 0;
      paintFlags[i] = hasPaint;
      staging[off + 20] = hasPaint;
      // Ghost-mode flag (Instance._pad2 slot, u32). Set when this builtin prop
      // is the physgun's ghost-grabbed entity so the cube/sphere shader renders
      // it as a cyan hologram. Hover outline is handled by a separate
      // inverted-hull pipeline — see renderHoverOutline below.
      staging[off + 23] = (entityId === this.ghostGrabEntity) ? 1 : 0;
      // Track the hover entity's model matrix + shape for the outline pass.
      if (entityId === this.hoverEntity) {
        this.hoverOutlineSlot = i;
        this.hoverOutlineIsSphere = shape === 1;
        // Copy the 16-float model matrix from staging into the hover buffer.
        this.hoverModelMatrix.set(staging.subarray(off, off + 16));
      }
    }
  }

  // ── Render builtin props (cubes + spheres) with paint texture + lighting ──
  private renderBuiltinProps(pass: GPURenderPassEncoder, viewProj: Float32Array): void {
    if (!this.simReader || !this.cubePipeline || !this.cubeVertexBuffer || !this.cubeIndexBuffer) return;
    if (!this.cubeUniformBuffer || !this.cubeInstanceBuffer || !this.cubeSampler) return;
    const device = this.getDevice()!;
    const count = this.simReader.getEntityCount();
    if (count === 0) return;

    // Write shared uniforms (viewProj + cameraPos + time) — shared by both
    // pipelines. time drives the ghost-mode hologram pulse/scanline.
    const uniformData = new Float32Array(20);
    uniformData.set(viewProj, 0);
    uniformData[16] = this.camPos[0];
    uniformData[17] = this.camPos[1];
    uniformData[18] = this.camPos[2];
    uniformData[19] = performance.now() / 1000;
    device.queue.writeBuffer(this.cubeUniformBuffer, 0, uniformData);

    // Use precomputed entity lists from collectRenderEntities().
    const cubes = this.renderCubes;
    const spheres = this.renderSpheres;

    // Render cubes
    if (cubes.length > 0) {
      this.renderShapeBatch(pass, device, cubes, this.cubePipeline!, this.cubeVertexBuffer!, this.cubeIndexBuffer!, this.cubeIndexCount, this.cubeLightingBg, this.cubeShadowBg, 0);
    }
    // Render spheres — offset instance data past the cube batch so they don't
    // overwrite each other in the shared instance buffer (writeBuffer is a
    // queue op that all executes before the command buffer submit).
    if (spheres.length > 0 && this.spherePipeline && this.sphereVertexBuffer && this.sphereIndexBuffer) {
      this.renderShapeBatch(pass, device, spheres, this.spherePipeline, this.sphereVertexBuffer, this.sphereIndexBuffer, this.sphereIndexCount, this.sphereLightingBg, this.sphereShadowBg, cubes.length);
    }
  }

  private renderShapeBatch(
    pass: GPURenderPassEncoder,
    device: GPUDevice,
    indices: number[],
    pipeline: GPURenderPipeline,
    vertexBuffer: GPUBuffer,
    indexBuffer: GPUBuffer,
    indexCount: number,
    lightingBg: GPUBindGroup | null,
    shadowBg: GPUBindGroup | null,
    baseOffset: number = 0,
  ): void {
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.setIndexBuffer(indexBuffer, "uint16");
    if (lightingBg) pass.setBindGroup(2, lightingBg);
    if (shadowBg) pass.setBindGroup(3, shadowBg);

    const stride = this.cubeInstanceStride;
    const maxInstances = Math.floor(this.cubeInstanceBuffer!.size / stride);
    const isCube = pipeline === this.cubePipeline;
    const defaultBg1 = isCube ? this.cubeDefaultBindGroup1 : this.sphereDefaultBindGroup1;
    const bg0 = isCube ? this.cubeBindGroup0 : this.sphereBindGroup0;
    const bg1Layout = pipeline.getBindGroupLayout(1);
    const staging = this.instanceStaging;
    const paintFlags = this.renderPaintFlags;

    const drawCount = Math.min(indices.length, maxInstances - baseOffset);
    if (drawCount <= 0) return;

    // Model matrices + colors are already in the staging buffer from
    // collectRenderEntities(). We only need to repack painted/unpainted
    // for the scene pass (shadow pass doesn't need paint sorting).
    // Unpainted packed at [0, unpaintedCount); painted packed from the end.
    //
    // Snapshot the batch into repackTemp first, then repack from temp back
    // into staging.  copyWithin on staging in a single pass can overwrite
    // data for entities that haven't been processed yet — e.g. a painted
    // entity at idx=2 moved to the last slot overwrites the entity already
    // living there; when that entity is later processed it reads the
    // painted entity's hasPaint=1, and since it's drawn with the default
    // 1×1 opaque-white texture the shader produces mix(baseColor, white, 1)
    // = white, making the whole prop appear white.
    const temp = this.repackTemp;
    for (let idx = 0; idx < drawCount; idx++) {
      const srcOff = (baseOffset + idx) * 24;
      const tmpOff = idx * 24;
      // Copy 24 floats (full instance stride incl. padding).
      temp.set(staging.subarray(srcOff, srcOff + 24), tmpOff);
    }

    let unpaintedCount = 0;
    const painted: Array<{ slotIdx: number; entityId: number }> = [];

    for (let idx = 0; idx < drawCount; idx++) {
      const i = indices[idx];
      const entityId = i + 1;
      const hasPaint = paintFlags[i];

      // Source offset in temp = idx * 24 (temp is 0-indexed per batch).
      // Dest offset in staging = repacked position in the batch.
      const slotIdx = hasPaint ? (drawCount - 1 - painted.length) : unpaintedCount;
      const srcOff = idx * 24;
      const dstOff = (baseOffset + slotIdx) * 24;

      // Copy 21 floats (model matrix + color + paint flag) from temp to staging.
      staging.set(temp.subarray(srcOff, srcOff + 21), dstOff);

      if (hasPaint) {
        painted.push({ slotIdx: baseOffset + slotIdx, entityId });
      } else {
        unpaintedCount++;
      }
    }

    // Single writeBuffer for the entire batch.
    device.queue.writeBuffer(
      this.cubeInstanceBuffer!,
      baseOffset * stride,
      staging.buffer,
      baseOffset * 24 * 4,
      drawCount * stride,
    );

    // Bind group 0: single shared bind group for all instances (uniform + storage).
    pass.setBindGroup(0, bg0!);

    // Draw unpainted batch in one instanced call.
    if (unpaintedCount > 0) {
      if (defaultBg1) pass.setBindGroup(1, defaultBg1);
      pass.drawIndexed(indexCount, unpaintedCount, 0, 0, baseOffset);
    }

    // Draw painted instances individually (each needs its own paint texture BG).
    for (const { slotIdx, entityId } of painted) {
      let bg1 = this.paintBindGroupCache.get(entityId);
      if (!bg1) {
        const tex = this.paintTextures.get(entityId);
        if (!tex) continue;
        bg1 = device.createBindGroup({
          layout: bg1Layout,
          entries: [
            { binding: 0, resource: tex.createView() },
            { binding: 1, resource: this.cubeSampler! },
          ],
        });
        this.paintBindGroupCache.set(entityId, bg1);
      }
      pass.setBindGroup(1, bg1);
      pass.drawIndexed(indexCount, 1, 0, 0, slotIdx);
    }
  }

  // ── Compose a 4×4 model matrix from TRS into a staging array (zero-alloc) ──
  private composeModelMatrixInto(
    target: Float32Array,
    offset: number,
    tx: number, ty: number, tz: number,
    rx: number, ry: number, rz: number, rw: number,
    scale: number,
  ): void {
    const ql = Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw) || 1;
    const qx = rx / ql, qy = ry / ql, qz = rz / ql, qw = rw / ql;
    const r00 = 1 - 2 * (qy * qy + qz * qz);
    const r01 = 2 * (qx * qy - qz * qw);
    const r02 = 2 * (qx * qz + qy * qw);
    const r10 = 2 * (qx * qy + qz * qw);
    const r11 = 1 - 2 * (qx * qx + qz * qz);
    const r12 = 2 * (qy * qz - qx * qw);
    const r20 = 2 * (qx * qz - qy * qw);
    const r21 = 2 * (qy * qz + qx * qw);
    const r22 = 1 - 2 * (qx * qx + qy * qy);
    // Column-major mat4x4 (matches wgpu-matrix layout)
    target[offset    ] = r00 * scale;
    target[offset + 1] = r10 * scale;
    target[offset + 2] = r20 * scale;
    target[offset + 3] = 0;
    target[offset + 4] = r01 * scale;
    target[offset + 5] = r11 * scale;
    target[offset + 6] = r21 * scale;
    target[offset + 7] = 0;
    target[offset + 8] = r02 * scale;
    target[offset + 9] = r12 * scale;
    target[offset + 10] = r22 * scale;
    target[offset + 11] = 0;
    target[offset + 12] = tx;
    target[offset + 13] = ty;
    target[offset + 14] = tz;
    target[offset + 15] = 1;
  }

  private getOrCreateDepthTexture(w: number, h: number): GPUTexture {
    if (this.depthTexture && this.depthTextureW === w && this.depthTextureH === h) {
      return this.depthTexture;
    }
    this.depthTexture?.destroy();
    this.depthTexture = this.getDevice()!.createTexture({
      label: "depth",
      size: [w, h],
      format: DEPTH_FORMAT as GPUTextureFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      sampleCount: MSAA_SAMPLE_COUNT,
    });
    this.depthTextureW = w;
    this.depthTextureH = h;
    return this.depthTexture;
  }

  stop(): void {
    this.sandboxRunning = false;
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
  }

  getElapsedTime(): number { return this._elapsedTime; }
}
