import { PassType, type FrameGraphBuilder, type GraphRenderContext, type TextureHandle } from "../frame-graph.ts";
import { RenderPass } from "../render-pass.ts";

const FULLSCREEN_VS = /* wgsl */ `
struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  var output: VertexOutput;
  let x = f32(vi & 1u) * 4.0 - 1.0;
  let y = f32((vi >> 1u) & 1u) * 4.0 - 1.0;
  output.clipPosition = vec4<f32>(x, y, 0.0, 1.0);
  output.uv = vec2<f32>(x * 0.5 + 0.5, 1.0 - y * 0.5);
  return output;
}
`;

const LUT3D_FS = /* wgsl */ `
struct LUT3DUniforms {
  lutSize: f32,
  enabled: f32,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> u: LUT3DUniforms;
@group(0) @binding(1) var sourceTex: texture_2d<f32>;
@group(0) @binding(2) var lutTex: texture_3d<f32>;
@group(0) @binding(3) var texSampler: sampler;

@fragment
fn lut3d_fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  var color = textureSample(sourceTex, texSampler, uv).rgb;

  if (u.enabled > 0.5) {
    let lutSize = u.lutSize;
    let lutCoord = color * ((lutSize - 1.0) / lutSize) + 0.5 / lutSize;
    color = textureSample(lutTex, texSampler, lutCoord).rgb;
  }

  return vec4<f32>(color, 1.0);
}
`;

export class LUT3DPass extends RenderPass {
  name = "lut3d";
  passType = PassType.Custom;
  inputHandle: TextureHandle | null = null;
  outputHandle: TextureHandle | null = null;

  private device: GPUDevice;
  private lutTexture: GPUTexture | null = null;
  private lutView: GPUTextureView | null = null;
  private sampler: GPUSampler | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private lutSize: number = 32;
  private enabled: boolean = false;

  constructor(device: GPUDevice) {
    super();
    this.device = device;
  }

  setLUT(lutData: Uint8Array, size: number): void {
    if (this.lutTexture) {
      this.lutTexture.destroy();
    }
    this.lutSize = size;
    this.lutTexture = this.device.createTexture({
      size: [size, size, size],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.lutView = this.lutTexture.createView({ dimension: "3d" });
    this.device.queue.writeTexture(
      { texture: this.lutTexture },
      lutData,
      { bytesPerRow: size * 4, rowsPerImage: size },
      { width: size, height: size, depthOrArrayLayers: size },
    );
    this.enabled = true;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  prepare(_device: GPUDevice): void {
    this.sampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      addressModeW: "clamp-to-edge",
    });

    this.uniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.device.createShaderModule({ code: FULLSCREEN_VS }),
        entryPoint: "vs_main",
      },
      fragment: {
        module: this.device.createShaderModule({ code: LUT3D_FS }),
        entryPoint: "lut3d_fs",
        targets: [{ format: "bgra8unorm" }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.inputHandle) builder.read(this.inputHandle);
    if (this.outputHandle) builder.write(this.outputHandle);
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.inputHandle || !this.outputHandle || !this.pipeline || !this.lutView) return;

    const sourceView = ctx.getView(this.inputHandle);
    const outputView = ctx.getView(this.outputHandle);

    const uniformData = new Float32Array([this.lutSize, this.enabled ? 1.0 : 0.0, 0, 0]);
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, uniformData as unknown as BufferSource);

    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer! } },
        { binding: 1, resource: sourceView },
        { binding: 2, resource: this.lutView },
        { binding: 3, resource: this.sampler! },
      ],
    });

    const encoder = ctx.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: outputView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
    ctx.device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.lutTexture?.destroy();
    this.uniformBuffer?.destroy();
  }
}
