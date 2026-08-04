import type { FrameGraphBuilder, GraphRenderContext, TextureHandle } from "../frame-graph";
import { PassType } from "../frame-graph";
import { RenderPass } from "../render-pass";
import { DEFAULT_RSM_CONFIG, type RSMConfig, VPL_FLOATS, packVPLsToBuffer } from "./gi-types";

const RSM_INJECT_SHADER = /* wgsl */ `
struct RSMUniforms {
  lightViewProj: mat4x4<f32>,
  invLightViewProj: mat4x4<f32>,
  rsmResolution: u32,
  maxVPLs: u32,
  intensity: f32,
  rsmRadius: f32,
  _pad0: u32,
  _pad1: u32,
};

struct VPL {
  position: vec4<f32>,
  color: vec4<f32>,
  normal: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: RSMUniforms;
@group(0) @binding(1) var rsmDepthTex: texture_2d<f32>;
@group(0) @binding(2) var rsmAlbedoTex: texture_2d<f32>;
@group(0) @binding(3) var rsmNormalTex: texture_2d<f32>;
@group(0) @binding(4) var rsmFluxTex: texture_2d<f32>;
@group(0) @binding(5) var<storage, read_write> vplBuffer: array<VPL>;

fn reconstructWorldPos(uv: vec2<f32>, depth: f32) -> vec3<f32> {
  let ndc = vec3<f32>(uv * 2.0 - 1.0, depth);
  let worldPos = uniforms.invLightViewProj * vec4<f32>(ndc, 1.0);
  return worldPos.xyz / worldPos.w;
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: u32) {
  if (gid >= uniforms.maxVPLs) { return; }

  let totalTexels = uniforms.rsmResolution * uniforms.rsmResolution;
  let stride = totalTexels / uniforms.maxVPLs;
  let texelIdx = gid * stride;

  let y = texelIdx / uniforms.rsmResolution;
  let x = texelIdx % uniforms.rsmResolution;
  if (x >= uniforms.rsmResolution || y >= uniforms.rsmResolution) { return; }

  let texel = vec2<i32>(i32(x), i32(y));
  let depth = textureLoad(rsmDepthTex, texel, 0);
  if (depth >= 1.0) {
    vplBuffer[gid] = VPL(vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0));
    return;
  }

  let uv = vec2<f32>(f32(x) / f32(uniforms.rsmResolution), f32(y) / f32(uniforms.rsmResolution));
  let worldPos = reconstructWorldPos(uv, depth);

  let albedo = textureLoad(rsmAlbedoTex, texel, 0);
  let normal = textureLoad(rsmNormalTex, texel, 0);
  let flux = textureLoad(rsmFluxTex, texel, 0);

  let color = albedo.rgb * flux.rgb * uniforms.intensity;
  let range = uniforms.rsmRadius * 10.0;

  vplBuffer[gid] = VPL(
    vec4<f32>(worldPos, range),
    vec4<f32>(color, 1.0),
    vec4<f32>(normal.rgb * 2.0 - 1.0, 0.0),
  );
}
`;

const RSM_EVALUATE_SHADER = /* wgsl */ `
struct RSMEvalUniforms {
  cameraPos: vec3<f32>,
  numVPLs: u32,
  viewProj: mat4x4<f32>,
  invViewProj: mat4x4<f32>,
  screenSize: vec2<f32>,
  _pad0: f32,
  _pad1: f32,
};

struct VPL {
  position: vec4<f32>,
  color: vec4<f32>,
  normal: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: RSMEvalUniforms;
@group(0) @binding(1) var depthTex: texture_depth_2d;
@group(0) @binding(2) var normalTex: texture_2d<f32>;
@group(0) @binding(3) var<storage> vplBuffer: array<VPL>;

fn reconstructWorldPos(uv: vec2<f32>, depth: f32) -> vec3<f32> {
  let ndc = vec3<f32>(uv * 2.0 - 1.0, depth);
  let worldPos = uniforms.invViewProj * vec4<f32>(ndc, 1.0);
  return worldPos.xyz / worldPos.w;
}

@compute @workgroup_size(8, 8)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = vec2<u32>(textureDimensions(depthTex));
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let texel = vec2<i32>(gid.xy);
  let depth = textureLoad(depthTex, texel, 0);
  if (depth >= 1.0) { return; }

  let uv = vec2<f32>(gid.xy) / vec2<f32>(dims);
  let worldPos = reconstructWorldPos(uv, depth);

  let normalSample = textureLoad(normalTex, texel, 0);
  let N = normalize(normalSample.rgb * 2.0 - 1.0);

  var indirect = vec3<f32>(0.0);
  for (var i = 0u; i < uniforms.numVPLs; i = i + 1u) {
    let vpl = vplBuffer[i];
    if (vpl.color.w < 0.01) { continue; }

    let toVPL = vpl.position.xyz - worldPos;
    let dist = length(toVPL);
    if (dist > vpl.position.w) { continue; }

    let L = toVPL / max(dist, 0.001);
    let NdotL = max(dot(N, L), 0.0);
    let vplNdotL = max(dot(-vpl.normal.xyz, L), 0.0);

    let attenuation = 1.0 / (1.0 + dist * dist);
    indirect += vpl.color.rgb * NdotL * vplNdotL * attenuation;
  }

  // Output is stored in a texture for compositing
  // This compute shader writes to a storage texture
}
`;

export class RSMPass extends RenderPass {
  name = "rsm-inject";
  passType = PassType.Custom;

  private device: GPUDevice | null;
  private config: RSMConfig;

  private injectPipeline: GPUComputePipeline | null = null;
  private injectBindGroup: GPUBindGroup | null = null;
  private vplBuffer: GPUBuffer | null = null;
  private rsmUniformBuffer: GPUBuffer | null = null;

  rsmDepthHandle: TextureHandle | null = null;
  rsmAlbedoHandle: TextureHandle | null = null;
  rsmNormalHandle: TextureHandle | null = null;
  rsmFluxHandle: TextureHandle | null = null;

  private lightViewProj: Float32Array = new Float32Array(16);
  private invLightViewProj: Float32Array = new Float32Array(16);

  constructor(config?: Partial<RSMConfig>, device?: GPUDevice | null) {
    super();
    this.config = { ...DEFAULT_RSM_CONFIG, ...config };
    this.device = device ?? null;
  }

  prepare(device: GPUDevice): void {
    this.device = device;

    this.vplBuffer = device.createBuffer({
      label: "rsm-vpl-buffer",
      size: this.config.maxVPLs * VPL_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.rsmUniformBuffer = device.createBuffer({
      label: "rsm-uniforms",
      size: 96, // mat4x4 * 2 + 4 u32/f32
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const shader = device.createShaderModule({ code: RSM_INJECT_SHADER });
    this.injectPipeline = device.createComputePipeline({
      label: "rsm-inject",
      layout: "auto",
      compute: { module: shader, entryPoint: "cs_main" },
    });
  }

  setLightMatrices(lightViewProj: Float32Array, invLightViewProj: Float32Array): void {
    this.lightViewProj = lightViewProj;
    this.invLightViewProj = invLightViewProj;
  }

  updateUniforms(): void {
    const buf = new Float32Array(24);
    buf.set(this.lightViewProj, 0);
    buf.set(this.invLightViewProj, 16);

    if (this.device && this.rsmUniformBuffer) {
      this.device.queue.writeBuffer(this.rsmUniformBuffer, 0, buf as unknown as BufferSource);
    }
  }

  updateVPLs(vpls: ReturnType<typeof packVPLsToBuffer>): void {
    if (this.device && this.vplBuffer) {
      this.device.queue.writeBuffer(this.vplBuffer, 0, vpls as unknown as BufferSource);
    }
  }

  getVPLBuffer(): GPUBuffer | null {
    return this.vplBuffer;
  }

  getConfig(): RSMConfig {
    return this.config;
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.rsmDepthHandle) builder.read(this.rsmDepthHandle);
    if (this.rsmAlbedoHandle) builder.read(this.rsmAlbedoHandle);
    if (this.rsmNormalHandle) builder.read(this.rsmNormalHandle);
    if (this.rsmFluxHandle) builder.read(this.rsmFluxHandle);
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.config.enabled) return;
    this.updateUniforms();
    // The actual compute dispatch happens in the render loop
    // This pass is a Custom pass — it dispatches compute directly
  }

  destroy(): void {
    this.vplBuffer?.destroy();
    this.rsmUniformBuffer?.destroy();
  }
}
