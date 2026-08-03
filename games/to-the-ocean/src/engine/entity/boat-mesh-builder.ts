import { BoatBufferReader, MAX_BOATS, MAX_CELLS_PER_BOAT } from "@shared/boat-buffer";
import { RuntimeBoatGeometry, type BoatDesign } from "@shared/boat-design";
import { BOAT_CELL_WORLD_SIZE, BOAT_LAYER_HEIGHT, BoatCellType, WALL_THICKNESS, getCellGeometry, isWallType } from "@shared/constants";
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

interface Shape2D {
  polygon: [number, number][];
  edges: { dir: number; p0: number; p1: number }[];
}

const DIR_OFFSETS: [number, number, number][] = [
  [0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 1, 0], [0, -1, 0],
];

const CELL_COLORS: Record<number, [number, number, number]> = {
  [BoatCellType.HULL]: [0.45, 0.35, 0.25],
  [BoatCellType.BOW]: [0.55, 0.40, 0.28],
  [BoatCellType.CABIN]: [0.60, 0.48, 0.30],
  [BoatCellType.MAST]: [0.35, 0.25, 0.15],
  [BoatCellType.DECK]: [0.50, 0.38, 0.22],
  [BoatCellType.RAIL]: [0.40, 0.30, 0.20],
  [BoatCellType.WALL_STRAIGHT]: [0.50, 0.35, 0.20],
  [BoatCellType.WALL_CORNER]: [0.52, 0.36, 0.21],
  [BoatCellType.WALL_CURVED]: [0.48, 0.34, 0.19],
  [BoatCellType.WALL_DIAGONAL]: [0.51, 0.35, 0.20],
  [BoatCellType.HULL_CURVE_L]: [0.42, 0.32, 0.22],
  [BoatCellType.HULL_CURVE_R]: [0.42, 0.32, 0.22],
  [BoatCellType.BOW_MODERN]: [0.50, 0.38, 0.25],
  [BoatCellType.STERN]: [0.48, 0.36, 0.24],
  [BoatCellType.PONTOON]: [0.35, 0.30, 0.28],
  [BoatCellType.BRIDGE]: [0.50, 0.38, 0.22],
  [BoatCellType.HELM]: [0.55, 0.45, 0.30],
  [BoatCellType.LARGE_SAIL]: [0.85, 0.82, 0.75],
  [BoatCellType.BED]: [0.50, 0.35, 0.25],
};

export class BoatMeshBuilder {
  private ctx: EntityRenderContext;

  boatVertices: GPUBuffer | null = null;
  boatIndices: GPUBuffer | null = null;
  boatIndexCount = 0;
  boatVertOffsets: number[] = [];
  boatIndexOffsets: number[] = [];
  boatIndexCounts: number[] = [];

  private boatBufferReader: BoatBufferReader | null = null;
  private boatDesigns: Map<number, { design: BoatDesign; geometry: RuntimeBoatGeometry }> | null = null;
  private boatMeshDirty = true;
  private lastBoatSeq = -1;

  // Bed model mesh (loaded from FBX, pre-converted to boat vertex format)
  bedMeshVerts: number[] = [];
  bedMeshIdx: number[] = [];
  bedMeshVertCount = 0;

  // Reusable arrays
  private boatAllVerts: number[] = [];
  private boatAllIdx: number[] = [];
  private boatSlotVerts: number[] = [];
  private boatSlotIdx: number[] = [];
  private boatCellMap = new Map<string, CellInfo>();
  private boatSeenSet = new Set<string>();

  constructor(ctx: EntityRenderContext) {
    this.ctx = ctx;
  }

  init(): void {
    const device = this.ctx.device;
    const maxBoatVerts = MAX_BOATS * MAX_CELLS_PER_BOAT * 48 * 6;
    this.boatVertices = device.createBuffer({
      size: Math.max(4, maxBoatVerts * 36),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.boatIndices = device.createBuffer({
      size: Math.max(4, maxBoatVerts * 6 * 2),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
  }

  setBoatBufferReader(reader: BoatBufferReader | null): void {
    this.boatBufferReader = reader;
    this.boatMeshDirty = true;
  }

  setBoatDesigns(designs: Map<number, { design: BoatDesign; geometry: RuntimeBoatGeometry }>): void {
    this.boatDesigns = designs;
    this.boatMeshDirty = true;
  }

  loadBedMesh(verts: number[], idx: number[]): void {
    this.bedMeshVerts = verts;
    this.bedMeshIdx = idx;
    this.bedMeshVertCount = verts.length / 9;
    this.boatMeshDirty = true;
  }

  checkSequenceAndRebuild(): void {
    if (this.boatBufferReader && this.boatBufferReader.isValid()) {
      const seq = this.boatBufferReader.getSequence();
      if (seq !== this.lastBoatSeq) {
        this.lastBoatSeq = seq;
        this.boatMeshDirty = true;
      }
    }
    if (this.boatMeshDirty && this.boatBufferReader && this.boatBufferReader.isValid()) {
      this.rebuildBoatMesh();
      this.boatMeshDirty = false;
    }
  }

  isBoatBufferValid(): boolean {
    return this.boatBufferReader?.isValid() ?? false;
  }

  getBoatBufferReader(): BoatBufferReader | null {
    return this.boatBufferReader;
  }

  renderBoat(passEncoder: GPURenderPassEncoder, pipeline: GPURenderPipeline, idx: number, boatSlot: number): number {
    const ctx = this.ctx;
    if (!ctx.bindGroup || !this.boatVertices || !this.boatIndices) return 0;
    const vertOffset = this.boatVertOffsets[boatSlot] ?? 0;
    const idxOffset = this.boatIndexOffsets[boatSlot] ?? 0;
    const idxCount = this.boatIndexCounts[boatSlot] ?? 0;
    if (idxCount === 0) return 0;

    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, ctx.bindGroup, [idx * 256]);
    passEncoder.setVertexBuffer(0, this.boatVertices);
    passEncoder.setIndexBuffer(this.boatIndices, "uint16");
    passEncoder.drawIndexed(idxCount, 1, idxOffset, vertOffset);
    return Math.floor(idxCount / 3);
  }

  // --- Mesh generation methods (exposed for HoloPreviewRenderer) ---

  generateCellMesh(cell: CellInfo, cellMap: Map<string, CellInfo>, verts: number[], idx: number[], baseVi: number): void {
    const cy = cell.gridY * BOAT_LAYER_HEIGHT;
    const h = getCellGeometry(cell.type);
    const y0 = cy + h.y0;
    const y1 = cy + h.y1 + (cell.sizeY > 1 ? (cell.sizeY - 1) * BOAT_LAYER_HEIGHT : 0);

    const color = CELL_COLORS[cell.type] ?? [0.5, 0.5, 0.5];
    const shape = this.getCellShape(cell);
    const poly = shape.polygon;
    const sx = cell.sizeX || 1;
    const sz = cell.sizeZ || 1;
    const cx = cell.gridX * BOAT_CELL_WORLD_SIZE + (sx - 1) * BOAT_CELL_WORLD_SIZE / 2;
    const cz = cell.gridZ * BOAT_CELL_WORLD_SIZE + (sz - 1) * BOAT_CELL_WORLD_SIZE / 2;
    let vi = baseVi;

    const hasNeighbor = (dir: number): boolean => {
      if (dir < 0) return false;
      const [dx, dy, dz] = DIR_OFFSETS[dir];
      return cellMap.has(`${cell.gridX + dx},${cell.gridY + dy},${cell.gridZ + dz}`);
    };

    const neighborCoversFace = (dir: number): boolean => {
      if (dir < 0) return false;
      const [dx, dy, dz] = DIR_OFFSETS[dir];
      const neighbor = cellMap.get(`${cell.gridX + dx},${cell.gridY + dy},${cell.gridZ + dz}`);
      if (!neighbor) return false;
      const nh = getCellGeometry(neighbor.type);
      const ncy = neighbor.gridY * BOAT_LAYER_HEIGHT;
      const ny0 = ncy + nh.y0;
      const ny1 = ncy + nh.y1 + (neighbor.sizeY > 1 ? (neighbor.sizeY - 1) * BOAT_LAYER_HEIGHT : 0);
      // Walls have thin XZ footprints — they don't cover the full face of
      // a neighboring cell in any direction, so never cull for wall neighbors.
      if (isWallType(neighbor.type)) return false;
      // Hull types have narrowed bottoms (vScale=0.55) — the neighbor above
      // doesn't cover the full top face of the current cell.
      if (dir === 4 && isHullType(neighbor.type)) return false;
      if (dir === 4) return ny0 <= y1 + 0.01;
      if (dir === 5) return ny1 >= y0 - 0.01;
      return ny0 <= y0 + 0.01 && ny1 >= y1 - 0.01;
    };

    const isHullType = (t: number) =>
      t === BoatCellType.HULL || t === BoatCellType.BOW || t === BoatCellType.BOW_MODERN ||
      t === BoatCellType.HULL_CURVE_L || t === BoatCellType.HULL_CURVE_R ||
      t === BoatCellType.STERN || t === BoatCellType.PONTOON;
    const isHull = isHullType(cell.type);

    const vertexIsOuter: boolean[] = poly.map((_, i) => {
      const adj = shape.edges.filter(e => e.p0 === i || e.p1 === i);
      return adj.length > 0 && adj.every(e => !hasNeighbor(e.dir) && e.dir >= 0);
    });

    const vScale = isHull ? 0.55 : 1.0;

    const bottomPoly: [number, number][] = poly.map(([px, pz], i) => {
      if (isHull && vertexIsOuter[i]) {
        return [cx + (px - cx) * vScale, cz + (pz - cz) * vScale] as [number, number];
      }
      return [px, pz] as [number, number];
    });

    const topY: number[] = poly.map(([px, pz], i) => {
      let y = y1;
      if (isHull) {
        const distFromMid = Math.abs(pz);
        y += Math.max(0, distFromMid - 2) * 0.05;
        if ((cell.type === BoatCellType.BOW || cell.type === BoatCellType.BOW_MODERN) && i === 0) y += 0.6;
      }
      return y;
    });

    if (!neighborCoversFace(4) && y1 > y0) {
      for (let i = 1; i < poly.length - 1; i++) {
        vi = this.addTri(verts, idx, vi,
          [poly[0][0], topY[0], poly[0][1]],
          [poly[i][0], topY[i], poly[i][1]],
          [poly[i + 1][0], topY[i + 1], poly[i + 1][1]],
          [0, 1, 0], color);
      }
    } else if (!neighborCoversFace(4) && y1 === y0) {
      for (let i = 1; i < poly.length - 1; i++) {
        vi = this.addTri(verts, idx, vi,
          [poly[0][0], y1, poly[0][1]],
          [poly[i][0], y1, poly[i][1]],
          [poly[i + 1][0], y1, poly[i + 1][1]],
          [0, 1, 0], color);
      }
    }

    if (!neighborCoversFace(5) && y1 > y0) {
      for (let i = 1; i < bottomPoly.length - 1; i++) {
        vi = this.addTri(verts, idx, vi,
          [bottomPoly[0][0], y0, bottomPoly[0][1]],
          [bottomPoly[i + 1][0], y0, bottomPoly[i + 1][1]],
          [bottomPoly[i][0], y0, bottomPoly[i][1]],
          [0, -1, 0], color);
      }
    }

    if (y1 <= y0) return;
    for (const edge of shape.edges) {
      if (neighborCoversFace(edge.dir)) continue;
      const i0 = edge.p0, i1 = edge.p1;
      const [bx0, bz0] = bottomPoly[i0];
      const [bx1, bz1] = bottomPoly[i1];
      const [tx0, tz0] = poly[i0];
      const [tx1, tz1] = poly[i1];
      const v1x = bx1 - bx0, v1y = 0, v1z = bz1 - bz0;
      const v2x = tx0 - bx0, v2y = topY[i0] - y0, v2z = tz0 - bz0;
      const nx = v1y * v2z - v1z * v2y;
      const ny = v1z * v2x - v1x * v2z;
      const nz = v1x * v2y - v1y * v2x;
      const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      vi = this.addQuad(verts, idx, vi,
        [bx0, y0, bz0], [bx1, y0, bz1],
        [tx1, topY[i1], tz1], [tx0, topY[i0], tz0],
        [nx / nlen, ny / nlen, nz / nlen], color);
    }
  }

  generateFBXCellMesh(
    cell: CellInfo, cellMap: Map<string, CellInfo>,
    srcVerts: number[], srcIdx: number[],
    verts: number[], idx: number[], baseVi: number,
  ): void {
    const stride = 9;
    const rot = cell.rotation % 4;
    const cosA = rot > 0 ? Math.cos(rot * Math.PI / 2) : 1;
    const sinA = rot > 0 ? Math.sin(rot * Math.PI / 2) : 0;
    const sx = cell.sizeX || 1;
    const sz = cell.sizeZ || 1;
    const cx = cell.gridX * BOAT_CELL_WORLD_SIZE + (sx - 1) * BOAT_CELL_WORLD_SIZE / 2;
    const cz = cell.gridZ * BOAT_CELL_WORLD_SIZE + (sz - 1) * BOAT_CELL_WORLD_SIZE / 2;

    let floorY = cell.gridY * BOAT_LAYER_HEIGHT;
    const belowKey = `${cell.gridX},${cell.gridY - 1},${cell.gridZ}`;
    const below = cellMap.get(belowKey);
    if (below) {
      const bh = getCellGeometry(below.type);
      const bcy = below.gridY * BOAT_LAYER_HEIGHT;
      const belowTop = bcy + bh.y1 + (below.sizeY > 1 ? (below.sizeY - 1) * BOAT_LAYER_HEIGHT : 0);
      floorY = belowTop;
    }

    const vCount = srcVerts.length / stride;
    for (let i = 0; i < vCount; i++) {
      let px = srcVerts[i * stride];
      let py = srcVerts[i * stride + 1];
      let pz = srcVerts[i * stride + 2];
      let nx = srcVerts[i * stride + 3];
      let ny = srcVerts[i * stride + 4];
      let nz = srcVerts[i * stride + 5];
      const r = srcVerts[i * stride + 6];
      const g = srcVerts[i * stride + 7];
      const b = srcVerts[i * stride + 8];
      if (rot > 0) {
        const rx = px * cosA - pz * sinA;
        const rz = px * sinA + pz * cosA;
        px = rx; pz = rz;
        const rnx = nx * cosA - nz * sinA;
        const rnz = nx * sinA + nz * cosA;
        nx = rnx; nz = rnz;
      }
      verts.push(px + cx, py + floorY, pz + cz, nx, ny, nz, r, g, b);
    }
    for (let i = 0; i < srcIdx.length; i++) idx.push(srcIdx[i] + baseVi);
  }

  genDeleteXCell(cx: number, cy: number, cz: number, s: number, verts: number[], idx: number[], baseVi: number): void {
    const red: [number, number, number] = [1.0, 0.15, 0.15];
    const yMid = cy + BOAT_LAYER_HEIGHT / 2;
    const t = s * 0.12;
    const y0 = yMid - t, y1 = yMid + t;
    let vi = baseVi;
    vi = this.addQuad(verts, idx, vi, [cx - s, y0, cz - s], [cx + s, y0, cz + s], [cx + s, y1, cz + s], [cx - s, y1, cz - s], [0, 1, 0], red);
    vi = this.addQuad(verts, idx, vi, [cx - s, y1, cz - s], [cx + s, y1, cz + s], [cx + s, y0, cz + s], [cx - s, y0, cz - s], [0, -1, 0], red);
    vi = this.addQuad(verts, idx, vi, [cx - s, y0, cz + s], [cx + s, y0, cz - s], [cx + s, y1, cz - s], [cx - s, y1, cz + s], [0, 1, 0], red);
    vi = this.addQuad(verts, idx, vi, [cx - s, y1, cz + s], [cx + s, y1, cz - s], [cx + s, y0, cz - s], [cx - s, y0, cz + s], [0, -1, 0], red);
  }

  // --- Private helpers ---

  private rebuildBoatMesh(): void {
    if (!this.boatBufferReader || !this.boatVertices || !this.boatIndices) return;
    const queue = this.ctx.device.queue;
    const boatCount = this.boatBufferReader.getBoatCount();
    const allVerts = this.boatAllVerts;
    const allIdx = this.boatAllIdx;
    allVerts.length = 0;
    allIdx.length = 0;
    this.boatVertOffsets = [];
    this.boatIndexOffsets = [];
    this.boatIndexCounts = [];

    for (let slot = 0; slot < boatCount; slot++) {
      const vertOffset = allVerts.length / 9;
      const idxOffset = allIdx.length;
      this.boatVertOffsets[slot] = vertOffset;
      this.boatIndexOffsets[slot] = idxOffset;

      const entityId = this.boatBufferReader.getBoatEntityId(slot);
      const designEntry = this.boatDesigns?.get(entityId);
      const slotVerts = this.boatSlotVerts;
      const slotIdx = this.boatSlotIdx;
      slotVerts.length = 0;
      slotIdx.length = 0;

      if (designEntry) {
        this.generateDesignMesh(designEntry.geometry, slotVerts, slotIdx, 0);
      } else {
        const cells = this.boatBufferReader.getBoatCells(slot);
        if (cells.length === 0) { this.boatIndexCounts[slot] = 0; continue; }
        const cellMap = this.boatCellMap;
        cellMap.clear();
        for (let ci = 0; ci < cells.length; ci++) {
          const c = cells[ci];
          for (let sx = 0; sx < c.sizeX; sx++) {
            for (let sy = 0; sy < c.sizeY; sy++) {
              for (let sz = 0; sz < c.sizeZ; sz++) {
                cellMap.set(`${c.gridX + sx},${c.gridY + sy},${c.gridZ + sz}`, c);
              }
            }
          }
        }
        const seen = this.boatSeenSet;
        seen.clear();
        for (let ci = 0; ci < cells.length; ci++) {
          const cell = cells[ci];
          const originKey = `${cell.gridX},${cell.gridY},${cell.gridZ}`;
          if (seen.has(originKey)) continue;
          seen.add(originKey);
          const baseVi = slotVerts.length / 9;
          if (cell.type === BoatCellType.BED && this.bedMeshVertCount > 0) {
            this.generateFBXCellMesh(cell, cellMap, this.bedMeshVerts, this.bedMeshIdx, slotVerts, slotIdx, baseVi);
          } else {
            this.generateCellMesh(cell, cellMap, slotVerts, slotIdx, baseVi);
          }
        }
      }

      for (let i = 0; i < slotIdx.length; i++) allIdx.push(slotIdx[i] + vertOffset);
      for (let i = 0; i < slotVerts.length; i++) allVerts.push(slotVerts[i]);
      this.boatIndexCounts[slot] = slotIdx.length;
    }

    if (allVerts.length === 0) { this.boatIndexCount = 0; return; }
    const vertData = new Float32Array(allVerts);
    const idxData = new Uint16Array(allIdx);
    queue.writeBuffer(this.boatVertices!, 0, vertData as any);
    if (idxData.byteLength % 4 !== 0) {
      const padded = new Uint16Array(allIdx.length + 1);
      padded.set(idxData);
      queue.writeBuffer(this.boatIndices!, 0, padded as any);
    } else {
      queue.writeBuffer(this.boatIndices!, 0, idxData as any);
    }
    this.boatIndexCount = idxData.length;
  }

  private generateDesignMesh(geometry: RuntimeBoatGeometry, verts: number[], idx: number[], baseVi: number): void {
    const { positions, normals, indices } = geometry.getMeshBuffers();
    const color: [number, number, number] = [0.45, 0.35, 0.25];
    const vCount = positions.length / 3;
    for (let i = 0; i < vCount; i++) {
      verts.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      verts.push(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
      verts.push(color[0], color[1], color[2]);
    }
    for (let i = 0; i < indices.length; i++) idx.push(baseVi + indices[i]);
  }

  private getCellShape(cell: CellInfo): Shape2D {
    const sx = cell.sizeX || 1;
    const sz = cell.sizeZ || 1;
    const halfX = (sx * BOAT_CELL_WORLD_SIZE) / 2;
    const halfZ = (sz * BOAT_CELL_WORLD_SIZE) / 2;
    const cx = cell.gridX * BOAT_CELL_WORLD_SIZE + (sx - 1) * BOAT_CELL_WORLD_SIZE / 2;
    const cz = cell.gridZ * BOAT_CELL_WORLD_SIZE + (sz - 1) * BOAT_CELL_WORLD_SIZE / 2;
    const x0 = cx - halfX, x1 = cx + halfX;
    const z0 = cz - halfZ, z1 = cz + halfZ;
    const s = BOAT_CELL_WORLD_SIZE / 2;
    const rot = cell.rotation % 4;
    let shape: Shape2D;

    switch (cell.type) {
      case BoatCellType.BOW:
      case BoatCellType.BOW_MODERN:
        shape = { polygon: [[cx, z0], [x1, z1], [x0, z1]], edges: [{ dir: -1, p0: 0, p1: 1 }, { dir: 2, p0: 1, p1: 2 }, { dir: -1, p0: 2, p1: 0 }] };
        break;
      case BoatCellType.WALL_STRAIGHT: {
        const w = WALL_THICKNESS;
        shape = { polygon: [[x0, z0], [x1, z0], [x1, z0 + w], [x0, z0 + w]], edges: [{ dir: 0, p0: 0, p1: 1 }, { dir: -1, p0: 1, p1: 2 }, { dir: -1, p0: 2, p1: 3 }, { dir: -1, p0: 3, p1: 0 }] };
        break;
      }
      case BoatCellType.WALL_CORNER: {
        const w = WALL_THICKNESS;
        shape = { polygon: [[x0, z0], [x1, z0], [x1, z0 + w], [x0 + w, z0 + w], [x0 + w, z1], [x0, z1]], edges: [{ dir: 0, p0: 0, p1: 1 }, { dir: -1, p0: 1, p1: 2 }, { dir: -1, p0: 2, p1: 3 }, { dir: -1, p0: 3, p1: 4 }, { dir: -1, p0: 4, p1: 5 }, { dir: 3, p0: 5, p1: 0 }] };
        break;
      }
      case BoatCellType.WALL_CURVED: {
        const w = WALL_THICKNESS;
        const ro = s, ri = s - w;
        const ox = x0, oz = z0;
        const steps = 3;
        const poly: [number, number][] = [];
        for (let i = 0; i <= steps + 1; i++) { const a = (i / (steps + 1)) * Math.PI / 2; poly.push([ox + ro * Math.cos(a), oz + ro * Math.sin(a)]); }
        for (let i = steps; i >= 0; i--) { const a = (i / (steps + 1)) * Math.PI / 2; poly.push([ox + ri * Math.cos(a), oz + ri * Math.sin(a)]); }
        const edges: { dir: number; p0: number; p1: number }[] = [];
        for (let i = 0; i < poly.length; i++) edges.push({ dir: -1, p0: i, p1: (i + 1) % poly.length });
        shape = { polygon: poly, edges };
        break;
      }
      case BoatCellType.WALL_DIAGONAL: {
        const o = WALL_THICKNESS / (2 * Math.sqrt(2));
        shape = { polygon: [[x0 - o, z0 + o], [x1 - o, z1 + o], [x1 + o, z1 - o], [x0 + o, z0 - o]], edges: [{ dir: -1, p0: 0, p1: 1 }, { dir: -1, p0: 1, p1: 2 }, { dir: -1, p0: 2, p1: 3 }, { dir: -1, p0: 3, p1: 0 }] };
        break;
      }
      case BoatCellType.HULL_CURVE_L:
        shape = { polygon: [[cx, z0], [x1, z0], [x1, z1], [x0, z1]], edges: [{ dir: -1, p0: 0, p1: 1 }, { dir: 1, p0: 1, p1: 2 }, { dir: 2, p0: 2, p1: 3 }, { dir: -1, p0: 3, p1: 0 }] };
        break;
      case BoatCellType.HULL_CURVE_R:
        shape = { polygon: [[x0, z0], [cx, z0], [x1, z1], [x0, z1]], edges: [{ dir: -1, p0: 0, p1: 1 }, { dir: -1, p0: 1, p1: 2 }, { dir: 2, p0: 2, p1: 3 }, { dir: 3, p0: 3, p1: 0 }] };
        break;
      default:
        shape = { polygon: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], edges: [{ dir: 0, p0: 0, p1: 1 }, { dir: 1, p0: 1, p1: 2 }, { dir: 2, p0: 2, p1: 3 }, { dir: 3, p0: 3, p1: 0 }] };
        break;
    }

    if (rot > 0) {
      const angle = rot * Math.PI / 2;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      shape = {
        polygon: shape.polygon.map(([px, pz]) => [cx + (px - cx) * cosA - (pz - cz) * sinA, cz + (px - cx) * sinA + (pz - cz) * cosA] as [number, number]),
        edges: shape.edges.map(e => ({ dir: e.dir >= 0 ? (e.dir + rot) % 4 : -1, p0: e.p0, p1: e.p1 })),
      };
    }
    return shape;
  }

  private addQuad(verts: number[], idx: number[], baseVi: number, p0: [number, number, number], p1: [number, number, number], p2: [number, number, number], p3: [number, number, number], normal: [number, number, number], color: [number, number, number]): number {
    const [nx, ny, nz] = normal;
    const [r, g, b] = color;
    verts.push(p0[0], p0[1], p0[2], nx, ny, nz, r, g, b, p1[0], p1[1], p1[2], nx, ny, nz, r, g, b, p2[0], p2[1], p2[2], nx, ny, nz, r, g, b, p3[0], p3[1], p3[2], nx, ny, nz, r, g, b);
    idx.push(baseVi, baseVi + 1, baseVi + 2, baseVi, baseVi + 2, baseVi + 3);
    return baseVi + 4;
  }

  private addTri(verts: number[], idx: number[], baseVi: number, p0: [number, number, number], p1: [number, number, number], p2: [number, number, number], normal: [number, number, number], color: [number, number, number]): number {
    const [nx, ny, nz] = normal;
    const [r, g, b] = color;
    verts.push(p0[0], p0[1], p0[2], nx, ny, nz, r, g, b, p1[0], p1[1], p1[2], nx, ny, nz, r, g, b, p2[0], p2[1], p2[2], nx, ny, nz, r, g, b);
    idx.push(baseVi, baseVi + 1, baseVi + 2);
    return baseVi + 3;
  }
}
