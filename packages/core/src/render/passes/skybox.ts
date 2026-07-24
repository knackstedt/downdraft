import type { RenderPassContext } from "../render-pass.ts";
import { RenderPass } from "../render-pass.ts";
import { TrackedRenderPass } from "../tracked-render-pass.ts";
import { mat4, type Mat4 } from "wgpu-matrix";

const SKYBOX_SHADER = `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
  invViewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  _pad0: f32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var skyboxTex: texture_cube<f32>;
@group(0) @binding(2) var skyboxSampler: sampler;

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) direction: vec3<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  let positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0),
  );
  let pos = positions[vi];
  var output: VertexOutput;
  output.clipPosition = vec4<f32>(pos, 1.0, 1.0);
  let ndc = vec3<f32>(pos, 1.0);
  let worldDir = camera.invViewProj * vec4<f32>(ndc, 1.0);
  output.direction = normalize(worldDir.xyz / worldDir.w - camera.cameraPos);
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let color = textureSample(skyboxTex, skyboxSampler, input.direction);
  return vec4<f32>(color.rgb, 1.0);
}
`;

export class SkyboxPass extends RenderPass {
  name = "skybox";
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  private shaderModule: GPUShaderModule | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private surfaceFormat: GPUTextureFormat;
  private skyboxTexture: GPUTexture | null = null;
  private skyboxView: GPUTextureView | null = null;
  private sampler: GPUSampler | null = null;

  constructor(device: GPUDevice, surfaceFormat: GPUTextureFormat) {
    super();
    this.device = device;
    this.surfaceFormat = surfaceFormat;
  }

  prepare(_device: GPUDevice): void {
    if (!this.shaderModule) {
      this.shaderModule = this.device.createShaderModule({ code: SKYBOX_SHADER });
    }

    this.cameraBuffer = this.device.createBuffer({
      size: 192,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.sampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      addressModeW: "clamp-to-edge",
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
        targets: [{ format: this.surfaceFormat }],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
    });
  }

  setCamera(
    viewProj: Mat4,
    invViewProj: Mat4,
    cameraPos: [number, number, number],
  ): void {
    const data = new Float32Array(48);
    data.set(viewProj as Float32Array, 0);
    data.set(invViewProj as Float32Array, 16);
    data[44] = cameraPos[0];
    data[45] = cameraPos[1];
    data[46] = cameraPos[2];
    this.device.queue.writeBuffer(this.cameraBuffer!, 0, data as unknown as BufferSource);
  }

  setSkyboxTexture(texture: GPUTexture): void {
    this.skyboxTexture = texture;
    this.skyboxView = texture.createView({ dimension: "cube" });
    this.bindGroup = null;
  }

  private ensureBindGroup(): void {
    if (this.bindGroup || !this.pipeline || !this.skyboxView || !this.sampler) return;
    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer! } },
        { binding: 1, resource: this.skyboxView },
        { binding: 2, resource: this.sampler },
      ],
    });
  }

  execute(ctx: RenderPassContext): void {
    if (!this.pipeline) return;
    this.ensureBindGroup();
    if (!this.bindGroup) return;

    const tracked = ctx.pass instanceof TrackedRenderPass ? ctx.pass : new TrackedRenderPass(ctx.pass);
    tracked.setPipeline(this.pipeline);
    tracked.setBindGroup(0, this.bindGroup);
    tracked.draw(6);
  }

  destroy(): void {
    this.cameraBuffer?.destroy();
    this.skyboxTexture?.destroy();
  }
}
