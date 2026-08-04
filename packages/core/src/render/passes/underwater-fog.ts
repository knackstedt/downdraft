import type { FrameGraphBuilder, GraphRenderContext, TextureHandle } from "../frame-graph";
import { RenderPass } from "../render-pass";

const UNDERWATER_FOG_SHADER = /* wgsl */ `
struct Uniforms {
  depth: f32,
  time: f32,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  var output: VertexOutput;
  let positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  let pos = positions[vi];
  output.clipPos = vec4<f32>(pos, 0.0, 1.0);
  output.uv = pos * 0.5 + 0.5;
  return output;
}

fn hash2d(p: vec2<f32>) -> vec2<f32> {
  let k = vec2<f32>(0.3183099, 0.3678794);
  let q = fract(p * k);
  return -1.0 + 2.0 * fract(vec2<f32>(
    dot(q, vec2<f32>(127.1, 311.7)),
    dot(q, vec2<f32>(269.5, 183.3))
  ) * 43758.5453);
}

fn perlin2d(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  let ga = hash2d(i);
  let gb = hash2d(i + vec2<f32>(1.0, 0.0));
  let gc = hash2d(i + vec2<f32>(0.0, 1.0));
  let gd = hash2d(i + vec2<f32>(1.0, 1.0));

  let va = dot(ga, f);
  let vb = dot(gb, f - vec2<f32>(1.0, 0.0));
  let vc = dot(gc, f - vec2<f32>(0.0, 1.0));
  let vd = dot(gd, f - vec2<f32>(1.0, 1.0));

  return mix(mix(va, vb, u.x), mix(vc, vd, u.x), u.y) * 0.5 + 0.5;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let depth = max(uniforms.depth, 0.3);
  let fogIntensity = 1.0 - exp(-depth * 0.8);

  let causticUV = input.uv * 6.0 + vec2<f32>(uniforms.time * 0.25, uniforms.time * 0.18);
  let n1 = perlin2d(causticUV);
  let n2 = perlin2d(causticUV * 2.0 + 10.0);
  let n3 = perlin2d(causticUV * 4.0 + 20.0);
  let caustic = (n1 * 0.5 + n2 * 0.3 + n3 * 0.2);

  var fogColor = vec3<f32>(0.05, 0.25, 0.35);
  fogColor = fogColor + vec3<f32>(0.0, 0.06, 0.08) * caustic;

  fogColor = mix(fogColor, vec3<f32>(0.0, 0.08, 0.15), min(depth * 0.04, 0.7));

  let alpha = clamp(fogIntensity * 1.5, 0.4, 0.95);
  return vec4<f32>(fogColor, alpha);
}
`;

export class UnderwaterFogPass extends RenderPass {
  name = "underwater-fog";
  surfaceHandle: TextureHandle | null = null;
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  private shaderModule: GPUShaderModule | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private surfaceFormat: GPUTextureFormat;
  private msaaSampleCount: number = 1;
  private depth: number = 0;
  private time: number = 0;

  constructor(device: GPUDevice, surfaceFormat: GPUTextureFormat, msaaSampleCount = 1) {
    super();
    this.device = device;
    this.surfaceFormat = surfaceFormat;
    this.msaaSampleCount = msaaSampleCount;
  }

  prepare(_device: GPUDevice): void {
    if (this.pipeline) return;

    this.shaderModule = this.device.createShaderModule({ code: UNDERWATER_FOG_SHADER });

    this.uniformBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.shaderModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: this.shaderModule,
        entryPoint: "fs_main",
        targets: [{
          format: this.surfaceFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: this.msaaSampleCount },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: false,
        depthCompare: "always",
      },
    });

    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
  }

  setDepth(depth: number, time: number): void {
    this.depth = depth;
    this.time = time;
    if (!this.uniformBuffer) return;
    const data = new Float32Array(4);
    data[0] = depth;
    data[1] = time;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.surfaceHandle) builder.colorAttachment({ handle: this.surfaceHandle, loadOp: "load", storeOp: "store" });
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.pipeline || !this.bindGroup || !ctx.pass) return;

    const tracked = ctx.pass;
    tracked.setPipeline(this.pipeline);
    tracked.setBindGroup(0, this.bindGroup);
    tracked.draw(3);
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.uniformBuffer = null;
    this.pipeline = null;
    this.shaderModule = null;
    this.bindGroup = null;
  }
}
