import { type Mat4 } from "wgpu-matrix";
import type { RenderBackend } from "../backend/render-backend.ts";
import type { BackendBindGroup, BackendBindGroupLayout, BackendBuffer, BackendRenderPipeline, BackendSampler, BackendShaderModule, BackendTexture, TextureFormat } from "../backend/types.ts";
import type { FrameGraphBuilder, GraphRenderContext, TextureHandle } from "../frame-graph.ts";
import { RenderPass } from "../render-pass.ts";

const WATER_GRID = 256;
const MAX_WAKES = 16;
const MAX_SHORES = 128;
const WAKE_FLOATS = 6;
const SHORE_FLOATS = 4;

const WATER_SHADER = /* wgsl */ `
const MAX_POINT_LIGHTS = 32u;
const MAX_SPOT_LIGHTS = 8u;

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

fn windChopAmp() -> f32 {
  let ss = clamp((uniforms.windSpeed - 2.0) / 23.0, 0.0, 1.0);
  return 0.15 + ss * 0.65;
}

fn wakeDisplacement(worldX: f32, worldZ: f32) -> vec2<f32> {
  var totalH = 0.0;
  var foam = 0.0;
  let n = uniforms.wakeCount;
  for (var i = 0u; i < n; i = i + 1u) {
    let src = wakeSources[i];
    let dx = worldX - src.pos.x;
    let dz = worldZ - src.pos.y;
    let dist = length(vec2<f32>(dx, dz));

    let distFadeFar = 1.0 - smoothstep(50.0, 60.0, dist);
    if (distFadeFar < 0.001) { continue; }

    let dir = src.dir;
    let fwd = dx * dir.x + dz * dir.y;
    let lat = -dx * dir.y + dz * dir.x;

    let fwdFade = 1.0 - smoothstep(2.0, 8.0, fwd);
    if (fwdFade < 0.001) { continue; }

    let wakeSpread = 0.36;
    let wakeEdge = abs(fwd) * wakeSpread;
    let lateralFade = 1.0 - smoothstep(wakeEdge * 0.7, wakeEdge, abs(lat));
    if (lateralFade < 0.01) { continue; }

    let behind = -fwd;
    let distFade = exp(-behind * 0.04);
    let speedFactor = clamp(src.speed / 10.0, 0.0, 1.5);

    let fade = distFadeFar * fwdFade;

    let k = 0.5;
    let ridge1 = sin(behind * k - uniforms.time * 3.0) * 0.15;
    let ridge2 = sin(behind * k * 1.5 - uniforms.time * 4.0) * 0.08;
    let wakeH = (ridge1 + ridge2) * distFade * lateralFade * speedFactor * fade;
    totalH += wakeH;

    let foamWidth = wakeEdge * 0.5;
    let foamLat = 1.0 - smoothstep(foamWidth * 0.3, foamWidth, abs(lat));
    foam += distFade * foamLat * speedFactor * 0.6 * fade;
  }
  return vec2<f32>(totalH, foam);
}

fn shoreDisplacement(worldX: f32, worldZ: f32) -> vec2<f32> {
  var totalH = 0.0;
  var foam = 0.0;
  let n = uniforms.shoreCount;
  for (var i = 0u; i < n; i = i + 1u) {
    let src = shoreSources[i];
    let r = src.radius;
    if (r < 0.001) { continue; }
    let dx = worldX - src.pos.x;
    let dz = worldZ - src.pos.y;
    let dist = length(vec2<f32>(dx, dz));

    let flatR = r * 1.0;
    let dampR = r * 1.2 + 8.0;
    let rampUp = smoothstep(flatR, dampR, dist);
    if (rampUp < 0.001) { continue; }

    let bandEnd = dampR + 20.0;
    let fadeW = 8.0;
    let outerFade = 1.0 - smoothstep(bandEnd - fadeW, bandEnd, dist);
    if (outerFade < 0.001) { continue; }

    let ringDist = dist - r;
    let k = 0.2;
    let shoal = 1.0 - rampUp * 0.6;
    let waveAmp = 0.5 * shoal;
    let ringH = sin(ringDist * k + uniforms.time * 0.35) * waveAmp;
    let distFade = exp(-max(ringDist - (dampR - r), 0.0) * 0.08);
    totalH += ringH * distFade * outerFade;
  }
  return vec2<f32>(totalH, foam);
}

fn shoreDamping(worldX: f32, worldZ: f32) -> f32 {
  var damping = 1.0;
  let n = uniforms.shoreCount;
  for (var i = 0u; i < n; i = i + 1u) {
    let src = shoreSources[i];
    let r = src.radius;
    if (r < 0.001) { continue; }
    let dx = worldX - src.pos.x;
    let dz = worldZ - src.pos.y;
    let dist = length(vec2<f32>(dx, dz));
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

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldX = uniforms.originX + input.position.x * uniforms.patchSize;
  let worldZ = uniforms.originZ + input.position.y * uniforms.patchSize;
  let gs = i32(uniforms.gridSize);
  let ogx = i32(uniforms.originX / uniforms.patchSize);
  let ogz = i32(uniforms.originZ / uniforms.patchSize);
  var gx = (ogx + i32(input.position.x)) % gs;
  gx = (gx % gs + gs) % gs;
  var gz = (ogz + i32(input.position.y)) % gs;
  gz = (gz % gs + gs) % gs;
  let h = textureLoad(heightTex, vec2<i32>(gx, gz), 0).r;
  let t = uniforms.time;
  let chopAmp = windChopAmp();
  let chop = waveHeight(worldX, worldZ, t, chopAmp);

  let wake = wakeDisplacement(worldX, worldZ);
  let shore = shoreDisplacement(worldX, worldZ);

  let damping = shoreDamping(worldX, worldZ);
  let visualH = (h + chop + wake.x) * damping + shore.x;
  let worldPos = vec3<f32>(worldX, visualH, worldZ);
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  output.worldPos = worldPos;
  output.uv = input.position;
  output.viewDir = uniforms.cameraPos - worldPos;
  output.waveHeight = visualH;
  output.foam = wake.y + shore.y;
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
  if (waterCutout(input.worldPos.x, input.worldPos.z)) {
    discard;
  }
  let viewDir = normalize(input.viewDir);
  let dist = length(input.viewDir);

  let dpdx = dpdx(input.worldPos);
  let dpdy = dpdy(input.worldPos);
  var faceNormal = normalize(cross(dpdx, dpdy));
  if (faceNormal.y < 0.0) {
    faceNormal = -faceNormal;
  }

  var qn = faceNormal;
  qn.x = round(qn.x / 0.3) * 0.3;
  qn.y = round(qn.y / 0.3) * 0.3;
  qn.z = round(qn.z / 0.3) * 0.3;
  qn = normalize(qn);

  let sunDir = normalize(vec3<f32>(uniforms.sunDirX, uniforms.sunDirY, uniforms.sunDirZ));
  let sunIntensity = uniforms.sunIntensity;
  let diff = max(dot(faceNormal, sunDir), 0.0);
  let diffScaled = mix(0.15, diff, sunIntensity);

  let color1 = vec3<f32>(0.01, 0.03, 0.06);
  let color2 = vec3<f32>(0.02, 0.08, 0.14);
  let color3 = vec3<f32>(0.04, 0.16, 0.24);
  let color4 = vec3<f32>(0.08, 0.28, 0.36);
  let color5 = vec3<f32>(0.15, 0.42, 0.48);

  var waterColor = color1;
  waterColor = mix(waterColor, color2, smoothstep(0.0, 0.15, diffScaled));
  waterColor = mix(waterColor, color3, smoothstep(0.15, 0.35, diffScaled));
  waterColor = mix(waterColor, color4, smoothstep(0.35, 0.6, diffScaled));
  waterColor = mix(waterColor, color5, smoothstep(0.6, 0.9, diffScaled));

  let halfDir = normalize(sunDir + viewDir);
  let NdotH = max(dot(faceNormal, halfDir), 0.0);
  let stormFactor = select(1.0, 0.15, uniforms.weatherType == 4u || uniforms.weatherType == 8u);
  let spec = pow(NdotH, 16.0);
  waterColor += vec3<f32>(1.0, 0.95, 0.8) * spec * 0.8 * stormFactor * sunIntensity;
  let spec2 = pow(NdotH, 4.0);
  waterColor += vec3<f32>(0.5, 0.65, 0.8) * spec2 * 0.1 * stormFactor * sunIntensity;

  let hNorm = input.waveHeight / max(uniforms.waveHeight, 0.01);
  waterColor = mix(waterColor, vec3<f32>(0.0, 0.02, 0.05), smoothstep(0.1, -0.4, hNorm) * 0.4);
  waterColor = mix(waterColor, vec3<f32>(0.12, 0.32, 0.38), smoothstep(0.2, 0.5, hNorm) * 0.2);

  let edge = fwidth(input.worldPos.x) + fwidth(input.worldPos.z);
  let edgeFactor = 1.0 - smoothstep(uniforms.patchSize * 0.3, uniforms.patchSize * 0.48, edge);
  waterColor *= mix(0.5, 1.0, edgeFactor);

  let fresnel = pow(1.0 - max(dot(viewDir, faceNormal), 0.0), 4.0);
  waterColor = mix(waterColor, vec3<f32>(0.3, 0.5, 0.75), fresnel * 0.3);

  let windSS = clamp((uniforms.windSpeed - 8.0) / 17.0, 0.0, 1.0);
  let steepness = 1.0 - faceNormal.y;
  let crestFactor = smoothstep(0.15, 0.5, hNorm);
  let whitecapMask = smoothstep(0.25, 0.45, steepness) * crestFactor * windSS;
  let foamColor = vec3<f32>(0.75, 0.78, 0.72);
  waterColor = mix(waterColor, foamColor, whitecapMask);

  let wakeFoamMask = smoothstep(0.3, 0.5, input.foam);
  waterColor = mix(waterColor, foamColor, wakeFoamMask * 0.8);

  waterColor += applyWaterDynamicLights(input.worldPos, faceNormal, viewDir);

  let c = fogAndNight(dist, waterColor);

  let cosTheta = max(dot(viewDir, vec3<f32>(0.0, 1.0, 0.0)), 0.05);
  let waterPath = dist / cosTheta;
  let underwaterFog = 1.0 - exp(-waterPath * 0.015);
  let fogColor = vec3<f32>(0.02, 0.08, 0.12);
  let finalColor = mix(c, fogColor, underwaterFog * 0.7);
  let finalAlpha = mix(0.85, 0.99, underwaterFog);
  return vec4<f32>(finalColor, finalAlpha);
}
`;

export interface WaterUniforms {
  viewProj: Mat4;
  cameraPos: [number, number, number];
  time: number;
  gridSize: number;
  patchSize: number;
  originX: number;
  originZ: number;
  visibility: number;
  weatherType: number;
  timeOfDay: number;
  waveHeight: number;
  windSpeed: number;
  windDirX: number;
  windDirZ: number;
  weatherIntensity: number;
  sunDir: [number, number, number];
  sunIntensity: number;
  wakeCount: number;
  shoreCount: number;
}

export class WaterPass extends RenderPass {
  name = "water";
  hdrHandle: TextureHandle | null = null;
  depthHandle: TextureHandle | null = null;
  private device: GPUDevice | null;
  private backend: RenderBackend | null;
  private pipeline: GPURenderPipeline | BackendRenderPipeline | null = null;
  private shaderModule: GPUShaderModule | BackendShaderModule | null = null;
  private uniformBuffer: GPUBuffer | BackendBuffer | null = null;
  private bindGroup: GPUBindGroup | BackendBindGroup | null = null;
  private bindGroupLayout: GPUBindGroupLayout | BackendBindGroupLayout | null = null;
  private lightBindGroupLayout: GPUBindGroupLayout | BackendBindGroupLayout | null = null;
  private lightBindGroup: GPUBindGroup | BackendBindGroup | null = null;
  private vertexBuffer: GPUBuffer | BackendBuffer | null = null;
  private indexBuffer: GPUBuffer | BackendBuffer | null = null;
  private indexCount = 0;
  private surfaceFormat: GPUTextureFormat | TextureFormat;
  private depthFormat: GPUTextureFormat | TextureFormat;
  private msaaSampleCount: number;
  private gridSize: number;
  private heightTexture: GPUTexture | BackendTexture | null = null;
  private normalTexture: GPUTexture | BackendTexture | null = null;
  private flowTexture: GPUTexture | BackendTexture | null = null;
  private sampler: GPUSampler | BackendSampler | null = null;
  private wakeBuffer: GPUBuffer | BackendBuffer | null = null;
  private shoreBuffer: GPUBuffer | BackendBuffer | null = null;
  private wakeData: Float32Array;
  private shoreData: Float32Array;
  private wakeCount = 0;
  private shoreCount = 0;
  private time = 0;
  private cachedNormalData: Uint8Array | null = null;
  private cachedHeightData: Float32Array | null = null;
  private uniformData = new Float32Array(40);
  private uniformU32View = new Uint32Array(this.uniformData.buffer);

  constructor(device: GPUDevice | null, surfaceFormat: GPUTextureFormat | TextureFormat, depthFormat: GPUTextureFormat | TextureFormat = "depth32float", msaaSampleCount = 1, gridSize = WATER_GRID, backend?: RenderBackend | null) {
    super();
    this.device = device;
    this.backend = backend ?? null;
    this.surfaceFormat = surfaceFormat;
    this.depthFormat = depthFormat;
    this.msaaSampleCount = msaaSampleCount;
    this.gridSize = gridSize;
    this.wakeData = new Float32Array(MAX_WAKES * WAKE_FLOATS);
    this.shoreData = new Float32Array(MAX_SHORES * SHORE_FLOATS);
  }

  prepare(_device: GPUDevice, _backend?: RenderBackend | null): void {
    if (this.pipeline) return;

    const gridSize = this.gridSize;
    const vertices: number[] = [];
    for (let z = 0; z < gridSize; z++) {
      for (let x = 0; x < gridSize; x++) {
        vertices.push(x, z);
      }
    }
    const indices: number[] = [];
    for (let z = 0; z < gridSize - 1; z++) {
      for (let x = 0; x < gridSize - 1; x++) {
        const i = z * gridSize + x;
        indices.push(i, i + 1, i + gridSize);
        indices.push(i + 1, i + gridSize + 1, i + gridSize);
      }
    }
    this.indexCount = indices.length;

    const wakeBufSize = MAX_WAKES * WAKE_FLOATS * 4;
    const shoreBufSize = MAX_SHORES * SHORE_FLOATS * 4;

    if (this.backend && !this.device) {
      const backend = this.backend;
      this.shaderModule = backend.createShaderModule({ wgsl: WATER_SHADER }, "wgsl");
      this.uniformBuffer = backend.createBuffer({ size: 256, usage: 0x40 | 0x08 });
      this.vertexBuffer = backend.createBuffer({ size: vertices.length * 4, usage: 0x20 | 0x08 });
      backend.queue.writeBuffer(this.vertexBuffer as any, 0, new Float32Array(vertices) as any);
      this.indexBuffer = backend.createBuffer({ size: indices.length * 2, usage: 0x10 | 0x08 });
      backend.queue.writeBuffer(this.indexBuffer as any, 0, new Uint16Array(indices) as any);

      this.heightTexture = backend.createTexture({
        size: [gridSize, gridSize], format: "r32float" as TextureFormat,
        usage: 0x08 | 0x04,
      });
      this.normalTexture = backend.createTexture({
        size: [gridSize, gridSize], format: "rgba8unorm" as TextureFormat,
        usage: 0x08 | 0x04,
      });
      this.flowTexture = backend.createTexture({
        size: [gridSize, gridSize], format: "rg16float" as TextureFormat,
        usage: 0x08 | 0x04,
      });

      this.sampler = backend.createSampler({ magFilter: "linear", minFilter: "linear" });

      this.wakeBuffer = backend.createBuffer({ size: wakeBufSize, usage: 0x80 | 0x08 });
      this.shoreBuffer = backend.createBuffer({ size: shoreBufSize, usage: 0x80 | 0x08 });

      this.bindGroupLayout = backend.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 1 | 2, buffer: { type: "uniform" } },
          { binding: 1, visibility: 1, texture: { sampleType: "unfilterable-float" } },
          { binding: 2, visibility: 2, texture: {} },
          { binding: 3, visibility: 2, texture: { sampleType: "unfilterable-float" } },
          { binding: 4, visibility: 2, sampler: {} },
          { binding: 5, visibility: 1, buffer: { type: "read-only-storage" } },
          { binding: 6, visibility: 1 | 2, buffer: { type: "read-only-storage" } },
        ],
      });

      this.bindGroup = backend.createBindGroup({
        layout: this.bindGroupLayout as any,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer as any } },
          { binding: 1, resource: { textureView: (this.heightTexture as BackendTexture).createView() } },
          { binding: 2, resource: { textureView: (this.normalTexture as BackendTexture).createView() } },
          { binding: 3, resource: { textureView: (this.flowTexture as BackendTexture).createView() } },
          { binding: 4, resource: { sampler: this.sampler as any } },
          { binding: 5, resource: { buffer: this.wakeBuffer as any } },
          { binding: 6, resource: { buffer: this.shoreBuffer as any } },
        ],
      });

      this.lightBindGroupLayout = backend.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 2, buffer: { type: "read-only-storage" } },
        ],
      });

      const pipelineLayout = backend.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout as any, this.lightBindGroupLayout as any],
      });

      this.pipeline = backend.createRenderPipeline({
        layout: pipelineLayout as any,
        vertex: {
          module: this.shaderModule, entryPoint: "vs_main",
          buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }],
        },
        fragment: {
          module: this.shaderModule, entryPoint: "fs_main",
          targets: [{
            format: this.surfaceFormat as TextureFormat,
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            },
          }],
        },
        primitive: { topology: "triangle-list" },
        multisample: { count: this.msaaSampleCount },
        depthStencil: { format: this.depthFormat as any, depthWriteEnabled: true, depthCompare: "less" },
      });
      return;
    }

    const dev = this.device!;
    this.shaderModule = dev.createShaderModule({ code: WATER_SHADER });
    this.uniformBuffer = dev.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.vertexBuffer = dev.createBuffer({ size: vertices.length * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(this.vertexBuffer, 0, new Float32Array(vertices));
    this.indexBuffer = dev.createBuffer({ size: indices.length * 2, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(this.indexBuffer, 0, new Uint16Array(indices));

    this.heightTexture = dev.createTexture({
      size: [gridSize, gridSize], format: "r32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.normalTexture = dev.createTexture({
      size: [gridSize, gridSize], format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.flowTexture = dev.createTexture({
      size: [gridSize, gridSize], format: "rg16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    this.sampler = dev.createSampler({ magFilter: "linear", minFilter: "linear" });

    this.wakeBuffer = dev.createBuffer({ size: wakeBufSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.shoreBuffer = dev.createBuffer({ size: shoreBufSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

    this.bindGroupLayout = dev.createBindGroupLayout({
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

    this.bindGroup = dev.createBindGroup({
      layout: this.bindGroupLayout as GPUBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer as GPUBuffer } },
        { binding: 1, resource: (this.heightTexture as GPUTexture).createView() },
        { binding: 2, resource: (this.normalTexture as GPUTexture).createView() },
        { binding: 3, resource: (this.flowTexture as GPUTexture).createView() },
        { binding: 4, resource: this.sampler as GPUSampler },
        { binding: 5, resource: { buffer: this.wakeBuffer as GPUBuffer } },
        { binding: 6, resource: { buffer: this.shoreBuffer as GPUBuffer } },
      ],
    });

    this.lightBindGroupLayout = dev.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      ],
    });

    const pipelineLayout = dev.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout as GPUBindGroupLayout, this.lightBindGroupLayout as GPUBindGroupLayout],
    });

    this.pipeline = dev.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: this.shaderModule, entryPoint: "vs_main",
        buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }],
      },
      fragment: {
        module: this.shaderModule, entryPoint: "fs_main",
        targets: [{
          format: this.surfaceFormat as GPUTextureFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: this.msaaSampleCount },
      depthStencil: { format: this.depthFormat as GPUTextureFormat, depthWriteEnabled: true, depthCompare: "less" },
    });
  }

  getLightBindGroupLayout(): GPUBindGroupLayout | BackendBindGroupLayout | null {
    return this.lightBindGroupLayout;
  }

  setLightBindGroup(bg: GPUBindGroup | BackendBindGroup): void {
    this.lightBindGroup = bg;
  }

  updateDynamics(wakes: Float32Array, wakeCount: number, shores: Float32Array, shoreCount: number): void {
    const wc = Math.min(wakeCount, MAX_WAKES);
    const sc = Math.min(shoreCount, MAX_SHORES);
    this.wakeData.set(wakes.subarray(0, wc * WAKE_FLOATS));
    this.shoreData.set(shores.subarray(0, sc * SHORE_FLOATS));
    const queue = this.device?.queue ?? this.backend?.queue;
    queue?.writeBuffer(this.wakeBuffer as any, 0, this.wakeData as any);
    queue?.writeBuffer(this.shoreBuffer as any, 0, this.shoreData as any);
    this.wakeCount = wc;
    this.shoreCount = sc;
  }

  setHeightData(heights: Float32Array): void {
    if (!this.heightTexture) return;
    if (!this.cachedHeightData || this.cachedHeightData.length !== heights.length) {
      this.cachedHeightData = new Float32Array(heights.length);
    }
    this.cachedHeightData.set(heights);
    const queue = this.device?.queue ?? this.backend?.queue;
    queue?.writeTexture(
      { texture: this.heightTexture as any },
      this.cachedHeightData as any,
      { bytesPerRow: this.gridSize * 4 },
      { width: this.gridSize, height: this.gridSize },
    );
  }

  setUniforms(u: WaterUniforms): void {
    if (!this.uniformBuffer) return;
    this.time = u.time;
    const data = this.uniformData;
    data.set(u.viewProj as Float32Array, 0);
    data[16] = u.cameraPos[0];
    data[17] = u.cameraPos[1];
    data[18] = u.cameraPos[2];
    data[19] = u.time;
    data[20] = u.gridSize;
    data[21] = u.patchSize;
    data[22] = u.originX;
    data[23] = u.originZ;
    data[24] = u.visibility;
    this.uniformU32View[25] = u.weatherType;
    data[26] = u.timeOfDay;
    data[27] = u.waveHeight;
    data[28] = u.windSpeed;
    data[29] = u.windDirX;
    data[30] = u.windDirZ;
    data[31] = u.weatherIntensity;
    data[32] = u.sunDir[0];
    data[33] = u.sunDir[1];
    data[34] = u.sunDir[2];
    data[35] = u.sunIntensity;
    this.uniformU32View[36] = this.wakeCount;
    this.uniformU32View[37] = this.shoreCount;
    const queue = this.device?.queue ?? this.backend?.queue;
    queue?.writeBuffer(this.uniformBuffer as any, 0, data as any);
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.depthHandle) builder.depthAttachment({ handle: this.depthHandle, depthLoadOp: "load", depthStoreOp: "store", depthReadOnly: true });
    if (this.hdrHandle) builder.colorAttachment({ handle: this.hdrHandle, loadOp: "load", storeOp: "store" });
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.pipeline || !this.bindGroup || !this.vertexBuffer || !this.indexBuffer || !ctx.pass) return;

    // Write default normal data once
    if (!this.cachedNormalData) {
      this.cachedNormalData = new Uint8Array(this.gridSize * this.gridSize * 4);
      for (let i = 0; i < this.gridSize * this.gridSize; i++) {
        this.cachedNormalData[i * 4 + 0] = 128;
        this.cachedNormalData[i * 4 + 1] = 128;
        this.cachedNormalData[i * 4 + 2] = 255;
        this.cachedNormalData[i * 4 + 3] = 255;
      }
    }
    const queue = this.device?.queue ?? this.backend?.queue;
    queue?.writeTexture(
      { texture: this.normalTexture as any },
      this.cachedNormalData as any,
      { bytesPerRow: this.gridSize * 4 },
      { width: this.gridSize, height: this.gridSize },
    );

    const tracked = ctx.pass;
    tracked.setPipeline(this.pipeline as any);
    tracked.setBindGroup(0, this.bindGroup as any);
    if (this.lightBindGroup) {
      tracked.setBindGroup(1, this.lightBindGroup as any);
    }
    tracked.setVertexBuffer(0, this.vertexBuffer as any);
    tracked.setIndexBuffer(this.indexBuffer as any, "uint16");
    tracked.drawIndexed(this.indexCount);
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.wakeBuffer?.destroy();
    this.shoreBuffer?.destroy();
    this.heightTexture?.destroy();
    this.normalTexture?.destroy();
    this.flowTexture?.destroy();
    this.uniformBuffer = null;
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.wakeBuffer = null;
    this.shoreBuffer = null;
    this.heightTexture = null;
    this.normalTexture = null;
    this.flowTexture = null;
    this.sampler = null;
    this.pipeline = null;
    this.shaderModule = null;
    this.bindGroup = null;
    this.bindGroupLayout = null;
    this.lightBindGroup = null;
    this.lightBindGroupLayout = null;
  }
}
