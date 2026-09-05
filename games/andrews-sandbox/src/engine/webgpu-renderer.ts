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
  InputBufferWriter, MSAA_SAMPLE_COUNT, SimBufferReader,
  calculateViewProjInto, type CameraState,
  type RenderContext, type TextureHandle
} from "@downdraft/core";
import { ModelRenderer } from "@downdraft/library-entities";
import { loadModel, type ModelData } from "@downdraft/library-models";
import { PostProcessStack } from "@downdraft/library-postfx";
import { ENT_DATA } from "@sandbox/shared/constants/buffer";
import { EntityType } from "@sandbox/shared/types";
import { mat4 } from "wgpu-matrix";
import { SandboxLighting, type PointLight } from "./lighting";
import { MipmapHelper } from "./mipmap-helper";
import { SceneRenderPass, type SceneDrawFn, type ScenePassState } from "./passes/scene-pass";
import { SandboxShadows } from "./shadows";

// Simple skybox gradient shader (full-screen triangle at depth = far)
const SKY_SHADER = /* wgsl */ `
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0),
  );
  return vec4f(pos[vi], 0.999, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let dims = vec2f(1920.0, 1080.0);
  let uv = pos.xy / dims;
  let t = clamp(uv.y, 0.0, 1.0);
  // Smooth sky gradient: horizon glow → blue → deep blue
  let horizon = vec3f(0.75, 0.82, 0.92);
  let mid = vec3f(0.42, 0.62, 0.88);
  let zenith = vec3f(0.15, 0.30, 0.60);
  let color = mix(horizon, mid, smoothstep(0.0, 0.5, t));
  return vec4f(mix(color, zenith, smoothstep(0.4, 1.0, t)), 1.0);
}
`;

// Ground plane shader
const GROUND_SHADER = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4f,
  cameraPos: vec3f,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
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
  // Checkerboard pattern (2m squares)
  let checkScale = 2.0;
  let cx = floor(worldPos.x / checkScale);
  let cz = floor(worldPos.z / checkScale);
  let checker = (cx + cz) % 2.0;
  // Grid lines (every 4m)
  let gridSize = 4.0;
  let gx = abs(fract(worldPos.x / gridSize) - 0.5) * gridSize;
  let gz = abs(fract(worldPos.z / gridSize) - 0.5) * gridSize;
  let edge = min(gx, gz);
  let gridLine = 1.0 - smoothstep(0.0, 0.08, edge);
  // Base colors
  let colorA = vec3f(0.45, 0.48, 0.52);
  let colorB = vec3f(0.38, 0.41, 0.45);
  let baseColor = mix(colorA, colorB, checker);
  // Add grid lines
  let gridColor = vec3f(0.25, 0.27, 0.30);
  let color = mix(baseColor, gridColor, gridLine * 0.5);
  // Sample paint texture (512m ground → 512px texture, 1m = 1px)
  let paintUV = vec2f(worldPos.x / 512.0 + 0.5, worldPos.z / 512.0 + 0.5);
  let paint = textureSample(paintTex, paintSampler, paintUV);
  let finalColor = mix(color, paint.rgb, paint.a);
  // Lighting: ground normal is up (0,1,0)
  let N = vec3f(0.0, 1.0, 0.0);
  let sunDir = normalize(lighting.sunDir);
  let sunShadow = pcfShadow(worldPos, N);
  let diffuse = max(dot(N, sunDir), 0.0) * lighting.sunColor * sunShadow;
  let hemisphere = lighting.skyAmbient; // ground faces up → sky ambient
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
  let dist = length(worldPos.xz - u.cameraPos.xz);
  let fog = clamp(1.0 - dist / 400.0, 0.0, 1.0);
  let fogColor = lighting.skyAmbient;
  return vec4f(mix(fogColor, litColor, fog), 1.0);
}
`;

// Procedural cube shader with paint texture support + colored lighting.
const CUBE_SHADER = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4f,
  cameraPos: vec3f,
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
@group(0) @binding(1) var<uniform> inst: Instance;
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
}

@vertex
fn vs(@location(0) pos: vec3f, @location(1) uv: vec2f, @location(2) normal: vec3f) -> VertexOut {
  var out: VertexOut;
  out.position = u.viewProj * inst.model * vec4f(pos, 1.0);
  out.uv = uv;
  // Transform normal by model matrix (assuming uniform scale)
  let n = (inst.model * vec4f(normal, 0.0)).xyz;
  out.normal = normalize(n);
  out.worldPos = (inst.model * vec4f(pos, 1.0)).xyz;
  return out;
}

@fragment
fn fs(in: VertexOut) -> @location(0) vec4f {
  let baseColor = inst.color.rgb;
  // Get paint color if available
  var color = baseColor;
  if (inst.hasPaint == 1u) {
    let paint = textureSample(paintTex, paintSampler, in.uv);
    color = mix(baseColor, paint.rgb, paint.a);
  }
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
  return vec4f(mix(fogColor, litColor, fog), 1.0);
}
`;

// Cube vertices: position(3) + uv(2) + normal(3) per vertex, 24 vertices (4 per face)
const CUBE_VERTICES = new Float32Array([
  // +X face (normal: 1,0,0)
   0.5, -0.5, -0.5,  0.0, 0.0,  1.0, 0.0, 0.0,
   0.5,  0.5, -0.5,  0.0, 1.0,  1.0, 0.0, 0.0,
   0.5,  0.5,  0.5,  1.0, 1.0,  1.0, 0.0, 0.0,
   0.5, -0.5,  0.5,  1.0, 0.0,  1.0, 0.0, 0.0,
  // -X face (normal: -1,0,0)
  -0.5, -0.5,  0.5,  0.0, 0.0,  -1.0, 0.0, 0.0,
  -0.5,  0.5,  0.5,  0.0, 1.0,  -1.0, 0.0, 0.0,
  -0.5,  0.5, -0.5,  1.0, 1.0,  -1.0, 0.0, 0.0,
  -0.5, -0.5, -0.5,  1.0, 0.0,  -1.0, 0.0, 0.0,
  // +Y face (normal: 0,1,0)
  -0.5,  0.5, -0.5,  0.0, 0.0,  0.0, 1.0, 0.0,
  -0.5,  0.5,  0.5,  0.0, 1.0,  0.0, 1.0, 0.0,
   0.5,  0.5,  0.5,  1.0, 1.0,  0.0, 1.0, 0.0,
   0.5,  0.5, -0.5,  1.0, 0.0,  0.0, 1.0, 0.0,
  // -Y face (normal: 0,-1,0)
  -0.5, -0.5,  0.5,  0.0, 0.0,  0.0, -1.0, 0.0,
  -0.5, -0.5, -0.5,  0.0, 1.0,  0.0, -1.0, 0.0,
   0.5, -0.5, -0.5,  1.0, 1.0,  0.0, -1.0, 0.0,
   0.5, -0.5,  0.5,  1.0, 0.0,  0.0, -1.0, 0.0,
  // +Z face (normal: 0,0,1)
  -0.5, -0.5,  0.5,  0.0, 0.0,  0.0, 0.0, 1.0,
   0.5, -0.5,  0.5,  0.0, 1.0,  0.0, 0.0, 1.0,
   0.5,  0.5,  0.5,  1.0, 1.0,  0.0, 0.0, 1.0,
  -0.5,  0.5,  0.5,  1.0, 0.0,  0.0, 0.0, 1.0,
  // -Z face (normal: 0,0,-1)
   0.5, -0.5, -0.5,  0.0, 0.0,  0.0, 0.0, -1.0,
  -0.5, -0.5, -0.5,  0.0, 1.0,  0.0, 0.0, -1.0,
  -0.5,  0.5, -0.5,  1.0, 1.0,  0.0, 0.0, -1.0,
   0.5,  0.5, -0.5,  1.0, 0.0,  0.0, 0.0, -1.0,
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
  // Ground plane pipeline + buffers
  private groundPipeline: GPURenderPipeline | null = null;
  private groundVertexBuffer: GPUBuffer | null = null;
  private groundUniformBuffer: GPUBuffer | null = null;
  private groundBindGroup: GPUBindGroup | null = null;
  private groundPaintTexture: GPUTexture | null = null;
  private groundPaintSampler: GPUSampler | null = null;
  private groundPaintBindGroup: GPUBindGroup | null = null;

  // Procedural cube pipeline (for builtin props without model files)
  private cubePipeline: GPURenderPipeline | null = null;
  private cubeVertexBuffer: GPUBuffer | null = null;
  private cubeIndexBuffer: GPUBuffer | null = null;
  private cubeIndexCount = CUBE_INDICES.length;
  private cubeUniformBuffer: GPUBuffer | null = null;
  private cubeInstanceBuffer: GPUBuffer | null = null;
  private cubeInstanceStride = 256;
  private cubeBindGroup0Layout: GPUBindGroupLayout | null = null;
  private cubeSampler: GPUSampler | null = null;
  private cubeDefaultTexture: GPUTexture | null = null;
  private spherePipeline: GPURenderPipeline | null = null;
  private sphereVertexBuffer: GPUBuffer | null = null;
  private sphereIndexBuffer: GPUBuffer | null = null;
  private sphereIndexCount = 0;

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

  setSimReader(sab: SharedArrayBuffer): void {
    this.simReader = new SimBufferReader(sab);
  }

  setInputWriter(sab: SharedArrayBuffer): void {
    this.inputWriter = new InputBufferWriter(sab);
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

      // Model renderer for props
      this.modelRenderer = new ModelRenderer(device, format);
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
      const hdrFormat: GPUTextureFormat = "rgba16float";
      this.createSkyPipeline(device, hdrFormat);
      this.createGroundPipeline(device, hdrFormat);
      this.createCubePipeline(device, hdrFormat);
      this.createSpherePipeline(device, hdrFormat);
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
    this.groundPaintBindGroup = device.createBindGroup({
      label: "ground-paint-bindgroup",
      layout: this.groundPipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: this.groundPaintTexture.createView() },
        { binding: 1, resource: this.groundPaintSampler },
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

    // Instance buffer: model(64) + color(16) + hasPaint(4) + pad(12) = 96 bytes per entity
    // Allocated for up to 256 entities with dynamic offsets (256-byte aligned)
    this.cubeInstanceStride = 256; // 96 bytes data, padded to 256 for dynamic offset alignment
    this.cubeInstanceBuffer = device.createBuffer({
      label: "cube-instance",
      size: this.cubeInstanceStride * 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
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
    // Store the bind group layout for dynamic offset use
    this.cubeBindGroup0Layout = this.cubePipeline.getBindGroupLayout(0);
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
  }

  private createDepthOnlyPipelines(device: GPUDevice): void {
    // Simple depth-only shader: vertex transforms by lightVP * model, no fragment output.
    const DEPTH_ONLY_SHADER = /* wgsl */ `
struct Uniforms {
  lightVP: mat4x4f,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
struct Instance {
  model: mat4x4f,
};
@group(0) @binding(1) var<uniform> inst: Instance;
@vertex
fn vs(@location(0) pos: vec3f) -> @builtin(position) vec4f {
  return u.lightVP * inst.model * vec4f(pos, 1.0);
}
`;
    this.depthOnlyShader = device.createShaderModule({ label: "depth-only", code: DEPTH_ONLY_SHADER });
    // Uniform buffer for the light VP matrix (64 bytes at offset 0) + ground
    // identity model matrix (64 bytes at offset 256, aligned to 256-byte
    // uniform buffer alignment requirement).
    this.depthOnlyCubeUniformBuffer = device.createBuffer({
      label: "depth-only-uniforms",
      size: 512,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Write identity matrix at offset 256 for the ground depth-only pass.
    const identity = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
    device.queue.writeBuffer(this.depthOnlyCubeUniformBuffer, 256, identity);

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
        module: this.depthOnlyShader, entryPoint: "vs",
        buffers: [{
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
        }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil,
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
  }

  // ── Load a model and upload it to the ModelRenderer ──
  async loadPropModel(contentId: string, modelUri: string): Promise<string> {
    const nodeId = `prop-${this.nextNodeId++}`;
    if (this.modelCache.has(contentId)) {
      const model = this.modelCache.get(contentId)!;
      this.modelRenderer!.uploadModel(nodeId, model.meshes, model.materials);
      this.nodeToContent.set(nodeId, contentId);
      return nodeId;
    }
    try {
      const resp = await fetch(modelUri);
      const buffer = await resp.arrayBuffer();
      const filename = modelUri.split("/").pop() ?? "model.glb";
      const model = await loadModel(buffer, filename) as ModelData;
      this.modelCache.set(contentId, model);
      this.modelRenderer!.uploadModel(nodeId, model.meshes, model.materials);
      this.nodeToContent.set(nodeId, contentId);
      return nodeId;
    } catch (err) {
      console.error(`[WebGPURenderer] Failed to load model ${modelUri}:`, err);
      return "";
    }
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
    const count = this.simReader.getEntityCount();
    const lights: PointLight[] = [];
    for (let i = 0; i < count && lights.length < 8; i++) {
      const slot = this.simReader.getEntitySlot(i);
      const type = slot.u32[ENT.TYPE];
      if (type === 255) continue;
      if (type === EntityType.Projectile) {
        // Projectiles emit a warm orange glow.
        lights.push({
          position: [slot.f32[ENT.POS_X], slot.f32[ENT.POS_Y], slot.f32[ENT.POS_Z]],
          color: [1.0, 0.6, 0.2],
          intensity: 2.0,
          radius: 8.0,
        });
      }
    }
    this.lighting.setPointLights(lights);
  }

  private drawFrame(dt: number): void {
    const device = this.getDevice();
    const context = this.getContext();
    if (!device || !context || !this.skyPipeline || !this.groundPipeline) return;
    if (!this.postProcessStack) return;

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

    // Prepare bindless frame bindings
    if (this.bindlessFrameBindings) {
      this.bindlessFrameBindings.prepareFrame();
    }

    // Upload frame-global lighting state
    if (this.lighting) {
      this.collectPointLights();
      this.lighting.upload();
    }
    // Provide the lighting bind group to the model renderer (group 2).
    if (this.modelRenderer && this.modelLightingBg) {
      this.modelRenderer.setFrameLightingBindGroup(this.modelLightingBg);
    }

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
        clearValue: { r: 0.5, g: 0.7, b: 0.9, a: 1 },
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

      // Apply the post-process chain → canvas
      const canvasView = context.getCurrentTexture().createView();
      this.postProcessStack.applyChain(encoder, this.postProcessStack.getSceneDepthView(), canvasView, w, h);
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
          clearValue: { r: 0.5, g: 0.7, b: 0.9, a: 1 },
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
        clearValue: { r: 0.5, g: 0.7, b: 0.9, a: 1 },
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

    // Write the light VP to the depth-only uniform buffer
    const uniformData = new Float32Array(20);
    uniformData.set(lightVP, 0);
    device.queue.writeBuffer(this.depthOnlyCubeUniformBuffer!, 0, uniformData);

    // Ground
    pass.setPipeline(this.depthOnlyGroundPipeline!);
    const groundBg = device.createBindGroup({
      layout: this.depthOnlyGroundPipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.depthOnlyCubeUniformBuffer! } },
        { binding: 1, resource: { buffer: this.depthOnlyCubeUniformBuffer!, offset: 256, size: 64 } },
      ],
    });
    pass.setBindGroup(0, groundBg);
    pass.setVertexBuffer(0, this.groundVertexBuffer!);
    pass.draw(6);

    // Props (cubes + spheres) — reuse the depth-only pipelines
    if (this.simReader) {
      this.renderBuiltinPropsDepth(pass, lightVP);
    }
  }

  /** Render builtin props (cubes + spheres) depth-only into the shadow map. */
  private renderBuiltinPropsDepth(pass: GPURenderPassEncoder, lightVP: Float32Array): void {
    if (!this.simReader || !this.depthOnlyCubePipeline || !this.cubeVertexBuffer || !this.cubeIndexBuffer) return;
    if (!this.depthOnlyCubeUniformBuffer) return;
    const device = this.getDevice()!;
    const count = this.simReader.getEntityCount();
    if (count === 0) return;

    // Write light VP to uniform buffer
    const uniformData = new Float32Array(20);
    uniformData.set(lightVP, 0);
    device.queue.writeBuffer(this.depthOnlyCubeUniformBuffer, 0, uniformData);

    const cubes: number[] = [];
    const spheres: number[] = [];
    for (let i = 0; i < count; i++) {
      const slot = this.simReader.getEntitySlot(i);
      const type = slot.u32[ENT.TYPE];
      if (type === 255 || (type !== EntityType.Prop && type !== EntityType.Mannequin && type !== EntityType.Projectile)) continue;
      const nodeIdRaw = slot.u32[ENT.ID];
      if (nodeIdRaw !== 0) continue; // has a model — skip (model shadow rendering not yet wired)
      const shape = slot.f32[ENT_DATA.SHAPE + ENT.DATA];
      if (shape === 1) spheres.push(i);
      else cubes.push(i);
    }

    const renderBatch = (indices: number[], pipeline: GPURenderPipeline, vertexBuffer: GPUBuffer, indexBuffer: GPUBuffer, indexCount: number) => {
      pass.setPipeline(pipeline);
      pass.setVertexBuffer(0, vertexBuffer);
      pass.setIndexBuffer(indexBuffer, "uint16");
      const stride = this.cubeInstanceStride;
      for (let idx = 0; idx < indices.length; idx++) {
        const i = indices[idx];
        const slot = this.simReader!.getEntitySlot(i);
        const px = slot.f32[ENT.POS_X];
        const py = slot.f32[ENT.POS_Y];
        const pz = slot.f32[ENT.POS_Z];
        const scale = slot.f32[ENT.SCALE] || 1.0;
        const rx = slot.f32[ENT.ROT_X];
        const ry = slot.f32[ENT.ROT_Y];
        const rz = slot.f32[ENT.ROT_Z];
        const rw = slot.f32[ENT.ROT_W];
        const model = this.composeModelMatrix(px, py, pz, rx, ry, rz, rw, scale);
        // Write instance model matrix at offset 64 (after the lightVP uniform)
        const instData = new Float32Array(16);
        instData.set(model, 0);
        device.queue.writeBuffer(this.cubeInstanceBuffer!, idx * stride, instData);
      }
      for (let idx = 0; idx < indices.length; idx++) {
        const bg = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.depthOnlyCubeUniformBuffer! } },
            { binding: 1, resource: { buffer: this.cubeInstanceBuffer!, offset: idx * stride, size: 64 } },
          ],
        });
        pass.setBindGroup(0, bg);
        pass.drawIndexed(indexCount);
      }
    };

    if (cubes.length > 0) {
      renderBatch(cubes, this.depthOnlyCubePipeline, this.cubeVertexBuffer, this.cubeIndexBuffer, this.cubeIndexCount);
    }
    if (spheres.length > 0 && this.depthOnlySpherePipeline && this.sphereVertexBuffer && this.sphereIndexBuffer) {
      renderBatch(spheres, this.depthOnlySpherePipeline, this.sphereVertexBuffer, this.sphereIndexBuffer, this.sphereIndexCount);
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
  };

  private renderProps(pass: GPURenderPassEncoder): void {
    if (!this.modelRenderer || !this.simReader) return;
    const count = this.simReader.getEntityCount();
    for (let i = 0; i < count; i++) {
      const slot = this.simReader.getEntitySlot(i);
      const type = slot.u32[ENT.TYPE];
      if (type === 255 || (type !== EntityType.Prop && type !== EntityType.Mannequin)) continue;
      const nodeIdRaw = slot.u32[ENT.ID];
      if (nodeIdRaw === 0) continue; // builtin prop (rendered as cube) or not yet uploaded
      const nodeId = `prop-${nodeIdRaw}`;
      if (!this.nodeToContent.has(nodeId)) continue;

      const px = slot.f32[ENT.POS_X];
      const py = slot.f32[ENT.POS_Y];
      const pz = slot.f32[ENT.POS_Z];
      const scale = slot.f32[ENT.SCALE];
      const rx = slot.f32[ENT.ROT_X];
      const ry = slot.f32[ENT.ROT_Y];
      const rz = slot.f32[ENT.ROT_Z];
      const rw = slot.f32[ENT.ROT_W];

      this.modelRenderer.render(
        pass,
        nodeId,
        [px, py, pz],
        [rx, ry, rz, rw],
        [scale, scale, scale],
      );
    }
  }

  // ── Render builtin props (cubes + spheres) with paint texture + lighting ──
  private renderBuiltinProps(pass: GPURenderPassEncoder, viewProj: Float32Array): void {
    if (!this.simReader || !this.cubePipeline || !this.cubeVertexBuffer || !this.cubeIndexBuffer) return;
    if (!this.cubeUniformBuffer || !this.cubeInstanceBuffer || !this.cubeSampler) return;
    const device = this.getDevice()!;
    const count = this.simReader.getEntityCount();
    if (count === 0) return;

    // Write shared uniforms (viewProj + cameraPos) — shared by both pipelines
    const uniformData = new Float32Array(20);
    uniformData.set(viewProj, 0);
    uniformData[16] = this.camPos[0];
    uniformData[17] = this.camPos[1];
    uniformData[18] = this.camPos[2];
    device.queue.writeBuffer(this.cubeUniformBuffer, 0, uniformData);

    // Collect entities to render, split by shape
    const cubes: number[] = [];
    const spheres: number[] = [];
    for (let i = 0; i < count; i++) {
      const slot = this.simReader.getEntitySlot(i);
      const type = slot.u32[ENT.TYPE];
      if (type === 255 || (type !== EntityType.Prop && type !== EntityType.Mannequin && type !== EntityType.Projectile)) continue;
      const nodeIdRaw = slot.u32[ENT.ID];
      if (nodeIdRaw !== 0) continue; // has a model — skip
      const shape = slot.f32[ENT_DATA.SHAPE + ENT.DATA];
      if (shape === 1) spheres.push(i);
      else cubes.push(i);
    }

    // Render cubes
    if (cubes.length > 0) {
      this.renderShapeBatch(pass, device, cubes, this.cubePipeline!, this.cubeVertexBuffer!, this.cubeIndexBuffer!, this.cubeIndexCount, this.cubeLightingBg, this.cubeShadowBg);
    }
    // Render spheres
    if (spheres.length > 0 && this.spherePipeline && this.sphereVertexBuffer && this.sphereIndexBuffer) {
      this.renderShapeBatch(pass, device, spheres, this.spherePipeline, this.sphereVertexBuffer, this.sphereIndexBuffer, this.sphereIndexCount, this.sphereLightingBg, this.sphereShadowBg);
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
  ): void {
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.setIndexBuffer(indexBuffer, "uint16");
    if (lightingBg) pass.setBindGroup(2, lightingBg);
    if (shadowBg) pass.setBindGroup(3, shadowBg);

    // Write all instance data first at separate offsets, then create per-entity bind groups
    const stride = this.cubeInstanceStride;
    for (let idx = 0; idx < indices.length; idx++) {
      const i = indices[idx];
      const slot = this.simReader!.getEntitySlot(i);
      const type = slot.u32[ENT.TYPE];

      const px = slot.f32[ENT.POS_X];
      const py = slot.f32[ENT.POS_Y];
      const pz = slot.f32[ENT.POS_Z];
      const scale = slot.f32[ENT.SCALE] || 1.0;
      const rx = slot.f32[ENT.ROT_X];
      const ry = slot.f32[ENT.ROT_Y];
      const rz = slot.f32[ENT.ROT_Z];
      const rw = slot.f32[ENT.ROT_W];

      const model = this.composeModelMatrix(px, py, pz, rx, ry, rz, rw, scale);

      let color: [number, number, number, number];
      if (type === EntityType.Projectile) {
        color = [0.95, 0.3, 0.15, 1.0];
      } else if (type === EntityType.Mannequin) {
        color = [0.7, 0.65, 0.55, 1.0];
      } else {
        const hue = (i * 0.15) % 1.0;
        const r = 0.5 + 0.4 * Math.sin(hue * Math.PI * 2);
        const g = 0.5 + 0.4 * Math.sin(hue * Math.PI * 2 + 2.094);
        const b = 0.5 + 0.4 * Math.sin(hue * Math.PI * 2 + 4.189);
        color = [r, g, b, 1.0];
      }

      const entityId = i + 1;
      const paintTex = this.paintTextures.get(entityId);
      const hasPaint = paintTex ? 1 : 0;

      const instData = new Float32Array(24);
      instData.set(model, 0);
      instData[16] = color[0];
      instData[17] = color[1];
      instData[18] = color[2];
      instData[19] = color[3];
      instData[20] = hasPaint;
      device.queue.writeBuffer(this.cubeInstanceBuffer!, idx * stride, instData);
    }

    // Create per-entity bind groups pointing to the correct offset, then draw
    for (let idx = 0; idx < indices.length; idx++) {
      const i = indices[idx];
      const entityId = i + 1;
      const paintTex = this.paintTextures.get(entityId);
      const tex = paintTex ?? this.cubeDefaultTexture!;

      const bindGroup0 = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.cubeUniformBuffer! } },
          { binding: 1, resource: { buffer: this.cubeInstanceBuffer!, offset: idx * stride, size: 96 } },
        ],
      });
      pass.setBindGroup(0, bindGroup0);

      const bindGroup1 = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: tex.createView() },
          { binding: 1, resource: this.cubeSampler! },
        ],
      });
      pass.setBindGroup(1, bindGroup1);

      pass.drawIndexed(indexCount);
    }
  }

  // ── Compose a 4×4 model matrix from TRS ──
  private composeModelMatrix(
    tx: number, ty: number, tz: number,
    rx: number, ry: number, rz: number, rw: number,
    scale: number,
  ): Float32Array {
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
    return new Float32Array([
      r00 * scale, r10 * scale, r20 * scale, 0,
      r01 * scale, r11 * scale, r21 * scale, 0,
      r02 * scale, r12 * scale, r22 * scale, 0,
      tx, ty, tz, 1,
    ]);
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
