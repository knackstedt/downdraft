// ============================================================================
// Entity Renderer — facade that delegates to sub-renderers for each entity type
// ============================================================================

import { calculateViewProj, DEPTH_FORMAT, MSAA_SAMPLE_COUNT, SimBufferReader, type BindlessMaterialManager, type BindlessTextureRegistry } from "@downdraft/core";
import type { MeshData, ModelData } from "@downdraft/library-models";
import { RuntimeBoatGeometry, type BoatDesign } from "@shared/boat-design";
import {
    BOAT_CELL_WORLD_SIZE, BOAT_LAYER_HEIGHT,
    getCellGeometry, getPortColliderDims, getPortCollisionBoxes,
    getWallCollisionBoxes, hasSolidCollision, isWallType,
    PLAYER_HEIGHT, PLAYER_RADIUS
} from "@shared/constants";
import { EntityType, PortSize } from "@shared/types";
import { BoatBufferReader } from "@to-the-ocean/library-boats/boat-sab";
import { CameraState } from "./camera-system";

import { ENTITY_WGSL } from "./shaders/entity-shaders";

import { AnchorRenderer } from "./entity/anchor-renderer";
import { BoatMeshBuilder } from "./entity/boat-mesh-builder";
import { HitboxRenderer } from "./entity/hitbox-renderer";
import { HoloPreviewRenderer, type HoloMeshDeps } from "./entity/holo-preview-renderer";
import { InstancedEntityRenderer } from "./entity/instanced-renderer";
import { IslandTerrainRenderer } from "./entity/island-terrain-renderer";
import { PlayerMeshRenderer } from "./entity/player-mesh-renderer";
import type { EntityRenderContext } from "./entity/render-context";

export class EntityRenderer {
  private static readonly MAX_DRAW_ENTITIES = 512;

  // Shared context (mutable object passed to all sub-renderers)
  private ctx: EntityRenderContext;

  // Shared GPU resources (managed by facade, shared via context)
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private cubeVertices: GPUBuffer | null = null;
  private cubeIndices: GPUBuffer | null = null;
  private cubeIndexCount = 0;

  // Per-frame state (stored in context for sub-renderers to read)
  private viewProjCache: Float32Array | null = null;
  private cameraPosCache: [number, number, number] = [0, 0, 0];
  private lightingParamsCache: { sunDir: [number, number, number]; sunIntensity: number; ambient: number; fogColor: [number, number, number]; wetness: number } = {
    sunDir: [0.5, 0.8, 0.3], sunIntensity: 1.0, ambient: 0.5, fogColor: [0.0, 0.1, 0.2], wetness: 0,
  };
  private reusableUniforms = new Float32Array(64);
  private viewportWidth = 1;
  private viewportHeight = 1;

  // Draw entity arrays (stored in context for sub-renderers to read)
  private drawEntityTypes: EntityType[] = [];
  private drawEntityBoatSlots: number[] = [];
  private drawEntityScales: number[] = [];
  private drawEntityPortSizes: number[] = [];
  private drawEntityChunkX: number[] = [];
  private drawEntityChunkZ: number[] = [];
  private drawEntityBiome: number[] = [];
  private drawEntityIslandSize: number[] = [];
  private drawEntityPosX: number[] = [];
  private drawEntityPosY: number[] = [];
  private drawEntityPosZ: number[] = [];
  private drawEntityCount = 0;

  // External bind groups
  private lightBindGroup: GPUBindGroup | null = null;
  private pbrBindGroup: GPUBindGroup | null = null;

  // Triangle counter (accumulated across render + renderInstanced)
  private _lastFrameTriangles = 0;

  // --- Sub-renderers ---
  private anchorRenderer: AnchorRenderer;
  private boatMeshBuilder: BoatMeshBuilder;
  private hitboxRenderer: HitboxRenderer;
  private holoPreviewRenderer: HoloPreviewRenderer;
  private instancedRenderer: InstancedEntityRenderer;
  private islandTerrainRenderer: IslandTerrainRenderer;
  private playerMeshRenderer: PlayerMeshRenderer;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;

    // Build shared context
    this.ctx = {
      device,
      format,
      uniformBuffer: null,
      bindGroup: null,
      bindGroupLayout: null,
      bindGroups: null,
      viewProjCache: null,
      cameraPosCache: [0, 0, 0],
      lightingParamsCache: this.lightingParamsCache,
      lightBindGroup: null,
      pbrBindGroup: null,
      bindlessRegistry: null,
      bindlessMaterialManager: null,
      bindlessBindGroup: null,
      reusableUniforms: this.reusableUniforms,
      reusableHbUniforms: new Float32Array(64),
      viewportWidth: 1,
      viewportHeight: 1,
      drawEntityTypes: this.drawEntityTypes,
      drawEntityBoatSlots: this.drawEntityBoatSlots,
      drawEntityScales: this.drawEntityScales,
      drawEntityPortSizes: this.drawEntityPortSizes,
      drawEntityChunkX: this.drawEntityChunkX,
      drawEntityChunkZ: this.drawEntityChunkZ,
      drawEntityBiome: this.drawEntityBiome,
      drawEntityIslandSize: this.drawEntityIslandSize,
      drawEntityPosX: this.drawEntityPosX,
      drawEntityPosY: this.drawEntityPosY,
      drawEntityPosZ: this.drawEntityPosZ,
      drawEntityCount: 0,
    };

    // Create sub-renderers
    this.anchorRenderer = new AnchorRenderer(this.ctx);
    this.boatMeshBuilder = new BoatMeshBuilder(this.ctx);
    this.hitboxRenderer = new HitboxRenderer(this.ctx);
    this.holoPreviewRenderer = new HoloPreviewRenderer(this.ctx);
    this.instancedRenderer = new InstancedEntityRenderer(this.ctx);
    this.islandTerrainRenderer = new IslandTerrainRenderer(this.ctx);
    this.playerMeshRenderer = new PlayerMeshRenderer(this.ctx);
  }

  // --- Hitbox visibility ---
  setShowHitboxes(show: boolean): void {
    this.hitboxRenderer.setShowHitboxes(show);
  }
  isHitboxVisible(): boolean {
    return this.hitboxRenderer.isHitboxVisible();
  }
  setHitboxLineWidth(width: number): void {
    this.hitboxRenderer.setHitboxLineWidth(width);
  }
  getHitboxLineWidth(): number {
    return this.hitboxRenderer.getHitboxLineWidth();
  }

  // --- Boat setters ---
  setBoatBufferReader(reader: BoatBufferReader): void {
    this.boatMeshBuilder.setBoatBufferReader(reader);
    this.holoPreviewRenderer.setBoatBufferReader(reader);
  }
  setBoatDesignReader(designs: Map<number, { design: BoatDesign; geometry: RuntimeBoatGeometry }>): void {
    this.boatMeshBuilder.setBoatDesigns(designs);
  }

  // --- Lighting / PBR ---
  setLightBindGroup(bg: GPUBindGroup): void {
    this.lightBindGroup = bg;
    this.ctx.lightBindGroup = bg;
  }
  setPBRBindGroup(bg: GPUBindGroup): void {
    this.pbrBindGroup = bg;
    this.ctx.pbrBindGroup = bg;
  }
  setBindlessDeps(
    registry: BindlessTextureRegistry | null,
    materialManager: BindlessMaterialManager | null,
    bindGroup: GPUBindGroup | null,
  ): void {
    this.ctx.bindlessRegistry = registry;
    this.ctx.bindlessMaterialManager = materialManager;
    this.ctx.bindlessBindGroup = bindGroup;
  }
  /** Push the fresh bindless bind group to the player-mesh-renderer mid-frame. */
  pushBindlessBindGroup(bg: GPUBindGroup | null): void {
    if (bg) {
      this.playerMeshRenderer.setBindlessBindGroup(bg);
    }
  }
  setTerrainMeshPool(pool: import("./terrain-mesh-pool").TerrainMeshPool | null): void {
    this.islandTerrainRenderer.setMeshPool(pool);
  }

  // --- Init ---
  async init(
    lightBindGroupLayout?: GPUBindGroupLayout,
    pbrBindGroupLayout?: GPUBindGroupLayout,
    bindlessBindGroupLayout?: GPUBindGroupLayout,
  ): Promise<void> {
    const shaderModule = this.device.createShaderModule({ code: ENTITY_WGSL });

    this.uniformBuffer = this.device.createBuffer({
      size: 256 * EntityRenderer.MAX_DRAW_ENTITIES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true } },
      ],
    });

    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer, size: 256 } }],
    });

    // Create per-entity bind groups with explicit offsets.
    // The native wgpu shim doesn't support dynamic offsets in setBindGroup(),
    // so we pre-create one bind group per draw entity slot, each pointing to
    // the correct offset in the uniform buffer. In browser mode, the dynamic
    // offset path (this.bindGroup + [idx * 256]) is used instead.
    const perEntityBindGroups: GPUBindGroup[] = [];
    for (let i = 0; i < EntityRenderer.MAX_DRAW_ENTITIES; i++) {
      perEntityBindGroups.push(this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [{ binding: 0, resource: { buffer: this.uniformBuffer, offset: i * 256, size: 256 } }],
      }));
    }

    // Update context with shared resources
    this.ctx.uniformBuffer = this.uniformBuffer;
    this.ctx.bindGroup = this.bindGroup;
    this.ctx.bindGroupLayout = this.bindGroupLayout;
    this.ctx.bindGroups = perEntityBindGroups;

    // Unit cube
    const verts = new Float32Array([
      -0.5, -0.5, -0.5,  0, 0, -1,
       0.5, -0.5, -0.5,  0, 0, -1,
       0.5,  0.5, -0.5,  0, 0, -1,
      -0.5,  0.5, -0.5,  0, 0, -1,
      -0.5, -0.5,  0.5,  0, 0, 1,
       0.5, -0.5,  0.5,  0, 0, 1,
       0.5,  0.5,  0.5,  0, 0, 1,
      -0.5,  0.5,  0.5,  0, 0, 1,
      -0.5, -0.5, -0.5,  0, -1, 0,
       0.5, -0.5, -0.5,  0, -1, 0,
       0.5, -0.5,  0.5,  0, -1, 0,
      -0.5, -0.5,  0.5,  0, -1, 0,
      -0.5,  0.5, -0.5,  0, 1, 0,
       0.5,  0.5, -0.5,  0, 1, 0,
       0.5,  0.5,  0.5,  0, 1, 0,
      -0.5,  0.5,  0.5,  0, 1, 0,
      -0.5, -0.5, -0.5, -1, 0, 0,
      -0.5,  0.5, -0.5, -1, 0, 0,
      -0.5,  0.5,  0.5, -1, 0, 0,
      -0.5, -0.5,  0.5, -1, 0, 0,
       0.5, -0.5, -0.5,  1, 0, 0,
       0.5,  0.5, -0.5,  1, 0, 0,
       0.5,  0.5,  0.5,  1, 0, 0,
       0.5, -0.5,  0.5,  1, 0, 0,
    ]);
    const indices = new Uint16Array([
      0, 1, 2, 0, 2, 3,
      4, 6, 5, 4, 7, 6,
      8, 9, 10, 8, 10, 11,
      12, 14, 13, 12, 15, 14,
      16, 17, 18, 16, 18, 19,
      20, 22, 21, 20, 23, 22,
    ]);

    this.cubeVertices = this.device.createBuffer({
      size: verts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.cubeVertices, 0, verts as any);

    this.cubeIndexCount = indices.length;
    this.cubeIndices = this.device.createBuffer({
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.cubeIndices, 0, indices as any);

    // Pipeline layouts — entity/island/boat shaders don't use @group(3), so the
    // bindless layout is NOT included here. Only player/skinned-player pipelines
    // (which declare @group(3) bindless bindings) add it in PlayerMeshRenderer.
    const bgl = this.bindGroupLayout as GPUBindGroupLayout;
    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [bgl],
    });
    const litPipelineLayout = lightBindGroupLayout
      ? this.device.createPipelineLayout({ bindGroupLayouts: [bgl, lightBindGroupLayout as GPUBindGroupLayout] })
      : pipelineLayout;
    const pbrLitPipelineLayout = (lightBindGroupLayout && pbrBindGroupLayout)
      ? this.device.createPipelineLayout({ bindGroupLayouts: [bgl, lightBindGroupLayout as GPUBindGroupLayout, pbrBindGroupLayout as GPUBindGroupLayout] })
      : litPipelineLayout;

    // Generic entity pipeline (cube fallback)
    this.pipeline = this.device.createRenderPipeline({
      layout: pbrLitPipelineLayout,
      vertex: {
        module: shaderModule,
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
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.format as GPUTextureFormat }],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

    // Init sub-renderers
    this.boatMeshBuilder.init();
    this.islandTerrainRenderer.init(pbrLitPipelineLayout);
    this.anchorRenderer.init(pbrLitPipelineLayout);
    this.holoPreviewRenderer.init(litPipelineLayout);
    this.hitboxRenderer.init(pipelineLayout);
    this.instancedRenderer.init(
      this.cubeVertices!, this.cubeIndices!, this.cubeIndexCount,
      lightBindGroupLayout ?? undefined, pbrBindGroupLayout ?? undefined,
    );
    this.playerMeshRenderer.init(lightBindGroupLayout ?? null, pbrBindGroupLayout ?? null, bindlessBindGroupLayout ?? null);

    // Wire holo preview mesh deps from boat mesh builder
    this.holoPreviewRenderer.setMeshDeps({
      bedMeshVerts: this.boatMeshBuilder.bedMeshVerts,
      bedMeshIdx: this.boatMeshBuilder.bedMeshIdx,
      bedMeshVertCount: this.boatMeshBuilder.bedMeshVertCount,
      generateCellMesh: (cell, cellMap, verts, idx, baseVi) =>
        this.boatMeshBuilder.generateCellMesh(cell, cellMap, verts, idx, baseVi),
      generateFBXCellMesh: (cell, cellMap, srcVerts, srcIdx, verts, idx, baseVi) =>
        this.boatMeshBuilder.generateFBXCellMesh(cell, cellMap, srcVerts, srcIdx, verts, idx, baseVi),
      genDeleteXCell: (cx, cy, cz, s, verts, idx, baseVi) =>
        this.boatMeshBuilder.genDeleteXCell(cx, cy, cz, s, verts, idx, baseVi),
    } as HoloMeshDeps);
  }

  // --- Begin frame ---
  beginFrame(
    camera: CameraState,
    viewportW: number = 1,
    viewportH: number = 1,
    lighting?: { sunDir: [number, number, number]; sunIntensity: number; ambient: number; fogColor: [number, number, number]; wetness?: number },
  ): void {
    this.viewProjCache = calculateViewProj(camera);
    this.cameraPosCache = [camera.position[0], camera.position[1], camera.position[2]];
    if (lighting) this.lightingParamsCache = { ...lighting, wetness: lighting.wetness ?? 0 };
    this.viewportWidth = viewportW;
    this.viewportHeight = viewportH;

    // Update context
    this.ctx.viewProjCache = this.viewProjCache;
    this.ctx.cameraPosCache = this.cameraPosCache;
    this.ctx.lightingParamsCache = this.lightingParamsCache;
    this.ctx.viewportWidth = viewportW;
    this.ctx.viewportHeight = viewportH;

    // Reset per-frame counters
    this._lastFrameTriangles = 0;
    this.drawEntityCount = 0;
    this.ctx.drawEntityCount = 0;

    // Refresh the bindless bind group for this frame (may have been rebuilt
    // if the texture registry or material SSBO grew).
    if (this.ctx.bindlessBindGroup) {
      this.playerMeshRenderer.setBindlessBindGroup(this.ctx.bindlessBindGroup);
      this.playerMeshRenderer.beginFrame();
    }

    // Boat mesh rebuild check
    this.boatMeshBuilder.checkSequenceAndRebuild();

    // Reset sub-renderer per-frame state
    this.instancedRenderer.resetFrame();
    this.instancedRenderer.writeFrameUniforms();
    this.hitboxRenderer.resetEntryCount();
  }

  // --- Write entity uniforms (stays in facade — central dispatcher) ---
  writeEntityUniforms(
    idx: number,
    type: EntityType,
    pos: { x: number; y: number; z: number },
    scale: number,
    rotation: { x: number; y: number; z: number; w: number },
    boatSlot: number = -1,
    islandMeta?: { chunkX: number; chunkZ: number; biome: number; islandSize: number },
    portMeta?: { chunkX: number; chunkZ: number; biome: number },
    flags: number = 0,
  ): void {
    if (!this.uniformBuffer || !this.viewProjCache) return;
    if (idx >= EntityRenderer.MAX_DRAW_ENTITIES) return;

    this.drawEntityTypes[idx] = type;
    this.drawEntityBoatSlots[idx] = boatSlot;
    this.drawEntityScales[idx] = scale;
    this.drawEntityPosX[idx] = pos.x;
    this.drawEntityPosY[idx] = pos.y;
    this.drawEntityPosZ[idx] = pos.z;

    // Store island metadata
    if (type === EntityType.Island && islandMeta) {
      this.drawEntityChunkX[idx] = islandMeta.chunkX;
      this.drawEntityChunkZ[idx] = islandMeta.chunkZ;
      this.drawEntityBiome[idx] = islandMeta.biome;
      this.drawEntityIslandSize[idx] = islandMeta.islandSize;
      this.islandTerrainRenderer.ensureIslandMesh(islandMeta.chunkX, islandMeta.chunkZ, scale, islandMeta.biome, islandMeta.islandSize);
      this.islandTerrainRenderer.ensureDecorationMesh(islandMeta.chunkX, islandMeta.chunkZ, islandMeta.biome, islandMeta.islandSize, scale);
    } else {
      this.drawEntityChunkX[idx] = 0;
      this.drawEntityChunkZ[idx] = 0;
    }

    // Derive port size from entity scale
    if (type === EntityType.Port) {
      if (scale <= 18) this.drawEntityPortSizes[idx] = PortSize.Small;
      else if (scale <= 32) this.drawEntityPortSizes[idx] = PortSize.Medium;
      else this.drawEntityPortSizes[idx] = PortSize.Large;
      if (portMeta) {
        this.drawEntityChunkX[idx] = portMeta.chunkX;
        this.drawEntityChunkZ[idx] = portMeta.chunkZ;
        this.islandTerrainRenderer.ensurePortMesh(portMeta.chunkX, portMeta.chunkZ, scale, portMeta.biome);
        this.islandTerrainRenderer.ensurePortStructureMesh(portMeta.chunkX, portMeta.chunkZ, scale, portMeta.biome);
      }
    } else {
      this.drawEntityPortSizes[idx] = -1;
    }

    // Write uniform buffer
    const offset = idx * 256;
    const uniforms = this.reusableUniforms;
    for (let i = 0; i < 16; i++) uniforms[i] = this.viewProjCache[i];
    uniforms[16] = this.cameraPosCache[0];
    uniforms[17] = this.cameraPosCache[1];
    uniforms[18] = this.cameraPosCache[2];
    uniforms[19] = performance.now() / 1000;
    uniforms[20] = pos.x;
    uniforms[21] = pos.y;
    uniforms[22] = pos.z;
    uniforms[23] = scale;
    uniforms[24] = rotation.x;
    uniforms[25] = rotation.y;
    uniforms[26] = rotation.z;
    uniforms[27] = rotation.w;
    const dv = new DataView(uniforms.buffer);
    dv.setUint32(112, type, true);
    dv.setUint32(116, flags, true);

    const lp = this.lightingParamsCache;
    uniforms[30] = lp.wetness ?? 0;
    uniforms[31] = 0;
    uniforms[32] = lp.sunDir[0];
    uniforms[33] = lp.sunDir[1];
    uniforms[34] = lp.sunDir[2];
    uniforms[35] = lp.sunIntensity;
    uniforms[36] = lp.ambient;
    uniforms[37] = 0; uniforms[38] = 0; uniforms[39] = 0;
    uniforms[40] = lp.fogColor[0];
    uniforms[41] = lp.fogColor[1];
    uniforms[42] = lp.fogColor[2];
    uniforms[43] = 0;

    this.device.queue.writeBuffer(this.uniformBuffer!, offset, uniforms as any);

    this.drawEntityCount = idx + 1;
    this.ctx.drawEntityCount = this.drawEntityCount;

    // Write hitbox entries
    this.writeHitboxForEntity(idx, type, pos, scale, rotation, boatSlot);
  }

  private writeHitboxForEntity(
    idx: number,
    type: EntityType,
    pos: { x: number; y: number; z: number },
    scale: number,
    rotation: { x: number; y: number; z: number; w: number },
    boatSlot: number,
  ): void {
    if ((type === EntityType.Ship || type === EntityType.SmallCraft) &&
        boatSlot >= 0 && this.boatMeshBuilder.getBoatBufferReader()?.isValid()) {
      const reader = this.boatMeshBuilder.getBoatBufferReader()!;
      const cells = reader.getBoatCells(boatSlot);
      const rapierBlue: [number, number, number] = [0.2, 0.6, 1.0];

      let rMinX = Infinity, rMaxX = -Infinity;
      let rMinY = Infinity, rMaxY = -Infinity;
      let rMinZ = Infinity, rMaxZ = -Infinity;

      for (let ci = 0; ci < cells.length; ci++) {
        const cell = cells[ci];
        const geo = getCellGeometry(cell.type);
        const sx = cell.sizeX || 1;
        const sz = cell.sizeZ || 1;

        const allMinX = cell.gridX * BOAT_CELL_WORLD_SIZE - BOAT_CELL_WORLD_SIZE / 2;
        const allMaxX = allMinX + sx * BOAT_CELL_WORLD_SIZE;
        const allMinZ = cell.gridZ * BOAT_CELL_WORLD_SIZE - BOAT_CELL_WORLD_SIZE / 2;
        const allMaxZ = allMinZ + sz * BOAT_CELL_WORLD_SIZE;
        const allMinY = cell.gridY * BOAT_LAYER_HEIGHT + geo.y0;
        const allMaxY = cell.gridY * BOAT_LAYER_HEIGHT + geo.y1 +
          (cell.sizeY > 1 ? (cell.sizeY - 1) * BOAT_LAYER_HEIGHT : 0);
        if (allMinX < rMinX) rMinX = allMinX;
        if (allMaxX > rMaxX) rMaxX = allMaxX;
        if (allMinZ < rMinZ) rMinZ = allMinZ;
        if (allMaxZ > rMaxZ) rMaxZ = allMaxZ;
        if (allMinY < rMinY) rMinY = allMinY;
        if (allMaxY > rMaxY) rMaxY = allMaxY;

        if (!hasSolidCollision(cell.type)) continue;
        const halfX = (sx * BOAT_CELL_WORLD_SIZE) / 2;
        const halfZ = (sz * BOAT_CELL_WORLD_SIZE) / 2;
        const cellCx = cell.gridX * BOAT_CELL_WORLD_SIZE + (sx - 1) * BOAT_CELL_WORLD_SIZE / 2;
        const cellCz = cell.gridZ * BOAT_CELL_WORLD_SIZE + (sz - 1) * BOAT_CELL_WORLD_SIZE / 2;

        if (isWallType(cell.type)) {
          const boxes = getWallCollisionBoxes(cell.type, cell.rotation);
          const wallHalfY = (geo.y1 - geo.y0) / 2;
          const cy = cell.gridY * BOAT_LAYER_HEIGHT + geo.y0 + wallHalfY;
          const wallCx = cell.gridX * BOAT_CELL_WORLD_SIZE;
          const wallCz = cell.gridZ * BOAT_CELL_WORLD_SIZE;
          for (let bi = 0; bi < boxes.length; bi++) {
            const b = boxes[bi];
            this.hitboxRenderer.writeHitboxEntry(wallCx + b.offsetX, cy, wallCz + b.offsetZ, b.halfX, wallHalfY, b.halfZ, pos, rotation);
          }
        } else {
          const totalHeight = (geo.y1 - geo.y0) + (cell.sizeY > 1 ? (cell.sizeY - 1) * BOAT_LAYER_HEIGHT : 0);
          const halfY = totalHeight / 2;
          const cy = cell.gridY * BOAT_LAYER_HEIGHT + geo.y0 + halfY;
          this.hitboxRenderer.writeHitboxEntry(cellCx, cy, cellCz, halfX, halfY, halfZ, pos, rotation);
        }
      }

      if (Number.isFinite(rMinX)) {
        const halfX = (rMaxX - rMinX) / 2;
        const halfY = (rMaxY - rMinY) / 2;
        const halfZ = (rMaxZ - rMinZ) / 2;
        const cx = (rMinX + rMaxX) / 2;
        const cy = (rMinY + rMaxY) / 2;
        const cz = (rMinZ + rMaxZ) / 2;
        this.hitboxRenderer.writeHitboxEntry(cx, cy, cz, halfX, halfY, halfZ, pos, rotation, rapierBlue);
      }
    } else if (type === EntityType.Port) {
      const portSize = this.drawEntityPortSizes[idx] ?? PortSize.Small;
      const cd = getPortColliderDims(portSize, scale);
      if (cd) {
        this.hitboxRenderer.writeHitboxEntry(0, cd.dock.centerY, 0, cd.dock.halfW, cd.dock.halfH, cd.dock.halfD, pos, rotation);
        this.hitboxRenderer.writeHitboxEntry(0, cd.pier.centerY, cd.pier.centerZ, cd.pier.halfW, cd.pier.halfH, cd.pier.halfL, pos, rotation);
      }
      const structBoxes = getPortCollisionBoxes(portSize, scale);
      for (let bi = 0; bi < structBoxes.length; bi++) {
        const box = structBoxes[bi];
        this.hitboxRenderer.writeHitboxEntry(box.cx, box.cy, box.cz, box.halfW, box.halfH, box.halfD, pos, rotation);
      }
    } else if (type === EntityType.Player) {
      this.hitboxRenderer.writeHitboxEntry(0, PLAYER_HEIGHT / 2, 0, PLAYER_RADIUS, PLAYER_HEIGHT / 2, PLAYER_RADIUS, pos, { x: 0, y: 0, z: 0, w: 1 });
    } else if (type !== EntityType.Island) {
      this.hitboxRenderer.writeHitboxEntry(0, 0, 0, scale, scale, scale, pos, rotation);
    }
  }

  // --- Instanced rendering ---
  static isInstancedType(type: EntityType): boolean {
    return InstancedEntityRenderer.isInstancedType(type);
  }

  writeInstanceData(
    pos: { x: number; y: number; z: number },
    scale: number,
    rotation: { x: number; y: number; z: number; w: number },
    type: EntityType,
    flags: number,
  ): void {
    this.instancedRenderer.writeInstanceData(pos, scale, rotation, type, flags);
  }

  writeInstancedHitbox(
    pos: { x: number; y: number; z: number },
    scale: number,
    rotation: { x: number; y: number; z: number; w: number },
  ): void {
    this.hitboxRenderer.writeInstancedHitbox(pos, scale, rotation);
  }

  uploadInstanceData(): void {
    this.instancedRenderer.uploadInstanceData();
  }

  renderInstanced(passEncoder: GPURenderPassEncoder): void {
    if (this.lightBindGroup) passEncoder.setBindGroup(1, this.lightBindGroup);
    if (this.pbrBindGroup) passEncoder.setBindGroup(2, this.pbrBindGroup);
    this.instancedRenderer.render(passEncoder as any);
    this._lastFrameTriangles += this.instancedRenderer.getLastFrameTriangles();
  }

  // --- Render (dispatches to sub-renderers based on entity type) ---
  render(passEncoder: GPURenderPassEncoder, idx: number): void {
    if (!this.bindGroup || !this.uniformBuffer) return;

    // Bind light + PBR groups for lit pipelines
    if (this.lightBindGroup) passEncoder.setBindGroup(1, this.lightBindGroup);
    if (this.pbrBindGroup) passEncoder.setBindGroup(2, this.pbrBindGroup);

    const type = this.drawEntityTypes[idx] ?? EntityType.Player;
    const isBoat = type === EntityType.Ship || type === EntityType.SmallCraft;
    const boatSlot = this.drawEntityBoatSlots[idx] ?? -1;

    // Skinned player
    if (type === EntityType.Player && this.playerMeshRenderer.hasSkinnedMesh()) {
      this._lastFrameTriangles += this.playerMeshRenderer.renderSkinnedPlayer(passEncoder as any, idx);
      return;
    }

    // Static player
    if (type === EntityType.Player && this.playerMeshRenderer.hasStaticMesh()) {
      this._lastFrameTriangles += this.playerMeshRenderer.renderStaticPlayer(passEncoder as any, idx);
      return;
    }

    // Island
    if (type === EntityType.Island && this.islandTerrainRenderer.islandPipeline) {
      this._lastFrameTriangles += this.islandTerrainRenderer.renderIsland(passEncoder as any, idx);
      return;
    }

    // Port
    if (type === EntityType.Port) {
      this._lastFrameTriangles += this.islandTerrainRenderer.renderPort(passEncoder as any, idx);
      return;
    }

    // Boat
    if (isBoat && this.islandTerrainRenderer.boatPipeline && boatSlot >= 0) {
      this._lastFrameTriangles += this.boatMeshBuilder.renderBoat(passEncoder as any, this.islandTerrainRenderer.boatPipeline, idx, boatSlot);
      return;
    }

    // Generic cube fallback
    if (this.pipeline && this.cubeVertices && this.cubeIndices) {
      passEncoder.setPipeline(this.pipeline);
      const bg = this.ctx.bindGroups?.[idx] ?? this.bindGroup;
      if (this.ctx.bindGroups) passEncoder.setBindGroup(0, bg);
      else passEncoder.setBindGroup(0, bg, [idx * 256]);
      passEncoder.setVertexBuffer(0, this.cubeVertices);
      passEncoder.setIndexBuffer(this.cubeIndices, "uint16");
      passEncoder.drawIndexed(this.cubeIndexCount);
      this._lastFrameTriangles += Math.floor(this.cubeIndexCount / 3);
    }
  }

  // --- Anchors ---
  renderAnchors(passEncoder: GPURenderPassEncoder, simReader: SimBufferReader): void {
    if (this.lightBindGroup) passEncoder.setBindGroup(1, this.lightBindGroup);
    this.anchorRenderer.render(passEncoder as any, simReader);
  }

  // --- Hitboxes ---
  renderHitboxes(passEncoder: GPURenderPassEncoder): void {
    this.hitboxRenderer.render(passEncoder as any, this.islandTerrainRenderer.getIslandMeshes());
  }

  // --- Holo preview ---
  renderHoloPreview(
    passEncoder: GPURenderPassEncoder,
    shipPos: { x: number; y: number; z: number },
    shipRot: { x: number; y: number; z: number; w: number },
  ): void {
    if (this.lightBindGroup) passEncoder.setBindGroup(1, this.lightBindGroup);
    this.holoPreviewRenderer.render(passEncoder as any, shipPos, shipRot);
  }

  // --- Player mesh setters ---
  setPlayerMesh(meshes: MeshData[]): void {
    this.playerMeshRenderer.setPlayerMesh(meshes);
  }

  setSkinnedPlayerMesh(modelData: ModelData): void {
    this.playerMeshRenderer.setSkinnedPlayerMesh(modelData);
  }

  setPlayerTexture(image: ImageBitmap | HTMLImageElement): void {
    this.playerMeshRenderer.setPlayerTexture(image);
  }

  addClothingPiece(name: string, modelData: ModelData): void {
    this.playerMeshRenderer.addClothingPiece(name, modelData);
  }

  getSkeletonAnimator() {
    return this.playerMeshRenderer.getSkeletonAnimator();
  }

  updateBoneLocalTransforms(): void {
    this.playerMeshRenderer.updateBoneLocalTransforms();
  }

  dispatchSkinningCompute(encoder: GPUCommandEncoder): void {
    this.playerMeshRenderer.dispatchSkinningCompute(encoder as any);
  }

  // --- Bed mesh (converts FBX to boat format, delegates to BoatMeshBuilder) ---
  setBedMesh(meshes: MeshData[]): void {
    const stride = 9;
    const allVerts: number[] = [];
    const allIdx: number[] = [];
    let vertOffset = 0;

    for (const mesh of meshes) {
      const vCount = mesh.vertexCount;
      for (let i = 0; i < vCount; i++) {
        let px = mesh.vertices[i * 6];
        let py = mesh.vertices[i * 6 + 1];
        let pz = mesh.vertices[i * 6 + 2];
        let nx = mesh.vertices[i * 6 + 3];
        let ny = mesh.vertices[i * 6 + 4];
        let nz = mesh.vertices[i * 6 + 5];

        // Z-up to Y-up: (x, y, z) -> (x, z, -y)
        const tmpY = py; py = pz; pz = -tmpY;
        const tmpNY = ny; ny = nz; nz = -tmpNY;

        let r = 1, g = 1, b = 1;
        if (mesh.colors) {
          r = mesh.colors[i * 3];
          g = mesh.colors[i * 3 + 1];
          b = mesh.colors[i * 3 + 2];
        }
        allVerts.push(px, py, pz, nx, ny, nz, r, g, b);
      }
      for (let i = 0; i < mesh.indexCount; i++) {
        allIdx.push((mesh.indices[i] >>> 0) + vertOffset);
      }
      vertOffset += vCount;
    }

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < allVerts.length; i += stride) {
      const x = allVerts[i], y = allVerts[i + 1], z = allVerts[i + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }

    const sizeX = maxX - minX;
    const sizeY = maxY - minY;
    const sizeZ = maxZ - minZ;
    const targetX = BOAT_CELL_WORLD_SIZE * 0.9;
    const targetZ = BOAT_CELL_WORLD_SIZE * 2 * 0.9;
    const targetY = BOAT_LAYER_HEIGHT * 0.45;
    const scaleX = targetX / (sizeX || 1);
    const scaleZ = targetZ / (sizeZ || 1);
    const scaleY = Math.min(targetY / (sizeY || 1), Math.max(scaleX, scaleZ));

    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;

    for (let i = 0; i < allVerts.length; i += stride) {
      allVerts[i] = (allVerts[i] - cx) * scaleX;
      allVerts[i + 1] = (allVerts[i + 1] - minY) * scaleY;
      allVerts[i + 2] = (allVerts[i + 2] - cz) * scaleZ;
    }

    this.boatMeshBuilder.loadBedMesh(allVerts, allIdx);

    // Update holo preview deps with new bed mesh data
    this.holoPreviewRenderer.setMeshDeps({
      bedMeshVerts: this.boatMeshBuilder.bedMeshVerts,
      bedMeshIdx: this.boatMeshBuilder.bedMeshIdx,
      bedMeshVertCount: this.boatMeshBuilder.bedMeshVertCount,
      generateCellMesh: (cell, cellMap, verts, idx, baseVi) =>
        this.boatMeshBuilder.generateCellMesh(cell, cellMap, verts, idx, baseVi),
      generateFBXCellMesh: (cell, cellMap, srcVerts, srcIdx, verts, idx, baseVi) =>
        this.boatMeshBuilder.generateFBXCellMesh(cell, cellMap, srcVerts, srcIdx, verts, idx, baseVi),
      genDeleteXCell: (cx, cy, cz, s, verts, idx, baseVi) =>
        this.boatMeshBuilder.genDeleteXCell(cx, cy, cz, s, verts, idx, baseVi),
    } as HoloMeshDeps);
  }

  // --- Terrain deformation ---
  applyTerrainDeformation(
    chunkX: number, chunkZ: number, isPort: boolean,
    worldX: number, worldY: number, worldZ: number,
    entityWorldX: number, entityWorldY: number, entityWorldZ: number,
    radius: number, strength: number,
  ): void {
    this.islandTerrainRenderer.applyTerrainDeformation(
      chunkX, chunkZ, isPort,
      worldX, worldY, worldZ,
      entityWorldX, entityWorldY, entityWorldZ,
      radius, strength,
    );
  }

  processPendingDeformations(): void {
    this.islandTerrainRenderer.processPendingDeformations();
  }

  processIslandChunkStream(playerX: number, playerZ: number): void {
    this.islandTerrainRenderer.processIslandChunkStream(playerX, playerZ);
  }

  preBakeAllChunks(playerX: number, playerZ: number): void {
    this.islandTerrainRenderer.preBakeAllChunks(playerX, playerZ);
  }

  // --- Voxel data ---
  getNearbyVoxelData(
    camX: number, camY: number, camZ: number,
    collisionRadius: number,
    maxVoxelFloats: number,
  ): {
    data: Float32Array;
    originX: number; originY: number; originZ: number;
    voxelSize: number;
    dimX: number; dimY: number; dimZ: number;
    isoLevel: number;
  } | null {
    return this.islandTerrainRenderer.getNearbyVoxelData(camX, camY, camZ, collisionRadius, maxVoxelFloats);
  }

  // --- Cleanup ---
  cleanupStaleDecorations(): void {
    this.islandTerrainRenderer.cleanupStaleDecorations();
  }

  cleanupStaleIslandMeshes(): void {
    this.islandTerrainRenderer.cleanupStaleIslandMeshes();
  }

  handleTerrainLODChange(chunkX: number, chunkZ: number, newVoxelSize: number): void {
    this.islandTerrainRenderer.handleTerrainLODChange(chunkX, chunkZ, newVoxelSize);
  }

  // --- Stats ---
  getLastFrameTriangles(): number {
    return this._lastFrameTriangles;
  }
}
