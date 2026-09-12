import { createValidatedShaderModule } from "@downdraft/core";
import { DEPTH_FORMAT, MSAA_SAMPLE_COUNT } from "@downdraft/core";
import { EntityType } from "@shared/types";
import { HITBOX_WGSL, ISLAND_WIREFRAME_WGSL } from "../shaders/entity-shaders";
import type { EntityRenderContext } from "./render-context";

const MAX_HITBOX_ENTRIES = 4096;

export interface IslandWireframeRef {
  vertices: GPUBuffer;
  lineIndices: GPUBuffer | null;
  lineIndexCount: number;
  useUint32: boolean;
}

export class HitboxRenderer {
  private ctx: EntityRenderContext;

  private hitboxPipeline: GPURenderPipeline | null = null;
  private islandWireframePipeline: GPURenderPipeline | null = null;
  private hitboxQuadVertices: GPUBuffer | null = null;
  private hitboxQuadIndices: GPUBuffer | null = null;
  private hitboxQuadIndexCount = 0;
  private hitboxUniformBuffer: GPUBuffer | null = null;
  private hitboxBindGroup: GPUBindGroup | null = null;
  private hitboxBindGroups: GPUBindGroup[] = [];
  private hitboxEntryCount = 0;
  private hitboxLineWidth = 3.0;
  private showHitboxes = false;

  constructor(ctx: EntityRenderContext) {
    this.ctx = ctx;
  }

  init(pipelineLayout: GPUPipelineLayout): void {
    const device = this.ctx.device;
    const format = this.ctx.format;

    // Build quad vertices for 12 cube edges × 4 corners = 48 vertices
    const cubeEdges: number[][] = [
      [-0.5, -0.5, -0.5,  0.5, -0.5, -0.5],
      [ 0.5, -0.5, -0.5,  0.5, -0.5,  0.5],
      [ 0.5, -0.5,  0.5, -0.5, -0.5,  0.5],
      [-0.5, -0.5,  0.5, -0.5, -0.5, -0.5],
      [-0.5,  0.5, -0.5,  0.5,  0.5, -0.5],
      [ 0.5,  0.5, -0.5,  0.5,  0.5,  0.5],
      [ 0.5,  0.5,  0.5, -0.5,  0.5,  0.5],
      [-0.5,  0.5,  0.5, -0.5,  0.5, -0.5],
      [-0.5, -0.5, -0.5, -0.5,  0.5, -0.5],
      [ 0.5, -0.5, -0.5,  0.5,  0.5, -0.5],
      [ 0.5, -0.5,  0.5,  0.5,  0.5,  0.5],
      [-0.5, -0.5,  0.5, -0.5,  0.5,  0.5],
    ];
    const cornerVecs: number[][] = [[0, -1], [0, 1], [1, 1], [1, -1]];
    const quadVerts = new Float32Array(12 * 4 * 8);
    let qv = 0;
    for (let ei = 0; ei < 12; ei++) {
      const e = cubeEdges[ei];
      for (let ci = 0; ci < 4; ci++) {
        quadVerts[qv++] = e[0]; quadVerts[qv++] = e[1]; quadVerts[qv++] = e[2];
        quadVerts[qv++] = e[3]; quadVerts[qv++] = e[4]; quadVerts[qv++] = e[5];
        quadVerts[qv++] = cornerVecs[ci][0]; quadVerts[qv++] = cornerVecs[ci][1];
      }
    }
    const quadIndices = new Uint16Array(12 * 6);
    let qi = 0;
    for (let ei = 0; ei < 12; ei++) {
      const b = ei * 4;
      quadIndices[qi++] = b + 0; quadIndices[qi++] = b + 1; quadIndices[qi++] = b + 2;
      quadIndices[qi++] = b + 0; quadIndices[qi++] = b + 2; quadIndices[qi++] = b + 3;
    }
    this.hitboxQuadIndexCount = quadIndices.length;

    const dev = device;

    // Hitbox uniform buffer — separate from entity uniform buffer
    this.hitboxUniformBuffer = dev.createBuffer({
      size: 256 * MAX_HITBOX_ENTRIES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const hitboxBindGroupLayout = dev.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true } },
      ],
    });

    this.hitboxBindGroup = dev.createBindGroup({
      layout: hitboxBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.hitboxUniformBuffer, size: 256 } }],
    });
    // Per-entry bind groups for native mode (no dynamic offset support).
    // Cap at 256 to avoid excessive resource creation (hitboxes are debug-only).
    this.hitboxBindGroups = [];
    for (let i = 0; i < 256; i++) {
      this.hitboxBindGroups.push(dev.createBindGroup({
        layout: hitboxBindGroupLayout,
        entries: [{ binding: 0, resource: { buffer: this.hitboxUniformBuffer, offset: i * 256, size: 256 } }],
      }));
    }

    const hitboxLayout = dev.createPipelineLayout({
      bindGroupLayouts: [hitboxBindGroupLayout],
    });

    const hitboxShaderModule = createValidatedShaderModule(dev, { code: HITBOX_WGSL, label: "HitboxRenderer.hitbox" });
    this.hitboxPipeline = dev.createRenderPipeline({
      layout: hitboxLayout,
      vertex: {
        module: hitboxShaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 32,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x2" },
          ],
        }],
      },
      fragment: {
        module: hitboxShaderModule,
        entryPoint: "fs_main",
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: "less",
      },
    });

    this.hitboxQuadVertices = dev.createBuffer({
      size: quadVerts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    dev.queue.writeBuffer(this.hitboxQuadVertices as any, 0, quadVerts);
    this.hitboxQuadIndices = dev.createBuffer({
      size: quadIndices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    dev.queue.writeBuffer(this.hitboxQuadIndices as any, 0, quadIndices);

    // Island wireframe pipeline
    const islandWireframeModule = createValidatedShaderModule(dev, { code: ISLAND_WIREFRAME_WGSL, label: "HitboxRenderer.islandWireframe" });
    this.islandWireframePipeline = dev.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: islandWireframeModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 36,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
          ],
        }],
      },
      fragment: {
        module: islandWireframeModule,
        entryPoint: "fs_main",
        targets: [{ format }],
      },
      primitive: { topology: "line-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: "less",
      },
    });
  }

  setShowHitboxes(show: boolean): void {
    this.showHitboxes = show;
  }

  isHitboxVisible(): boolean {
    return this.showHitboxes;
  }

  setHitboxLineWidth(width: number): void {
    this.hitboxLineWidth = Math.max(1, width);
  }

  getHitboxLineWidth(): number {
    return this.hitboxLineWidth;
  }

  getEntryCount(): number {
    return this.hitboxEntryCount;
  }

  resetEntryCount(): void {
    this.hitboxEntryCount = 0;
  }

  writeHitboxEntry(
    localCx: number, localCy: number, localCz: number,
    halfX: number, halfY: number, halfZ: number,
    pos: { x: number; y: number; z: number },
    rotation: { x: number; y: number; z: number; w: number },
    color: [number, number, number] = [0.0, 1.0, 0.2],
  ): void {
    const ctx = this.ctx;
    if (this.hitboxEntryCount >= MAX_HITBOX_ENTRIES) return;
    if (!this.hitboxUniformBuffer || !ctx.viewProjCache) return;

    const rx = rotation.x, ry = rotation.y, rz = rotation.z, rw = rotation.w;
    const cx1 = ry * localCz - rz * localCy;
    const cy1 = rz * localCx - rx * localCz;
    const cz1 = rx * localCy - ry * localCx;
    const cx2 = ry * cz1 - rz * cy1 + rw * cx1;
    const cy2 = rz * cx1 - rx * cz1 + rw * cy1;
    const cz2 = rx * cy1 - ry * cx1 + rw * cz1;
    const worldCx = localCx + 2 * cx2;
    const worldCy = localCy + 2 * cy2;
    const worldCz = localCz + 2 * cz2;

    const hbUniforms = ctx.reusableHbUniforms;
    for (let i = 0; i < 16; i++) hbUniforms[i] = ctx.viewProjCache[i];
    hbUniforms[16] = ctx.cameraPosCache[0];
    hbUniforms[17] = ctx.cameraPosCache[1];
    hbUniforms[18] = ctx.cameraPosCache[2];
    hbUniforms[19] = performance.now() / 1000;
    hbUniforms[20] = pos.x + worldCx;
    hbUniforms[21] = pos.y + worldCy;
    hbUniforms[22] = pos.z + worldCz;
    hbUniforms[23] = 0;
    hbUniforms[24] = halfX;
    hbUniforms[25] = halfY;
    hbUniforms[26] = halfZ;
    hbUniforms[27] = 0;
    hbUniforms[28] = rx;
    hbUniforms[29] = ry;
    hbUniforms[30] = rz;
    hbUniforms[31] = rw;
    hbUniforms[32] = ctx.viewportWidth;
    hbUniforms[33] = ctx.viewportHeight;
    hbUniforms[34] = this.hitboxLineWidth;
    hbUniforms[35] = 0;
    hbUniforms[36] = color[0];
    hbUniforms[37] = color[1];
    hbUniforms[38] = color[2];
    this.ctx.device.queue.writeBuffer(this.hitboxUniformBuffer!, this.hitboxEntryCount * 256, hbUniforms as any);
    this.hitboxEntryCount++;
  }

  writeInstancedHitbox(
    pos: { x: number; y: number; z: number },
    scale: number,
    rotation: { x: number; y: number; z: number; w: number },
  ): void {
    this.writeHitboxEntry(0, 0, 0, scale, scale, scale, pos, rotation);
  }

  render(
    passEncoder: GPURenderPassEncoder,
    islandMeshes: Map<string, IslandWireframeRef>,
  ): void {
    const ctx = this.ctx;
    if (!this.showHitboxes || !this.hitboxPipeline || !this.hitboxQuadVertices || !this.hitboxQuadIndices || !this.hitboxBindGroup || !this.hitboxUniformBuffer) return;

    passEncoder.setPipeline(this.hitboxPipeline);
    passEncoder.setVertexBuffer(0, this.hitboxQuadVertices);
    passEncoder.setIndexBuffer(this.hitboxQuadIndices, "uint16");

    for (let i = 0; i < this.hitboxEntryCount; i++) {
      const hBg = this.hitboxBindGroups[i] ?? this.hitboxBindGroup;
      if (this.hitboxBindGroups.length > 0) passEncoder.setBindGroup(0, hBg);
      else passEncoder.setBindGroup(0, hBg!, [i * 256]);
      passEncoder.drawIndexed(this.hitboxQuadIndexCount);
    }

    // Render island wireframe hitboxes
    if (this.islandWireframePipeline && ctx.bindGroup) {
      passEncoder.setPipeline(this.islandWireframePipeline);
      for (let i = 0; i < ctx.drawEntityCount; i++) {
        if (ctx.drawEntityTypes[i] === EntityType.Island) {
          const chunkX = ctx.drawEntityChunkX[i] ?? 0;
          const chunkZ = ctx.drawEntityChunkZ[i] ?? 0;
          const islandKey = `${chunkX},${chunkZ}`;
          const islandMesh = islandMeshes.get(islandKey);
          if (islandMesh && islandMesh.lineIndices && islandMesh.lineIndexCount > 0) {
            passEncoder.setVertexBuffer(0, islandMesh.vertices);
            passEncoder.setIndexBuffer(islandMesh.lineIndices, islandMesh.useUint32 ? "uint32" : "uint16");
            const wBg = ctx.bindGroups?.[i] ?? ctx.bindGroup;
            if (ctx.bindGroups) passEncoder.setBindGroup(0, wBg);
            else passEncoder.setBindGroup(0, wBg!, [i * 256]);
            passEncoder.drawIndexed(islandMesh.lineIndexCount);
          }
        }
      }
    }
  }
}
