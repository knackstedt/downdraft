import { DEPTH_FORMAT, MSAA_SAMPLE_COUNT } from "@downdraft/core";
import { BOAT_CELL_WORLD_SIZE, BOAT_LAYER_HEIGHT, BoatCellType } from "@shared/constants";
import type { BoatBufferReader } from "@to-the-ocean/library-boats/boat-sab";
import { HOLO_WGSL } from "../shaders/entity-shaders";
import type { EntityRenderContext } from "./render-context";

interface CellInfo {
  type: number;
  rotation: number;
  gridX: number;
  gridY: number;
  gridZ: number;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
}

export interface HoloMeshDeps {
  bedMeshVerts: number[];
  bedMeshIdx: number[];
  bedMeshVertCount: number;
  generateCellMesh: (cell: CellInfo, cellMap: Map<string, CellInfo>, verts: number[], idx: number[], baseVi: number) => void;
  generateFBXCellMesh: (cell: CellInfo, cellMap: Map<string, CellInfo>, srcVerts: number[], srcIdx: number[], verts: number[], idx: number[], baseVi: number) => void;
  genDeleteXCell: (cx: number, cy: number, cz: number, s: number, verts: number[], idx: number[], baseVi: number) => void;
}

export class HoloPreviewRenderer {
  private ctx: EntityRenderContext;
  private deps: HoloMeshDeps | null = null;

  private holoPipeline: GPURenderPipeline | null = null;
  private holoVertices: GPUBuffer | null = null;
  private holoIndices: GPUBuffer | null = null;
  private holoVertCapacity = 0;
  private holoIndexCapacity = 0;

  private holoVertsBuf: number[] = [];
  private holoIdxBuf: number[] = [];
  private holoEmptyCellMap = new Map<string, CellInfo>();

  private boatBufferReader: BoatBufferReader | null = null;

  constructor(ctx: EntityRenderContext) {
    this.ctx = ctx;
  }

  setMeshDeps(deps: HoloMeshDeps): void {
    this.deps = deps;
  }

  setBoatBufferReader(reader: BoatBufferReader | null): void {
    this.boatBufferReader = reader;
  }

  init(litPipelineLayout: GPUPipelineLayout): void {
    const device = this.ctx.device;
    const format = this.ctx.format;

    const dev = device;
    const holoShaderModule = dev.createShaderModule({ code: HOLO_WGSL });
    this.holoPipeline = dev.createRenderPipeline({
      layout: litPipelineLayout,
      vertex: {
        module: holoShaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 36,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x3" },
          ],
        }],
      },
      fragment: {
        module: holoShaderModule,
        entryPoint: "fs_main",
        targets: [{
          format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: "less",
      },
    });

    this.holoVertices = dev.createBuffer({
      size: 128 * 36,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.holoVertCapacity = 128;
    this.holoIndices = dev.createBuffer({
      size: 192 * 2,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.holoIndexCapacity = 192;
  }

  private ensureHoloCapacity(neededVerts: number, neededIndices: number): boolean {
    if (neededVerts <= this.holoVertCapacity && neededIndices <= this.holoIndexCapacity) return true;
    if (!this.holoVertices || !this.holoIndices) return false;
    const newVertCap = Math.max(neededVerts, this.holoVertCapacity * 2);
    const newIndexCap = Math.max(neededIndices, this.holoIndexCapacity * 2);
    this.holoVertices.destroy();
    this.holoIndices.destroy();
    const dev = this.ctx.device;
    this.holoVertices = dev.createBuffer({ size: newVertCap * 36, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.holoIndices = dev.createBuffer({ size: newIndexCap * 2, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.holoVertCapacity = newVertCap;
    this.holoIndexCapacity = newIndexCap;
    return true;
  }

  render(
    passEncoder: GPURenderPassEncoder,
    shipPos: { x: number; y: number; z: number },
    shipRot: { x: number; y: number; z: number; w: number },
  ): void {
    const ctx = this.ctx;
    if (!this.holoPipeline || !this.holoVertices || !this.holoIndices || !ctx.bindGroup || !ctx.uniformBuffer || !ctx.viewProjCache) return;
    if (!this.boatBufferReader || !this.boatBufferReader.isValid()) return;
    if (!this.deps) return;

    const preview = this.boatBufferReader.getPreview();
    if (!preview.visible) return;

    const localX = preview.gridX * BOAT_CELL_WORLD_SIZE;
    const localZ = preview.gridZ * BOAT_CELL_WORLD_SIZE;
    const localY = preview.gridY * BOAT_LAYER_HEIGHT;

    const q = shipRot;
    const rx = q.x, ry = q.y, rz = q.z, rw = q.w;
    const vx = localX, vy = localY, vz = localZ;
    const cx1 = ry * vz - rz * vy;
    const cy1 = rz * vx - rx * vz;
    const cz1 = rx * vy - ry * vx;
    const cx2 = ry * cz1 - rz * cy1 + rw * cx1;
    const cy2 = rz * cx1 - rx * cz1 + rw * cy1;
    const cz2 = rx * cy1 - ry * cx1 + rw * cz1;
    const worldLocalX = vx + 2 * cx2;
    const worldLocalY = vy + 2 * cy2;
    const worldLocalZ = vz + 2 * cz2;

    const holoPos = { x: shipPos.x + worldLocalX, y: shipPos.y + worldLocalY, z: shipPos.z + worldLocalZ };

    const s = BOAT_CELL_WORLD_SIZE / 2;
    const cx = 0, cy = 0, cz = 0;
    const cellType = preview.cellType;

    const holoVerts = this.holoVertsBuf;
    const holoIndices = this.holoIdxBuf;
    holoVerts.length = 0;
    holoIndices.length = 0;
    const baseVi = 0;

    if (cellType === 255) {
      this.deps.genDeleteXCell(cx, cy, cz, s, holoVerts, holoIndices, baseVi);
    } else {
      const dummyCell: CellInfo = {
        type: cellType,
        rotation: preview.rotation ?? 0,
        gridX: 0, gridY: 0, gridZ: 0,
        sizeX: cellType === BoatCellType.BED ? 1 : 1,
        sizeY: cellType === BoatCellType.BED ? 1 : 1,
        sizeZ: cellType === BoatCellType.BED ? 2 : 1,
      };
      if (cellType === BoatCellType.BED && this.deps.bedMeshVertCount > 0) {
        this.deps.generateFBXCellMesh(dummyCell, this.holoEmptyCellMap, this.deps.bedMeshVerts, this.deps.bedMeshIdx, holoVerts, holoIndices, baseVi);
      } else {
        this.deps.generateCellMesh(dummyCell, this.holoEmptyCellMap, holoVerts, holoIndices, baseVi);
      }
    }

    const neededVerts = holoVerts.length / 9;
    const neededIndices = holoIndices.length;
    if (!this.ensureHoloCapacity(neededVerts, neededIndices)) return;

    const queue = ctx.device.queue;
    const vertData = new Float32Array(holoVerts);
    queue.writeBuffer(this.holoVertices!, 0, vertData as any);
    const idxData = new Uint16Array(holoIndices);
    queue.writeBuffer(this.holoIndices!, 0, idxData as any);
    const indexCount = holoIndices.length;

    const holoIdx = 511;
    const offset = holoIdx * 256;
    const uniforms = ctx.reusableUniforms;
    for (let i = 0; i < 16; i++) uniforms[i] = ctx.viewProjCache[i];
    uniforms[16] = ctx.cameraPosCache[0];
    uniforms[17] = ctx.cameraPosCache[1];
    uniforms[18] = ctx.cameraPosCache[2];
    uniforms[19] = performance.now() / 1000;
    uniforms[20] = holoPos.x;
    uniforms[21] = holoPos.y;
    uniforms[22] = holoPos.z;
    uniforms[23] = 1;
    uniforms[24] = shipRot.x;
    uniforms[25] = shipRot.y;
    uniforms[26] = shipRot.z;
    uniforms[27] = shipRot.w;
    const holoDv = new DataView(uniforms.buffer);
    holoDv.setUint32(112, 0, true);
    const lp = ctx.lightingParamsCache;
    uniforms[30] = 0;
    uniforms[31] = 0;
    uniforms[32] = lp.sunDir[0];
    uniforms[33] = lp.sunDir[1];
    uniforms[34] = lp.sunDir[2];
    uniforms[35] = lp.sunIntensity;
    uniforms[36] = lp.ambient;
    uniforms[37] = 0;
    uniforms[38] = 0;
    uniforms[39] = 0;
    uniforms[40] = lp.fogColor[0];
    uniforms[41] = lp.fogColor[1];
    uniforms[42] = lp.fogColor[2];
    uniforms[43] = 0;
    queue.writeBuffer(ctx.uniformBuffer!, offset, uniforms as any);

    passEncoder.setPipeline(this.holoPipeline);
    const hBg = ctx.bindGroups?.[holoIdx] ?? ctx.bindGroup;
    if (ctx.bindGroups) passEncoder.setBindGroup(0, hBg);
    else passEncoder.setBindGroup(0, hBg!, [holoIdx * 256]);
    passEncoder.setVertexBuffer(0, this.holoVertices!);
    passEncoder.setIndexBuffer(this.holoIndices!, "uint16");
    passEncoder.drawIndexed(indexCount);
  }
}
