import type { WgslStruct } from "@downdraft/engine/shader-graph";
import { f32, u32, wgsl } from "@downdraft/engine/shader-graph";
import type { FrameGraphBuilder, GraphRenderContext, TextureHandle } from "../frame-graph";
import { PassType } from "../frame-graph";
import { RenderPass } from "../render-pass";

const FluidUniforms: WgslStruct = wgsl.struct("FluidUniforms", {
  gridSize: u32,
  dt: f32,
  viscosity: f32,
  diffusion: f32,
  _pad0: u32,
  _pad1: u32,
});

const RenderUniforms: WgslStruct = wgsl.struct("RenderUniforms", {
  gridSize: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
});

export interface FluidConfig {
  gridResolution: number;
  viscosity: number;
  density: number;
  diffusion: number;
  pressureIterations: number;
  enabled: boolean;
}

export const DEFAULT_FLUID_CONFIG: FluidConfig = {
  gridResolution: 128,
  viscosity: 0.0001,
  density: 0.1,
  diffusion: 0.0001,
  pressureIterations: 20,
  enabled: false,
};

const FLUID_ADVECT_SHADER = /* wgsl */ `
${FluidUniforms.wgsl}

@group(0) @binding(0) var<uniform> u: FluidUniforms;
@group(0) @binding(1) var velocityTex: texture_2d<f32>;
@group(0) @binding(2) var densityTex: texture_2d<f32>;
@group(0) @binding(3) var<storage, read_write> outputVel: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> outputDensity: array<vec4<f32>>;

@compute @workgroup_size(8, 8)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= u.gridSize || gid.y >= u.gridSize) { return; }
  let idx = gid.y * u.gridSize + gid.x;
  let texel = vec2<i32>(gid.xy);
  let vel = textureLoad(velocityTex, texel, 0);
  let dens = textureLoad(densityTex, texel, 0);

  let pos = vec2<f32>(gid.xy);
  let backPos = pos - vel.xy * u.dt * f32(u.gridSize);
  let backTexel = vec2<i32>(clamp(backPos, vec2<f32>(0.0), vec2<f32>(f32(u.gridSize - 1u))));

  let sampledVel = textureLoad(velocityTex, backTexel, 0);
  let sampledDens = textureLoad(densityTex, backTexel, 0);

  outputVel[idx] = sampledVel;
  outputDensity[idx] = sampledDens;
}
`;

const FLUID_RENDER_SHADER = /* wgsl */ `
${RenderUniforms.wgsl}

@group(0) @binding(0) var<uniform> u: RenderUniforms;
@group(0) @binding(1) var densityTex: texture_2d<f32>;
@group(0) @binding(2) var velocityTex: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  let positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0),
  );
  let pos = positions[vi];
  var output: VertexOutput;
  output.clipPosition = vec4<f32>(pos, 0.0, 1.0);
  output.uv = pos * 0.5 + 0.5;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let density = textureSample(densityTex, texSampler, input.uv);
  let velocity = textureSample(velocityTex, texSampler, input.uv);
  let color = vec3<f32>(density.r * 0.2, density.r * 0.5, density.r * 0.8 + 0.1);
  return vec4<f32>(color, density.r);
}
`;

export class FluidRenderPass extends RenderPass {
  name = "fluid-render";
  passType = PassType.Custom;

  private config: FluidConfig;
  private device: GPUDevice | null = null;

  densityHandle: TextureHandle | null = null;
  velocityHandle: TextureHandle | null = null;
  outputHandle: TextureHandle | null = null;

  constructor(config?: Partial<FluidConfig>, device?: GPUDevice | null) {
    super();
    this.config = { ...DEFAULT_FLUID_CONFIG, ...config };
    this.device = device ?? null;
  }

  getConfig(): FluidConfig { return this.config; }

  prepare(_device: GPUDevice): void {}

  setup(builder: FrameGraphBuilder): void {
    if (this.densityHandle) builder.read(this.densityHandle);
    if (this.velocityHandle) builder.read(this.velocityHandle);
    if (this.outputHandle) builder.colorAttachment({ handle: this.outputHandle, loadOp: "clear", storeOp: "store" });
  }

  execute(_ctx: GraphRenderContext): void {
    if (!this.config.enabled) return;
  }

  destroy(): void {}
}
