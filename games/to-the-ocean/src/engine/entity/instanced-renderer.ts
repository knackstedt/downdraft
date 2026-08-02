import type { BackendBindGroup, BackendBindGroupLayout, BackendBuffer, BackendRenderPassEncoder, BackendRenderPipeline } from "@downdraft/core/render/backend/types";
import { MAX_ENTITIES } from "@shared/constants";
import { EntityType } from "@shared/types";
import { DEPTH_FORMAT, MSAA_SAMPLE_COUNT } from "../graphicsConfig";
import { INSTANCED_ENTITY_WGSL } from "../shaders/entity-shaders";
import type { EntityRenderContext } from "./render-context";

export class InstancedEntityRenderer {
  private ctx: EntityRenderContext;

  private instancedPipeline: GPURenderPipeline | BackendRenderPipeline | null = null;
  private instancedFrameUniformBuffer: GPUBuffer | BackendBuffer | null = null;
  private instanceStorageBuffer: GPUBuffer | BackendBuffer | null = null;
  private instancedBindGroup: GPUBindGroup | BackendBindGroup | null = null;
  private instancedBindGroupLayout: GPUBindGroupLayout | BackendBindGroupLayout | null = null;
  private instanceDataAb: ArrayBuffer | null = null;
  private instanceDataF32: Float32Array | null = null;
  private instanceDataU32: Uint32Array | null = null;
  private instanceCount = 0;
  private _lastFrameTriangles = 0;
  private frameUniformData = new Float32Array(32);

  // Cube geometry shared with fallback entity rendering
  cubeVertices: GPUBuffer | BackendBuffer | null = null;
  cubeIndices: GPUBuffer | BackendBuffer | null = null;
  cubeIndexCount = 0;

  constructor(ctx: EntityRenderContext) {
    this.ctx = ctx;
  }

  init(
    cubeVertices: GPUBuffer | BackendBuffer,
    cubeIndices: GPUBuffer | BackendBuffer,
    cubeIndexCount: number,
    lightBindGroupLayout?: GPUBindGroupLayout | BackendBindGroupLayout,
    pbrBindGroupLayout?: GPUBindGroupLayout | BackendBindGroupLayout,
  ): void {
    const device = this.ctx.device!;
    const format = this.ctx.format;
    this.cubeVertices = cubeVertices;
    this.cubeIndices = cubeIndices;
    this.cubeIndexCount = cubeIndexCount;

    const instancedShaderModule = device.createShaderModule({ code: INSTANCED_ENTITY_WGSL });
    this.instancedFrameUniformBuffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.instanceStorageBuffer = device.createBuffer({
      size: MAX_ENTITIES * 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.instanceDataAb = new ArrayBuffer(MAX_ENTITIES * 48);
    this.instanceDataF32 = new Float32Array(this.instanceDataAb);
    this.instanceDataU32 = new Uint32Array(this.instanceDataAb);

    this.instancedBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });
    this.instancedBindGroup = device.createBindGroup({
      layout: this.instancedBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.instancedFrameUniformBuffer, size: 256 } },
        { binding: 1, resource: { buffer: this.instanceStorageBuffer } },
      ],
    });

    const instancedLitLayout = (lightBindGroupLayout && pbrBindGroupLayout)
      ? device.createPipelineLayout({ bindGroupLayouts: [this.instancedBindGroupLayout as any, lightBindGroupLayout as any, pbrBindGroupLayout as any] })
      : lightBindGroupLayout
        ? device.createPipelineLayout({ bindGroupLayouts: [this.instancedBindGroupLayout as any, lightBindGroupLayout as any] })
        : device.createPipelineLayout({ bindGroupLayouts: [this.instancedBindGroupLayout as any] });

    this.instancedPipeline = device.createRenderPipeline({
      layout: instancedLitLayout,
      vertex: {
        module: instancedShaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
          ],
        }],
      },
      fragment: {
        module: instancedShaderModule,
        entryPoint: "fs_main",
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });
  }

  static isInstancedType(type: EntityType): boolean {
    return type !== EntityType.Player &&
           type !== EntityType.Ship &&
           type !== EntityType.SmallCraft &&
           type !== EntityType.Island &&
           type !== EntityType.Port;
  }

  resetFrame(): void {
    this.instanceCount = 0;
  }

  writeFrameUniforms(): void {
    const ctx = this.ctx;
    if (!this.instancedFrameUniformBuffer || !ctx.viewProjCache) return;
    const fu = this.frameUniformData;
    for (let i = 0; i < 16; i++) fu[i] = ctx.viewProjCache[i];
    fu[16] = ctx.cameraPosCache[0];
    fu[17] = ctx.cameraPosCache[1];
    fu[18] = ctx.cameraPosCache[2];
    fu[19] = performance.now() / 1000;
    const lp = ctx.lightingParamsCache;
    fu[20] = lp.sunDir[0];
    fu[21] = lp.sunDir[1];
    fu[22] = lp.sunDir[2];
    fu[23] = lp.sunIntensity;
    fu[24] = lp.ambient;
    fu[25] = 0; fu[26] = 0; fu[27] = 0;
    fu[28] = lp.fogColor[0];
    fu[29] = lp.fogColor[1];
    fu[30] = lp.fogColor[2];
    fu[31] = 0;
    ctx.device?.queue?.writeBuffer(this.instancedFrameUniformBuffer as any, 0, fu);
  }

  writeInstanceData(
    pos: { x: number; y: number; z: number },
    scale: number,
    rotation: { x: number; y: number; z: number; w: number },
    type: EntityType,
    flags: number,
  ): void {
    if (!this.instanceDataF32 || !this.instanceDataU32) return;
    if (this.instanceCount >= MAX_ENTITIES) return;
    const off = this.instanceCount * 12;
    this.instanceDataF32[off] = pos.x;
    this.instanceDataF32[off + 1] = pos.y;
    this.instanceDataF32[off + 2] = pos.z;
    this.instanceDataF32[off + 3] = scale;
    this.instanceDataF32[off + 4] = rotation.x;
    this.instanceDataF32[off + 5] = rotation.y;
    this.instanceDataF32[off + 6] = rotation.z;
    this.instanceDataF32[off + 7] = rotation.w;
    this.instanceDataU32[off + 8] = type;
    this.instanceDataU32[off + 9] = flags;
    this.instanceDataF32[off + 10] = 0;
    this.instanceDataF32[off + 11] = 0;
    this.instanceCount++;
  }

  uploadInstanceData(): void {
    if (!this.instanceStorageBuffer || !this.instanceDataF32 || this.instanceCount === 0) return;
    const view = new Float32Array(this.instanceDataF32.buffer as ArrayBuffer, 0, this.instanceCount * 12);
    this.ctx.device?.queue?.writeBuffer(this.instanceStorageBuffer as any, 0, view);
  }

  render(passEncoder: GPURenderPassEncoder | BackendRenderPassEncoder): void {
    const ctx = this.ctx;
    if (!this.instancedPipeline || !this.instancedBindGroup || !this.cubeVertices || !this.cubeIndices || this.instanceCount === 0) {
      this._lastFrameTriangles = 0;
      return;
    }
    passEncoder.setPipeline(this.instancedPipeline as any);
    passEncoder.setBindGroup(0, this.instancedBindGroup as any);
    if (ctx.lightBindGroup) {
      passEncoder.setBindGroup(1, ctx.lightBindGroup as any);
    }
    if (ctx.pbrBindGroup) {
      passEncoder.setBindGroup(2, ctx.pbrBindGroup as any);
    }
    passEncoder.setVertexBuffer(0, this.cubeVertices as any);
    passEncoder.setIndexBuffer(this.cubeIndices as any, "uint16");
    passEncoder.drawIndexed(this.cubeIndexCount, this.instanceCount);
    this._lastFrameTriangles = Math.floor(this.cubeIndexCount / 3) * this.instanceCount;
  }

  getLastFrameTriangles(): number {
    return this._lastFrameTriangles;
  }
}
