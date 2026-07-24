import type { RenderPassContext } from "../render-pass.ts";
import { RenderPass } from "../render-pass.ts";
import { TrackedRenderPass } from "../tracked-render-pass.ts";
import type { MeshData } from "../../mesh/builder.ts";

export class OpaquePass extends RenderPass {
  name = "opaque";
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private mesh: MeshData | null = null;
  private depthTexture: GPUTexture | null = null;
  private shaderModule: GPUShaderModule | null = null;
  private surfaceFormat: GPUTextureFormat;

  constructor(device: GPUDevice, surfaceFormat?: GPUTextureFormat) {
    super();
    this.device = device;
    this.surfaceFormat = surfaceFormat ?? (navigator.gpu ? navigator.gpu.getPreferredCanvasFormat() : "bgra8unorm");
  }

  setMesh(mesh: MeshData): void {
    this.mesh = mesh;
    this.vertexBuffer = this.device.createBuffer({
      size: mesh.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.vertexBuffer, 0, mesh.vertices.buffer);

    this.indexBuffer = this.device.createBuffer({
      size: mesh.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.indexBuffer, 0, mesh.indices.buffer);
  }

  setShaderSource(wgsl: string): void {
    this.shaderModule = this.device.createShaderModule({ code: wgsl });
    this.pipeline = null;
  }

  prepare(_device: GPUDevice): void {
    if (!this.mesh || !this.shaderModule) return;

    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.shaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: this.mesh.layout.stride,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x2" },
            { shaderLocation: 3, offset: 32, format: "float32x4" },
          ],
        }],
      },
      fragment: {
        module: this.shaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.surfaceFormat }],
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "back",
      },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });
  }

  execute(ctx: RenderPassContext): void {
    if (!this.pipeline || !this.vertexBuffer || !this.indexBuffer || !this.mesh) return;

    const tracked = ctx.pass instanceof TrackedRenderPass
      ? ctx.pass
      : new TrackedRenderPass(ctx.pass);
    tracked.setPipeline(this.pipeline);
    tracked.setVertexBuffer(0, this.vertexBuffer);
    tracked.setIndexBuffer(this.indexBuffer, this.mesh.indices instanceof Uint16Array ? "uint16" : "uint32");
    tracked.drawIndexed(this.mesh.indexCount);
  }

  getBindGroupLayout(): GPUBindGroupLayout | null {
    return this.pipeline?.getBindGroupLayout(0) ?? null;
  }

  ensureDepthTexture(width: number, height: number): GPUTexture {
    if (this.depthTexture) {
      const size = this.depthTexture.size as GPUExtent3D;
      if ((size as any).width === width && (size as any).height === height) {
        return this.depthTexture;
      }
      this.depthTexture.destroy();
    }
    this.depthTexture = this.device.createTexture({
      size: [width, height],
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    return this.depthTexture;
  }

  getDepthTextureView(): GPUTextureView | null {
    return this.depthTexture?.createView() ?? null;
  }
}
