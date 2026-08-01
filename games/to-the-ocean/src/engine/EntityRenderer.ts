// ============================================================================
// Entity Renderer — renders all entity types (ships, fish, players, etc.)
// Boat entities use a dynamic cell-based mesh with auto-connecting tiles.
// ============================================================================

import { BoatBufferReader, MAX_BOATS, MAX_CELLS_PER_BOAT } from "@shared/boat-buffer";
import { RuntimeBoatGeometry, type BoatDesign } from "@shared/boat-design";
import { ANCHOR_BOW_OFFSET, ANCHOR_DEPTH, BOAT_CELL_WORLD_SIZE, BOAT_LAYER_HEIGHT, BoatCellType, MAX_BONES, MAX_ENTITIES, PLAYER_HEIGHT, PLAYER_RADIUS, WALL_THICKNESS, getCellGeometry, getPortColliderDims, getPortCollisionBoxes, getWallCollisionBoxes, hasSolidCollision, isWalkableSurface, isWallType } from "@shared/constants";
import { generateDecorationMesh, generateDecorations } from "@shared/IslandDecorations";
import { extractMesh, extractMeshSubRegion } from "@shared/MarchingCubes";
import { ENT, SimBufferReader } from "@shared/sim-buffer";
import { TERRAIN_CONFIG } from "@shared/TerrainConfig";
import {
  createChunkedVoxelField,
  generatePortVoxelField,
  getChunkMeshSubRegion,
  materializeChunkForMesh,
  type ChunkedFieldContext,
} from "@shared/TerrainGenerator";
import { ChunkedVoxelField, VoxelField, getChunkedVoxel, setChunkedVoxel } from "@shared/TerrainTypes";
import { BiomeType, EntityType, IslandSize, PortSize, PortTheme } from "@shared/types";
import { PerlinNoise } from "@shared/world/PerlinNoise";
import { CameraState } from "./CameraSystem";
import { DEPTH_FORMAT, MSAA_SAMPLE_COUNT } from "./graphicsConfig";
import { calculateViewProj } from "./mathUtils";
import type { MeshData, ModelData } from "./ModelLoader";
import { generatePortMesh } from "./PortMeshGenerator";
import { SkeletonAnimator } from "./SkeletonAnimator";


import {
  LIGHT_STRUCTS, PBR_BINDINGS, PBR_CONST, PBR_FUNCTIONS, LIGHTING_FN,
  LIGHTING_UNIFORMS, ENTITY_WGSL, INSTANCED_ENTITY_WGSL, PLAYER_WGSL,
  SKINNING_COMPUTE_WGSL, SKINNED_PLAYER_WGSL, BOAT_WGSL, ISLAND_WGSL,
  ISLAND_WIREFRAME_WGSL, ROPE_WGSL, HOLO_WGSL, HITBOX_WGSL,
} from "./shaders/entity-shaders";


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

// Direction offsets: 0=front(-Z), 1=right(+X), 2=back(+Z), 3=left(-X), 4=up(+Y), 5=down(-Y)
const DIR_OFFSETS: [number, number, number][] = [
  [0, 0, -1], // 0: front (-Z)
  [1, 0, 0],  // 1: right (+X)
  [0, 0, 1],  // 2: back (+Z)
  [-1, 0, 0], // 3: left (-X)
  [0, 1, 0],  // 4: up (+Y)
  [0, -1, 0], // 5: down (-Y)
];

// 2D polygon shape for a cell: vertices in clockwise order (viewed from top)
// plus edge info for neighbor culling (dir=-1 means always render)
interface Shape2D {
  polygon: [number, number][]; // [x, z] world coords, clockwise
  edges: { dir: number; p0: number; p1: number }[];
}

export class EntityRenderer {
  private static readonly MAX_DRAW_ENTITIES = 512;
  private static readonly MAX_HITBOX_ENTRIES = 4096;
  private static readonly MAX_BOAT_VERTS = MAX_BOATS * MAX_CELLS_PER_BOAT * 48 * 6;
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private boatPipeline: GPURenderPipeline | null = null;
  private islandPipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private cubeVertices: GPUBuffer | null = null;
  private cubeIndices: GPUBuffer | null = null;
  private cubeIndexCount = 0;

  private boatVertices: GPUBuffer | null = null;
  private boatIndices: GPUBuffer | null = null;
  private boatIndexCount = 0;
  private boatBufferReader: BoatBufferReader | null = null;
  private boatDesigns: Map<number, { design: BoatDesign; geometry: RuntimeBoatGeometry }> | null = null;
  private boatMeshDirty = true;
  private lastBoatSeq = -1;

  // Holo preview
  private holoPipeline: GPURenderPipeline | null = null;
  private holoVertices: GPUBuffer | null = null;
  private holoIndices: GPUBuffer | null = null;
  private holoIndexCount = 0;
  private holoVertCapacity = 0; // current vertex capacity (in floats)
  private holoIndexCapacity = 0; // current index capacity (in count)

  // Per-boat vertex offsets in the combined boat buffer
  private boatVertOffsets: number[] = [];
  private boatIndexOffsets: number[] = [];
  private boatIndexCounts: number[] = [];

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
  private viewProjCache: Float32Array | null = null;
  private cameraPosCache: [number, number, number] = [0, 0, 0];
  private lightingParamsCache: { sunDir: [number, number, number]; sunIntensity: number; ambient: number; fogColor: [number, number, number]; wetness: number } = {
    sunDir: [0.5, 0.8, 0.3], sunIntensity: 1.0, ambient: 0.5, fogColor: [0.0, 0.1, 0.2], wetness: 0,
  };

  // Reusable uniform arrays (avoids per-frame allocation)
  private reusableUniforms = new Float32Array(64);
  private reusableHbUniforms = new Float32Array(64);

  // Reusable holo preview arrays (avoids per-frame allocation)
  private holoVertsBuf: number[] = [];
  private holoIdxBuf: number[] = [];
  private holoEmptyCellMap = new Map<string, CellInfo>();

  // Reusable boat mesh rebuild arrays (avoids per-rebuild allocation)
  private boatAllVerts: number[] = [];
  private boatAllIdx: number[] = [];
  private boatSlotVerts: number[] = [];
  private boatSlotIdx: number[] = [];
  private boatCellMap = new Map<string, CellInfo>();
  private boatSeenSet = new Set<string>();

  // Player model mesh (loaded from FBX)
  private playerMeshVertices: GPUBuffer | null = null;
  private playerMeshIndices: GPUBuffer | null = null;
  private playerMeshIndexCount = 0;
  private playerMeshIndexFormat: GPUIndexFormat = "uint16";
  private playerPipeline: GPURenderPipeline | null = null;
  private playerBindGroup: GPUBindGroup | null = null;
  private playerBindGroupLayout: GPUBindGroupLayout | null = null;
  private playerTexture: GPUTexture | null = null;
  private playerSampler: GPUSampler | null = null;

  // Skinned player mesh (rigged character with skeletal animation)
  private skinnedPlayerVertices: GPUBuffer | null = null;
  private skinnedPlayerIndices: GPUBuffer | null = null;
  private skinnedPlayerIndexCount = 0;
  private skinnedPlayerIndexFormat: GPUIndexFormat = "uint16";
  private skinnedPlayerPipeline: GPURenderPipeline | null = null;
  private skinnedPlayerBindGroup: GPUBindGroup | null = null;
  private skinnedPlayerBindGroupLayout: GPUBindGroupLayout | null = null;
  private boneMatrixBuffer: GPUBuffer | null = null;
  private skeletonAnimator: SkeletonAnimator | null = null;

  // GPU skinning compute pipeline
  private skinningComputePipeline: GPUComputePipeline | null = null;
  private skinningComputeBindGroup: GPUBindGroup | null = null;
  private skinningComputeBindGroupLayout: GPUBindGroupLayout | null = null;
  private skinningUniformBuffer: GPUBuffer | null = null;
  private localPosBuffer: GPUBuffer | null = null;
  private localRotBuffer: GPUBuffer | null = null;
  private localScaleBuffer: GPUBuffer | null = null;
  private parentIndexBuffer: GPUBuffer | null = null;
  private inverseBindBuffer: GPUBuffer | null = null;
  private skinningBoneCount = 0;

  // Clothing pieces (rigged meshes sharing the same skeleton)
  private clothingPieces: { name: string; vertices: GPUBuffer; indices: GPUBuffer; indexCount: number; indexFormat: GPUIndexFormat; texture: GPUTexture | null; visible: boolean }[] = [];

  // Bed model mesh (loaded from FBX, pre-converted to boat vertex format)
  private bedMeshVerts: number[] = [];
  private bedMeshIdx: number[] = [];
  private bedMeshVertCount = 0;

  // Wireframe hitbox debug rendering (camera-facing quad lines)
  private hitboxPipeline: GPURenderPipeline | null = null;
  private anchorPipeline: GPURenderPipeline | null = null;
  private hitboxQuadVertices: GPUBuffer | null = null;
  private hitboxQuadIndices: GPUBuffer | null = null;
  private hitboxQuadIndexCount = 0;
  private showHitboxes = false;
  private hitboxUniformBuffer: GPUBuffer | null = null;
  private hitboxBindGroup: GPUBindGroup | null = null;
  private hitboxEntryCount = 0;
  private hitboxLineWidth = 3.0;
  private viewportWidth = 1;
  private viewportHeight = 1;

  // Per-island terrain meshes (keyed by "chunkX,chunkZ") — volumetric marching cubes
  private islandMeshes = new Map<string, {
    vertices: GPUBuffer;
    indices: GPUBuffer;
    indexCount: number;
    useUint32: boolean;
    lineIndices: GPUBuffer | null;
    lineIndexCount: number;
  }>();
  private activeIslandKeys = new Set<string>();
  private islandEmptyKeys = new Set<string>();
  private islandVoxelFields = new Map<string, VoxelField>();

  // Per-port terrain meshes (keyed by "chunkX,chunkZ") — flat plateau with beach/caves
  private portTerrainMeshes = new Map<string, {
    vertices: GPUBuffer;
    indices: GPUBuffer;
    indexCount: number;
    useUint32: boolean;
  }>();
  private activePortKeys = new Set<string>();
  private portEmptyKeys = new Set<string>();
  private portVoxelFields = new Map<string, VoxelField>();

  // Chunked island mesh streaming — for large islands, mesh is split into sub-chunks
  // that are generated progressively (nearest-first) with a per-frame time budget.
  private islandChunkMeshes = new Map<string, Map<string, { vertices: GPUBuffer; indices: GPUBuffer; indexCount: number; useUint32: boolean; lineIndices: GPUBuffer | null; lineIndexCount: number }>>(); // key -> chunkKey -> mesh
  private islandChunkPending = new Map<string, { x: number; y: number; z: number; chunkKey: string; distSq: number }[]>();
  private islandChunkField = new Map<string, VoxelField>(); // retained voxel field for chunked islands (legacy)
  private islandChunkTotalChunks = new Map<string, number>();
  private islandChunkCliffNoise = new Map<string, (x: number, y: number, z: number) => number>();
  // ChunkedVoxelField-based island storage (Phase 2)
  private islandChunkedFields = new Map<string, ChunkedVoxelField>();
  private islandChunkedCtxs = new Map<string, ChunkedFieldContext>();

  // Pending terrain deformations — queued from IPC, processed in render loop to avoid blocking
  private pendingDeformations: {
    chunkX: number; chunkZ: number; isPort: boolean;
    worldX: number; worldY: number; worldZ: number;
    entityWorldX: number; entityWorldY: number; entityWorldZ: number;
    radius: number; strength: number;
  }[] = [];

  // Island wireframe hitbox pipeline (line-list topology, shows actual trimesh collision surface)
  private islandWireframePipeline: GPURenderPipeline | null = null;

  // Anchor mesh buffers (built once, rendered at anchor positions)
  private anchorMeshVerts: GPUBuffer | null = null;
  private anchorMeshIdx: GPUBuffer | null = null;
  private anchorMeshIndexCount = 0;
  private chainLinkVerts: GPUBuffer | null = null;
  private chainLinkIdx: GPUBuffer | null = null;
  private chainLinkIndexCount = 0;
  private anchorPipeline3D: GPURenderPipeline | null = null;
  private static readonly ROPE_SEGMENTS = 16;      // catenary curve segments per rope

  // Dynamic light bind group (set once per frame from WebGPURenderer)
  private lightBindGroup: GPUBindGroup | null = null;

  // PBR bind group (BRDF LUT + sampler, set once at init from WebGPURenderer)
  private pbrBindGroup: GPUBindGroup | null = null;

  // Total draw entity count (for iterating drawEntityTypes in renderHitboxes)
  private drawEntityCount = 0;

  // --- Instanced rendering fields ---
  private instancedPipeline: GPURenderPipeline | null = null;
  private instancedFrameUniformBuffer: GPUBuffer | null = null;
  private instanceStorageBuffer: GPUBuffer | null = null;
  private instancedBindGroup: GPUBindGroup | null = null;
  private instancedBindGroupLayout: GPUBindGroupLayout | null = null;
  private instanceDataAb: ArrayBuffer | null = null;
  private instanceDataF32: Float32Array | null = null;
  private instanceDataU32: Uint32Array | null = null;
  private instanceCount = 0;
  private _lastFrameTriangles = 0;
  private frameUniformData = new Float32Array(32); // 128 bytes

  // Pooled voxel collision data (avoids per-frame allocation when weather particles active)
  private pooledVoxelData: Float32Array | null = null;
  private pooledVoxelResult: { data: Float32Array; originX: number; originY: number; originZ: number; voxelSize: number; dimX: number; dimY: number; dimZ: number; isoLevel: number } | null = null;
  private pooledNearby: { field: ChunkedVoxelField | VoxelField; isChunked: boolean; worldOriginX: number; worldOriginY: number; worldOriginZ: number; voxelSize: number; isoLevel: number }[] = [];

  // Per-island decoration meshes (keyed by "chunkX,chunkZ")
  private decorationMeshes = new Map<string, { vertices: GPUBuffer; indices: GPUBuffer; indexCount: number }>();
  private activeDecorationKeys = new Set<string>();
  private decorationEmptyKeys = new Set<string>();

  // Port structure meshes (keyed by "chunkX,chunkZ") — biome-specific procedural mesh
  private portStructureMeshes = new Map<string, {
    vertices: GPUBuffer;
    indices: GPUBuffer;
    indexCount: number;
    useUint32: boolean;
  }>();
  private activePortStructureKeys = new Set<string>();

  // Legacy: pre-generated port meshes (one per size) — kept as fallback
  private portVertices: (GPUBuffer | null)[] = [null, null, null];
  private portIndices: (GPUBuffer | null)[] = [null, null, null];
  private portIndexCounts: number[] = [0, 0, 0];
  private portNormalizationScales: number[] = [1, 1, 1];

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  setShowHitboxes(show: boolean): void {
    this.showHitboxes = show;
    if (show) {
      this.ensureIslandWireframes();
    }
  }

  isHitboxVisible(): boolean {
    return this.showHitboxes;
  }

  private ensureIslandWireframes(): void {
    for (const [key, mesh] of this.islandMeshes) {
      if (mesh.lineIndices || mesh.lineIndexCount > 0) continue;
      // Need the original index buffer to build line indices
      // We can read from the GPU index buffer, but it's simpler to rebuild from indexCount
      // Since we don't have the original indices anymore, we skip — wireframes will be
      // built for new islands. For existing ones, we'd need to re-extract. This is acceptable
      // because hitbox toggle is rare and new islands will get wireframes automatically.
    }
  }

  setHitboxLineWidth(width: number): void {
    this.hitboxLineWidth = Math.max(1, width);
  }

  getHitboxLineWidth(): number {
    return this.hitboxLineWidth;
  }

  setBoatBufferReader(reader: BoatBufferReader): void {
    this.boatBufferReader = reader;
    this.boatMeshDirty = true;
  }

  setBoatDesignReader(designs: Map<number, { design: BoatDesign; geometry: RuntimeBoatGeometry }>): void {
    this.boatDesigns = designs;
    this.boatMeshDirty = true;
  }

  setLightBindGroup(bg: GPUBindGroup): void {
    this.lightBindGroup = bg;
  }

  setPBRBindGroup(bg: GPUBindGroup): void {
    this.pbrBindGroup = bg;
  }

  async init(lightBindGroupLayout?: GPUBindGroupLayout, pbrBindGroupLayout?: GPUBindGroupLayout): Promise<void> {
    const shaderModule = this.device.createShaderModule({ code: ENTITY_WGSL });
    const boatShaderModule = this.device.createShaderModule({ code: BOAT_WGSL });

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
    this.device.queue.writeBuffer(this.cubeVertices, 0, verts);

    this.cubeIndexCount = indices.length;
    this.cubeIndices = this.device.createBuffer({
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.cubeIndices, 0, indices);

    // Boat mesh buffers (pre-allocated, rewritten when dirty)
    const maxBoatVertBytes = EntityRenderer.MAX_BOAT_VERTS * 36;
    this.boatVertices = this.device.createBuffer({
      size: maxBoatVertBytes,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.boatIndices = this.device.createBuffer({
      size: EntityRenderer.MAX_BOAT_VERTS * 2,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    // Lit pipeline layout includes the light storage buffer bind group at group 1.
    // Used by holo and anchor3D pipelines (non-PBR lit).
    const litPipelineLayout = lightBindGroupLayout
      ? this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout, lightBindGroupLayout] })
      : pipelineLayout;

    // PBR lit pipeline layout includes light storage (group 1) + PBR BRDF LUT (group 2).
    // Used by entity, boat, island pipelines that use Cook-Torrance BRDF with IBL.
    const pbrLitPipelineLayout = (lightBindGroupLayout && pbrBindGroupLayout)
      ? this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout, lightBindGroupLayout, pbrBindGroupLayout] })
      : litPipelineLayout;

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
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

    // --- Instanced entity pipeline ---
    const instancedShaderModule = this.device.createShaderModule({ code: INSTANCED_ENTITY_WGSL });
    this.instancedFrameUniformBuffer = this.device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.instanceStorageBuffer = this.device.createBuffer({
      size: MAX_ENTITIES * 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.instanceDataAb = new ArrayBuffer(MAX_ENTITIES * 48);
    this.instanceDataF32 = new Float32Array(this.instanceDataAb);
    this.instanceDataU32 = new Uint32Array(this.instanceDataAb);

    this.instancedBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });
    this.instancedBindGroup = this.device.createBindGroup({
      layout: this.instancedBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.instancedFrameUniformBuffer, size: 256 } },
        { binding: 1, resource: { buffer: this.instanceStorageBuffer } },
      ],
    });

    const instancedLitLayout = (lightBindGroupLayout && pbrBindGroupLayout)
      ? this.device.createPipelineLayout({ bindGroupLayouts: [this.instancedBindGroupLayout, lightBindGroupLayout, pbrBindGroupLayout] })
      : lightBindGroupLayout
        ? this.device.createPipelineLayout({ bindGroupLayouts: [this.instancedBindGroupLayout, lightBindGroupLayout] })
        : this.device.createPipelineLayout({ bindGroupLayouts: [this.instancedBindGroupLayout] });

    this.instancedPipeline = this.device.createRenderPipeline({
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
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

    this.boatPipeline = this.device.createRenderPipeline({
      layout: pbrLitPipelineLayout,
      vertex: {
        module: boatShaderModule,
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
        module: boatShaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

    // Island pipeline — flat-shaded low-poly (pos+normal+color, 36 bytes stride)
    const islandShaderModule = this.device.createShaderModule({ code: ISLAND_WGSL });
    this.islandPipeline = this.device.createRenderPipeline({
      layout: pbrLitPipelineLayout,
      vertex: {
        module: islandShaderModule,
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
        module: islandShaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

    // Holo preview pipeline (translucent, no depth write)
    const holoShaderModule = this.device.createShaderModule({ code: HOLO_WGSL });
    this.holoPipeline = this.device.createRenderPipeline({
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
          format: this.format,
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

    // Holo preview buffers (dynamic, rewritten each frame with cell shape geometry)
    // Start small; will auto-resize via ensureHoloCapacity when FBX models need more
    this.holoVertices = this.device.createBuffer({
      size: 128 * 36,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.holoVertCapacity = 128;
    this.holoIndexCount = 0;
    this.holoIndices = this.device.createBuffer({
      size: 192 * 2,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.holoIndexCapacity = 192;

    // Player textured pipeline (position + normal + uv = 32 bytes)
    const playerShaderModule = this.device.createShaderModule({ code: PLAYER_WGSL });
    const playerBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      ],
    });
    this.playerBindGroupLayout = playerBindGroupLayout;
    this.playerSampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat",
    });
    // Create a 1x1 white fallback texture so pipeline works before real texture is set
    this.playerTexture = this.device.createTexture({
      size: [1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: this.playerTexture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    );
    this.playerBindGroup = this.device.createBindGroup({
      layout: playerBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer, size: 256 } },
        { binding: 1, resource: this.playerSampler },
        { binding: 2, resource: this.playerTexture.createView() },
      ],
    });
    this.playerPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: (lightBindGroupLayout && pbrBindGroupLayout)
          ? [playerBindGroupLayout, lightBindGroupLayout, pbrBindGroupLayout]
          : lightBindGroupLayout
            ? [playerBindGroupLayout, lightBindGroupLayout]
            : [playerBindGroupLayout],
      }),
      vertex: {
        module: playerShaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 44, // 3 pos + 3 normal + 2 uv + 3 color
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x2" },
            { shaderLocation: 3, offset: 32, format: "float32x3" },
          ],
        }],
      },
      fragment: {
        module: playerShaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

    // Skinned player pipeline (position + normal + uv + color + joints + weights)
    const skinnedPlayerShaderModule = this.device.createShaderModule({ code: SKINNED_PLAYER_WGSL });
    const skinnedPlayerBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });
    this.skinnedPlayerBindGroupLayout = skinnedPlayerBindGroupLayout;

    // Bone matrix storage buffer: MAX_BONES * 16 floats * 4 bytes
    // Written by compute shader, read by vertex shader
    this.boneMatrixBuffer = this.device.createBuffer({
      size: MAX_BONES * 16 * 4,
      usage: GPUBufferUsage.STORAGE,
    });

    // Skinning compute pipeline
    const skinningComputeShaderModule = this.device.createShaderModule({ code: SKINNING_COMPUTE_WGSL });
    const skinningComputeBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    this.skinningComputeBindGroupLayout = skinningComputeBindGroupLayout;
    this.skinningComputePipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [skinningComputeBindGroupLayout],
      }),
      compute: {
        module: skinningComputeShaderModule,
        entryPoint: "cs_main",
      },
    });

    this.skinnedPlayerPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: (lightBindGroupLayout && pbrBindGroupLayout)
          ? [skinnedPlayerBindGroupLayout, lightBindGroupLayout, pbrBindGroupLayout]
          : lightBindGroupLayout
            ? [skinnedPlayerBindGroupLayout, lightBindGroupLayout]
            : [skinnedPlayerBindGroupLayout],
      }),
      vertex: {
        module: skinnedPlayerShaderModule,
        entryPoint: "vs_main",
        buffers: [{
          // pos(12) + normal(12) + uv(8) + color(12) + joints(4, uint8x4) + weights(16, float32x4) = 64 bytes
          arrayStride: 64,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },    // position
            { shaderLocation: 1, offset: 12, format: "float32x3" },   // normal
            { shaderLocation: 2, offset: 24, format: "float32x2" },   // uv
            { shaderLocation: 3, offset: 32, format: "float32x3" },   // color
            { shaderLocation: 4, offset: 44, format: "uint8x4" },     // joints (4 bytes)
            { shaderLocation: 5, offset: 48, format: "float32x4" },   // weights (16 bytes)
          ],
        }],
      },
      fragment: {
        module: skinnedPlayerShaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

    // Thick wireframe hitbox pipeline — camera-facing quad lines with adjustable width
    const hitboxShaderModule = this.device.createShaderModule({ code: HITBOX_WGSL });
    this.hitboxPipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: hitboxShaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 32, // endpointA(3) + endpointB(3) + cornerVec(2) = 8 floats
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
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: "less",
      },
    });

    // Anchor pipeline: same as hitbox but always passes depth test (visible through water/terrain)
    this.anchorPipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
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
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: "always",
      },
    });

    // Build anchor mesh: cylindrical shank + stock, triangular flukes, crown
    // Vertex format: pos3 + normal3 + color3 = 9 floats per vertex
    const av: number[] = [];
    const ai: number[] = [];
    const darkIron = [0.22, 0.20, 0.19];
    const lightIron = [0.38, 0.35, 0.32];
    const rustColor = [0.40, 0.22, 0.12];

    // Helper: push n-sided prism (cylinder) along Y axis with rotation around X then Z
    const pushPrism = (cx: number, cy: number, cz: number, radius: number, length: number, sides: number, rotX: number, rotZ: number, color: number[]) => {
      const base = av.length / 9;
      const halfLen = length / 2;
      const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
      const cosZ = Math.cos(rotZ), sinZ = Math.sin(rotZ);
      const rot = (x: number, y: number, z: number): [number, number, number] => {
        let ry = y * cosX - z * sinX;
        let rz = y * sinX + z * cosX;
        let rx = x * cosZ - ry * sinZ;
        ry = x * sinZ + ry * cosZ;
        return [rx, ry, rz];
      };
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        const x = Math.cos(a) * radius, z = Math.sin(a) * radius;
        const [tx, ty, tz] = rot(x, halfLen, z);
        const [bx, by, bz] = rot(x, -halfLen, z);
        const [nx, ny, nz] = rot(x, 0, z);
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        av.push(cx + tx, cy + ty, cz + tz, nx / nl, ny / nl, nz / nl, color[0], color[1], color[2]);
        av.push(cx + bx, cy + by, cz + bz, nx / nl, ny / nl, nz / nl, color[0], color[1], color[2]);
      }
      for (let i = 0; i < sides; i++) {
        const ni = (i + 1) % sides;
        ai.push(base + i * 2, base + ni * 2, base + i * 2 + 1, base + ni * 2, base + ni * 2 + 1, base + i * 2 + 1);
      }
      const tc = av.length / 9;
      const [tcx, tcy, tcz] = rot(0, halfLen, 0);
      const [tnx, tny, tnz] = rot(0, 1, 0);
      av.push(cx + tcx, cy + tcy, cz + tcz, tnx, tny, tnz, color[0], color[1], color[2]);
      for (let i = 0; i < sides; i++) ai.push(tc, base + ((i + 1) % sides) * 2, base + i * 2);
      const bc = av.length / 9;
      const [bcx, bcy, bcz] = rot(0, -halfLen, 0);
      const [bnx, bny, bnz] = rot(0, -1, 0);
      av.push(cx + bcx, cy + bcy, cz + bcz, bnx, bny, bnz, color[0], color[1], color[2]);
      for (let i = 0; i < sides; i++) ai.push(bc, base + i * 2 + 1, base + ((i + 1) % sides) * 2 + 1);
    };

    // Helper: push triangular fluke plate (tip pointing +X, extruded along Z, rotated around Z)
    const pushFluke = (cx: number, cy: number, cz: number, halfWidth: number, length: number, thickness: number, rotZ: number, color: number[]) => {
      const cosZ = Math.cos(rotZ), sinZ = Math.sin(rotZ);
      const rot = (x: number, y: number): [number, number] => [x * cosZ - y * sinZ, x * sinZ + y * cosZ];
      const tri: [number, number][] = [[length / 2, 0], [-length / 2, -halfWidth], [-length / 2, halfWidth]];
      // Front + back faces
      const frontBase = av.length / 9;
      for (const [x, y] of tri) { const [rx, ry] = rot(x, y); av.push(cx + rx, cy + ry, cz + thickness / 2, 0, 0, 1, color[0], color[1], color[2]); }
      ai.push(frontBase, frontBase + 1, frontBase + 2);
      const backBase = av.length / 9;
      for (const [x, y] of tri) { const [rx, ry] = rot(x, y); av.push(cx + rx, cy + ry, cz - thickness / 2, 0, 0, -1, color[0], color[1], color[2]); }
      ai.push(backBase, backBase + 2, backBase + 1);
      // Side faces with proper normals
      for (let e = 0; e < 3; e++) {
        const ne = (e + 1) % 3;
        const ex = tri[ne][0] - tri[e][0], ey = tri[ne][1] - tri[e][1];
        const elen = Math.sqrt(ex * ex + ey * ey) || 1;
        const [nx, ny] = rot(ey / elen, -ex / elen);
        const [v0x, v0y] = rot(tri[e][0], tri[e][1]);
        const [v1x, v1y] = rot(tri[ne][0], tri[ne][1]);
        const sb = av.length / 9;
        av.push(cx + v0x, cy + v0y, cz + thickness / 2, nx, ny, 0, color[0], color[1], color[2]);
        av.push(cx + v1x, cy + v1y, cz + thickness / 2, nx, ny, 0, color[0], color[1], color[2]);
        av.push(cx + v1x, cy + v1y, cz - thickness / 2, nx, ny, 0, color[0], color[1], color[2]);
        av.push(cx + v0x, cy + v0y, cz - thickness / 2, nx, ny, 0, color[0], color[1], color[2]);
        ai.push(sb, sb + 1, sb + 2, sb, sb + 2, sb + 3);
      }
    };

    // Shank: vertical cylinder (y: 0.5 to -1.0)
    pushPrism(0, -0.25, 0, 0.07, 1.5, 8, 0, 0, darkIron);
    // Stock: horizontal cylinder along X near top
    pushPrism(0, 0.3, 0, 0.04, 0.8, 8, 0, Math.PI / 2, lightIron);
    // Crown: horizontal cylinder along X at bottom
    pushPrism(0, -0.95, 0, 0.05, 0.22, 8, 0, Math.PI / 2, lightIron);
    // Right fluke: triangular plate pointing right, slightly down
    pushFluke(0.08, -0.9, 0, 0.16, 0.5, 0.025, -0.15, rustColor);
    // Left fluke: triangular plate pointing left, slightly down
    pushFluke(-0.08, -0.9, 0, 0.16, 0.5, 0.025, Math.PI + 0.15, rustColor);
    // Ring at top: short wide cylinder perpendicular (for chain attachment)
    pushPrism(0, 0.55, 0, 0.06, 0.08, 8, Math.PI / 2, 0, lightIron);

    const anchorVerts = new Float32Array(av);
    const anchorIdx = new Uint16Array(ai);
    this.anchorMeshIndexCount = anchorIdx.length;
    this.anchorMeshVerts = this.device.createBuffer({
      size: anchorVerts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.anchorMeshVerts, 0, anchorVerts);
    this.anchorMeshIdx = this.device.createBuffer({
      size: anchorIdx.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.anchorMeshIdx, 0, anchorIdx);

    // Build chain link mesh: small cylinder along Y axis
    const cv: number[] = [];
    const ci: number[] = [];
    const chainColor = [0.30, 0.27, 0.24];
    const linkSides = 6;
    const linkRadius = 0.04;
    const linkLength = 0.25;
    {
      const base = cv.length / 9;
      const halfLen = linkLength / 2;
      for (let i = 0; i < linkSides; i++) {
        const a = (i / linkSides) * Math.PI * 2;
        const x = Math.cos(a) * linkRadius, z = Math.sin(a) * linkRadius;
        cv.push(x, halfLen, z, x, 0, z, chainColor[0], chainColor[1], chainColor[2]);
        cv.push(x, -halfLen, z, x, 0, z, chainColor[0], chainColor[1], chainColor[2]);
      }
      for (let i = 0; i < linkSides; i++) {
        const ni = (i + 1) % linkSides;
        ci.push(base + i * 2, base + ni * 2, base + i * 2 + 1, base + ni * 2, base + ni * 2 + 1, base + i * 2 + 1);
      }
      const tc = cv.length / 9;
      cv.push(0, halfLen, 0, 0, 1, 0, chainColor[0], chainColor[1], chainColor[2]);
      for (let i = 0; i < linkSides; i++) ci.push(tc, base + ((i + 1) % linkSides) * 2, base + i * 2);
      const bc = cv.length / 9;
      cv.push(0, -halfLen, 0, 0, -1, 0, chainColor[0], chainColor[1], chainColor[2]);
      for (let i = 0; i < linkSides; i++) ci.push(bc, base + i * 2 + 1, base + ((i + 1) % linkSides) * 2 + 1);
    }
    const chainVerts = new Float32Array(cv);
    const chainIdx = new Uint16Array(ci);
    this.chainLinkIndexCount = chainIdx.length;
    this.chainLinkVerts = this.device.createBuffer({
      size: chainVerts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.chainLinkVerts, 0, chainVerts);
    this.chainLinkIdx = this.device.createBuffer({
      size: chainIdx.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.chainLinkIdx, 0, chainIdx);

    // Anchor 3D pipeline: same as boat pipeline but depthCompare: always so anchor
    // is visible through water and terrain (anchor sits on seabed below water)
    this.anchorPipeline3D = this.device.createRenderPipeline({
      layout: pbrLitPipelineLayout,
      vertex: {
        module: boatShaderModule,
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
        module: boatShaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: "always",
      },
    });

    // Build quad vertices for 12 cube edges × 4 corners = 48 vertices.
    // Each vertex: endpointA(3f) + endpointB(3f) + cornerVec(2f).
    // cornerVec.x = 0 for endpointA, 1 for endpointB; .y = ±1 for perpendicular offset side.
    const cubeEdges: number[][] = [
      // Bottom face (y = -0.5)
      [-0.5, -0.5, -0.5,  0.5, -0.5, -0.5],
      [ 0.5, -0.5, -0.5,  0.5, -0.5,  0.5],
      [ 0.5, -0.5,  0.5, -0.5, -0.5,  0.5],
      [-0.5, -0.5,  0.5, -0.5, -0.5, -0.5],
      // Top face (y = 0.5)
      [-0.5,  0.5, -0.5,  0.5,  0.5, -0.5],
      [ 0.5,  0.5, -0.5,  0.5,  0.5,  0.5],
      [ 0.5,  0.5,  0.5, -0.5,  0.5,  0.5],
      [-0.5,  0.5,  0.5, -0.5,  0.5, -0.5],
      // Vertical edges
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
    this.hitboxQuadVertices = this.device.createBuffer({
      size: quadVerts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.hitboxQuadVertices, 0, quadVerts);

    // Quad indices: 12 quads × 6 indices = 72
    const quadIndices = new Uint16Array(12 * 6);
    let qi = 0;
    for (let ei = 0; ei < 12; ei++) {
      const b = ei * 4;
      quadIndices[qi++] = b + 0; quadIndices[qi++] = b + 1; quadIndices[qi++] = b + 2;
      quadIndices[qi++] = b + 0; quadIndices[qi++] = b + 2; quadIndices[qi++] = b + 3;
    }
    this.hitboxQuadIndexCount = quadIndices.length;
    this.hitboxQuadIndices = this.device.createBuffer({
      size: quadIndices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.hitboxQuadIndices, 0, quadIndices);

    // Separate uniform buffer for hitbox rendering (collision-scale cubes)
    // Sized for per-cell entries (boats can have many cells)
    this.hitboxUniformBuffer = this.device.createBuffer({
      size: 256 * EntityRenderer.MAX_HITBOX_ENTRIES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.hitboxBindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout!,
      entries: [{ binding: 0, resource: { buffer: this.hitboxUniformBuffer, size: 256 } }],
    });

    // Per-island terrain meshes are generated on demand in ensureIslandMesh().
    // The island pipeline (flat-shaded, pos+normal+color) and wireframe pipeline are created here.

    // Island wireframe pipeline — line-list, position-only, green hitbox color.
    // Uses same bind group layout / uniform buffer as island pipeline.
    const islandWireframeModule = this.device.createShaderModule({ code: ISLAND_WIREFRAME_WGSL });
    this.islandWireframePipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: islandWireframeModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 36, // pos3 + normal3 + color3 = 9 floats (same buffer as island mesh)
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
          ],
        }],
      },
      fragment: {
        module: islandWireframeModule,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "line-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: "less",
      },
    });

    // Generate procedural port meshes (one per size, normalized to unit scale)
    // These are fallback meshes — actual port entities use on-demand biome-specific meshes
    const portSizes = [PortSize.Small, PortSize.Medium, PortSize.Large];
    for (let ps = 0; ps < 3; ps++) {
      const portMesh = generatePortMesh({
        size: portSizes[ps],
        theme: PortTheme.Fishing,
        services: [],
        seed: 1000 + ps * 100,
        biome: BiomeType.Ocean,
      });

      // Find max extent for normalization (so mesh fits in unit cube)
      let maxExtent = 0;
      for (let vi = 0; vi < portMesh.vertices.length; vi += 9) {
        const x = portMesh.vertices[vi];
        const y = portMesh.vertices[vi + 1];
        const z = portMesh.vertices[vi + 2];
        maxExtent = Math.max(maxExtent, Math.abs(x), Math.abs(y), Math.abs(z));
      }
      const normScale = maxExtent > 0 ? 1 / maxExtent : 1;
      this.portNormalizationScales[ps] = normScale;

      // Normalize vertices
      const verts = new Float32Array(portMesh.vertices.length);
      for (let vi = 0; vi < portMesh.vertices.length; vi += 9) {
        verts[vi] = portMesh.vertices[vi] * normScale;
        verts[vi + 1] = portMesh.vertices[vi + 1] * normScale;
        verts[vi + 2] = portMesh.vertices[vi + 2] * normScale;
        // Copy normals and colors as-is
        for (let j = 3; j < 9; j++) {
          verts[vi + j] = portMesh.vertices[vi + j];
        }
      }

      // Determine index format
      const vertCount = portMesh.vertices.length / 9;
      const useUint32 = vertCount > 65535;
      const indices = useUint32
        ? new Uint32Array(portMesh.indices)
        : new Uint16Array(portMesh.indices);

      this.portVertices[ps] = this.device.createBuffer({
        size: verts.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(this.portVertices[ps]!, 0, verts as any);

      this.portIndexCounts[ps] = portMesh.indices.length;
      this.portIndices[ps] = this.device.createBuffer({
        size: indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(this.portIndices[ps]!, 0, indices as any);
    }
  }

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
    this.activeDecorationKeys.clear();

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

    // Reset per-frame counters for instanced rendering and hitboxes
    this.instanceCount = 0;
    this.hitboxEntryCount = 0;
    this.drawEntityCount = 0;

    // Write frame-level uniform buffer for instanced pipeline
    if (this.instancedFrameUniformBuffer && this.viewProjCache) {
      const fu = this.frameUniformData;
      for (let i = 0; i < 16; i++) fu[i] = this.viewProjCache[i];
      fu[16] = this.cameraPosCache[0];
      fu[17] = this.cameraPosCache[1];
      fu[18] = this.cameraPosCache[2];
      fu[19] = performance.now() / 1000;
      const lp = this.lightingParamsCache;
      if (lp) {
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
      }
      this.device.queue.writeBuffer(this.instancedFrameUniformBuffer, 0, fu);
    }
  }

  private rebuildBoatMesh(): void {
    if (!this.boatBufferReader || !this.boatVertices || !this.boatIndices) return;

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
        if (cells.length === 0) {
          this.boatIndexCounts[slot] = 0;
          continue;
        }

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

      // Adjust indices to global offset
      for (let i = 0; i < slotIdx.length; i++) {
        allIdx.push(slotIdx[i] + vertOffset);
      }
      for (let i = 0; i < slotVerts.length; i++) {
        allVerts.push(slotVerts[i]);
      }
      this.boatIndexCounts[slot] = slotIdx.length;
    }

    if (allVerts.length === 0) {
      this.boatIndexCount = 0;
      return;
    }

    const vertData = new Float32Array(allVerts);
    const idxData = new Uint16Array(allIdx);
    this.device.queue.writeBuffer(this.boatVertices, 0, vertData);
    // WebGPU requires buffer writes to be 4-byte aligned; pad if odd index count
    if (idxData.byteLength % 4 !== 0) {
      const padded = new Uint16Array(allIdx.length + 1);
      padded.set(idxData);
      this.device.queue.writeBuffer(this.boatIndices, 0, padded);
    } else {
      this.device.queue.writeBuffer(this.boatIndices, 0, idxData);
    }
    this.boatIndexCount = idxData.length;
  }

  private generateDesignMesh(
    geometry: RuntimeBoatGeometry,
    verts: number[],
    idx: number[],
    baseVi: number,
  ): void {
    const { positions, normals, indices } = geometry.getMeshBuffers();
    const color: [number, number, number] = [0.45, 0.35, 0.25];
    const vCount = positions.length / 3;
    for (let i = 0; i < vCount; i++) {
      verts.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      verts.push(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
      verts.push(color[0], color[1], color[2]);
    }
    for (let i = 0; i < indices.length; i++) {
      idx.push(baseVi + indices[i]);
    }
  }

  // --- 2D layer extrusion mesh generation ---
  // Each cell is defined as a 2D polygon (top-down) that gets extruded vertically.
  // Side faces are culled when a neighbor cell exists in that direction.

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
        // Triangle: point at front, full width at back
        shape = {
          polygon: [[cx, z0], [x1, z1], [x0, z1]],
          edges: [
            { dir: -1, p0: 0, p1: 1 }, // right diagonal
            { dir: 2, p0: 1, p1: 2 },  // back
            { dir: -1, p0: 2, p1: 0 }, // left diagonal
          ],
        };
        break;

      case BoatCellType.WALL_STRAIGHT: {
        // Thin wall at front edge (-Z), spanning full X. Rotation places at other edges.
        const w = WALL_THICKNESS;
        shape = {
          polygon: [[x0, z0], [x1, z0], [x1, z0 + w], [x0, z0 + w]],
          edges: [
            { dir: 0, p0: 0, p1: 1 },  // front (-Z) outer edge — cull if neighbor
            { dir: -1, p0: 1, p1: 2 }, // right cap — always render
            { dir: -1, p0: 2, p1: 3 }, // inner edge — always render
            { dir: -1, p0: 3, p1: 0 }, // left cap — always render
          ],
        };
        break;
      }

      case BoatCellType.WALL_CORNER: {
        // L-shape at front-left corner: front arm (full X) + left arm (full Z)
        const w = WALL_THICKNESS;
        shape = {
          polygon: [
            [x0, z0],         // 0: front-left outer corner
            [x1, z0],         // 1: front-right end
            [x1, z0 + w],     // 2: inner right end of front arm
            [x0 + w, z0 + w], // 3: concave inner corner
            [x0 + w, z1],     // 4: inner bottom end of left arm
            [x0, z1],         // 5: back-left end
          ],
          edges: [
            { dir: 0, p0: 0, p1: 1 },  // front edge — cull if neighbor -Z
            { dir: -1, p0: 1, p1: 2 }, // right cap — always render
            { dir: -1, p0: 2, p1: 3 }, // concave inner — always render
            { dir: -1, p0: 3, p1: 4 }, // inner cap — always render
            { dir: -1, p0: 4, p1: 5 }, // back cap — always render
            { dir: 3, p0: 5, p1: 0 },  // left edge — cull if neighbor -X
          ],
        };
        break;
      }

      case BoatCellType.WALL_CURVED: {
        // Quarter-circle arc at front-left corner, centered at (x0, z0)
        const w = WALL_THICKNESS;
        const ro = s;           // outer radius
        const ri = s - w;       // inner radius
        const ox = x0, oz = z0; // arc center at front-left corner
        const steps = 3;
        const poly: [number, number][] = [];
        // Outer arc: angle 0 (along +X) to 90° (along +Z)
        for (let i = 0; i <= steps + 1; i++) {
          const a = (i / (steps + 1)) * Math.PI / 2;
          poly.push([ox + ro * Math.cos(a), oz + ro * Math.sin(a)]);
        }
        // Inner arc: angle 90° back to 0°
        for (let i = steps; i >= 0; i--) {
          const a = (i / (steps + 1)) * Math.PI / 2;
          poly.push([ox + ri * Math.cos(a), oz + ri * Math.sin(a)]);
        }
        const edges: { dir: number; p0: number; p1: number }[] = [];
        for (let i = 0; i < poly.length; i++) {
          edges.push({ dir: -1, p0: i, p1: (i + 1) % poly.length });
        }
        shape = { polygon: poly, edges };
        break;
      }

      case BoatCellType.WALL_DIAGONAL: {
        // Thin parallelogram from front-left to back-right corner
        const o = WALL_THICKNESS / (2 * Math.sqrt(2));
        shape = {
          polygon: [
            [x0 - o, z0 + o], [x1 - o, z1 + o],
            [x1 + o, z1 - o], [x0 + o, z0 - o],
          ],
          edges: [
            { dir: -1, p0: 0, p1: 1 }, { dir: -1, p0: 1, p1: 2 },
            { dir: -1, p0: 2, p1: 3 }, { dir: -1, p0: 3, p1: 0 },
          ],
        };
        break;
      }

      case BoatCellType.HULL_CURVE_L:
        // Trapezoid: full back, narrows to center-front (left side curves in)
        shape = {
          polygon: [[cx, z0], [x1, z0], [x1, z1], [x0, z1]],
          edges: [
            { dir: -1, p0: 0, p1: 1 }, // front-right partial
            { dir: 1, p0: 1, p1: 2 },  // right
            { dir: 2, p0: 2, p1: 3 },  // back
            { dir: -1, p0: 3, p1: 0 }, // left diagonal
          ],
        };
        break;

      case BoatCellType.HULL_CURVE_R:
        // Trapezoid: full back, narrows to center-front (right side curves in)
        shape = {
          polygon: [[x0, z0], [cx, z0], [x1, z1], [x0, z1]],
          edges: [
            { dir: -1, p0: 0, p1: 1 }, // front-left partial
            { dir: -1, p0: 1, p1: 2 }, // right diagonal
            { dir: 2, p0: 2, p1: 3 },  // back
            { dir: 3, p0: 3, p1: 0 },  // left
          ],
        };
        break;

      default:
        // Square cell (HULL, STERN, WALL, CABIN, MAST, HELM, RAIL, DECK, BRIDGE, PONTOON)
        shape = {
          polygon: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]],
          edges: [
            { dir: 0, p0: 0, p1: 1 }, // front (-Z)
            { dir: 1, p0: 1, p1: 2 }, // right (+X)
            { dir: 2, p0: 2, p1: 3 }, // back (+Z)
            { dir: 3, p0: 3, p1: 0 }, // left (-X)
          ],
        };
        break;
    }

    // Apply rotation to polygon and edge directions
    if (rot > 0) {
      const angle = rot * Math.PI / 2;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      shape = {
        polygon: shape.polygon.map(([px, pz]) => [
          cx + (px - cx) * cosA - (pz - cz) * sinA,
          cz + (px - cx) * sinA + (pz - cz) * cosA,
        ] as [number, number]),
        edges: shape.edges.map(e => ({
          dir: e.dir >= 0 ? (e.dir + rot) % 4 : -1,
          p0: e.p0,
          p1: e.p1,
        })),
      };
    }

    return shape;
  }

  private generateFBXCellMesh(
    cell: CellInfo,
    cellMap: Map<string, CellInfo>,
    srcVerts: number[],
    srcIdx: number[],
    verts: number[],
    idx: number[],
    baseVi: number,
  ): void {
    // Transform pre-converted FBX mesh (already Y-up, normalized to fit cell footprint)
    // to the cell's world position with rotation applied.
    // srcVerts format: [px, py, pz, nx, ny, nz, r, g, b] = 9 floats per vertex
    const stride = 9;
    const rot = cell.rotation % 4;
    const cosA = rot > 0 ? Math.cos(rot * Math.PI / 2) : 1;
    const sinA = rot > 0 ? Math.sin(rot * Math.PI / 2) : 0;

    // Cell center in world space (origin cell is at min corner of multi-cell footprint)
    const sx = cell.sizeX || 1;
    const sz = cell.sizeZ || 1;
    const cx = cell.gridX * BOAT_CELL_WORLD_SIZE + (sx - 1) * BOAT_CELL_WORLD_SIZE / 2;
    const cz = cell.gridZ * BOAT_CELL_WORLD_SIZE + (sz - 1) * BOAT_CELL_WORLD_SIZE / 2;

    // Compute floor Y: sit on top of the cell below, not at the layer base
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

      // Apply 2D rotation around Y axis
      if (rot > 0) {
        const rx = px * cosA - pz * sinA;
        const rz = px * sinA + pz * cosA;
        px = rx;
        pz = rz;
        const rnx = nx * cosA - nz * sinA;
        const rnz = nx * sinA + nz * cosA;
        nx = rnx;
        nz = rnz;
      }

      // Translate to cell position
      verts.push(px + cx, py + floorY, pz + cz, nx, ny, nz, r, g, b);
    }

    for (let i = 0; i < srcIdx.length; i++) {
      idx.push(srcIdx[i] + baseVi);
    }
  }

  private generateCellMesh(
    cell: CellInfo,
    cellMap: Map<string, CellInfo>,
    verts: number[],
    idx: number[],
    baseVi: number,
  ): void {
    const cy = cell.gridY * BOAT_LAYER_HEIGHT;
    const h = getCellGeometry(cell.type);
    const y0 = cy + h.y0;
    // For multi-cell height (sizeY > 1), add (sizeY-1) layers to y1
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

    // Check if neighbor's geometry fully covers this cell's face in the given direction.
    // Only cull when the neighbor's height range aligns — prevents gaps between
    // cells of different heights (e.g. pontoon with something built on top).
    const neighborCoversFace = (dir: number): boolean => {
      if (dir < 0) return false;
      const [dx, dy, dz] = DIR_OFFSETS[dir];
      const neighbor = cellMap.get(`${cell.gridX + dx},${cell.gridY + dy},${cell.gridZ + dz}`);
      if (!neighbor) return false;
      const nh = getCellGeometry(neighbor.type);
      const ncy = neighbor.gridY * BOAT_LAYER_HEIGHT;
      const ny0 = ncy + nh.y0;
      const ny1 = ncy + nh.y1;
      if (dir === 4) {
        // Top face: neighbor above must have its bottom at or below this cell's top
        return ny0 <= y1 + 0.01;
      }
      if (dir === 5) {
        // Bottom face: neighbor below must have its top at or above this cell's bottom
        return ny1 >= y0 - 0.01;
      }
      // Side faces: neighbor must cover this cell's full height range
      return ny0 <= y0 + 0.01 && ny1 >= y1 - 0.01;
    };

    const isHullType = (t: number) =>
      t === BoatCellType.HULL || t === BoatCellType.BOW || t === BoatCellType.BOW_MODERN ||
      t === BoatCellType.HULL_CURVE_L || t === BoatCellType.HULL_CURVE_R ||
      t === BoatCellType.STERN || t === BoatCellType.PONTOON;
    const isHull = isHullType(cell.type);

    // V-hull: determine which vertices are on outer edges (all adjacent edges have no neighbor)
    const vertexIsOuter: boolean[] = poly.map((_, i) => {
      const adj = shape.edges.filter(e => e.p0 === i || e.p1 === i);
      return adj.length > 0 && adj.every(e => !hasNeighbor(e.dir) && e.dir >= 0);
    });

    // V-hull narrowing factor — only outer vertices of hull cells are pulled inward
    const vScale = isHull ? 0.55 : 1.0;

    // Bottom polygon (narrowed for V-hull on outer vertices)
    const bottomPoly: [number, number][] = poly.map(([px, pz], i) => {
      if (isHull && vertexIsOuter[i]) {
        return [
          cx + (px - cx) * vScale,
          cz + (pz - cz) * vScale,
        ] as [number, number];
      }
      return [px, pz] as [number, number];
    });

    // Per-vertex top heights (sheer line + bow rake)
    const topY: number[] = poly.map(([px, pz], i) => {
      let y = y1;
      if (isHull) {
        // Sheer: raise based on distance from midship (world Z)
        const distFromMid = Math.abs(pz);
        y += Math.max(0, distFromMid - 2) * 0.05;
        // Bow rake: extra raise for bow front vertex (index 0 = front point)
        if ((cell.type === BoatCellType.BOW || cell.type === BoatCellType.BOW_MODERN) && i === 0) {
          y += 0.6;
        }
      }
      return y;
    });

    // Top face (fan triangulation) — only if no covering cell above
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

    // Bottom face (fan triangulation) — only if no covering cell below
    if (!neighborCoversFace(5) && y1 > y0) {
      for (let i = 1; i < bottomPoly.length - 1; i++) {
        vi = this.addTri(verts, idx, vi,
          [bottomPoly[0][0], y0, bottomPoly[0][1]],
          [bottomPoly[i + 1][0], y0, bottomPoly[i + 1][1]],
          [bottomPoly[i][0], y0, bottomPoly[i][1]],
          [0, -1, 0], color);
      }
    }

    // Side faces — connect top polygon (per-vertex height) to bottom polygon (V-hull narrowed)
    if (y1 <= y0) return;
    for (const edge of shape.edges) {
      if (neighborCoversFace(edge.dir)) continue;
      const i0 = edge.p0, i1 = edge.p1;
      const [bx0, bz0] = bottomPoly[i0];
      const [bx1, bz1] = bottomPoly[i1];
      const [tx0, tz0] = poly[i0];
      const [tx1, tz1] = poly[i1];

      // Compute outward normal from cross product
      // v1 = bottom1 - bottom0, v2 = top0 - bottom0
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

  private addQuad(
    verts: number[],
    idx: number[],
    baseVi: number,
    p0: [number, number, number], p1: [number, number, number],
    p2: [number, number, number], p3: [number, number, number],
    normal: [number, number, number],
    color: [number, number, number],
  ): number {
    const [nx, ny, nz] = normal;
    const [r, g, b] = color;
    verts.push(
      p0[0], p0[1], p0[2], nx, ny, nz, r, g, b,
      p1[0], p1[1], p1[2], nx, ny, nz, r, g, b,
      p2[0], p2[1], p2[2], nx, ny, nz, r, g, b,
      p3[0], p3[1], p3[2], nx, ny, nz, r, g, b,
    );
    idx.push(baseVi, baseVi + 1, baseVi + 2, baseVi, baseVi + 2, baseVi + 3);
    return baseVi + 4;
  }

  private addTri(
    verts: number[],
    idx: number[],
    baseVi: number,
    p0: [number, number, number], p1: [number, number, number], p2: [number, number, number],
    normal: [number, number, number],
    color: [number, number, number],
  ): number {
    const [nx, ny, nz] = normal;
    const [r, g, b] = color;
    verts.push(
      p0[0], p0[1], p0[2], nx, ny, nz, r, g, b,
      p1[0], p1[1], p1[2], nx, ny, nz, r, g, b,
      p2[0], p2[1], p2[2], nx, ny, nz, r, g, b,
    );
    idx.push(baseVi, baseVi + 1, baseVi + 2);
    return baseVi + 3;
  }

  private genDeleteXCell(
    cx: number, cy: number, cz: number, s: number,
    verts: number[], idx: number[], baseVi: number,
  ): void {
    const red: [number, number, number] = [1.0, 0.15, 0.15];
    const yMid = cy + BOAT_LAYER_HEIGHT / 2;
    const t = s * 0.12; // thickness of X bars
    const y0 = yMid - t, y1 = yMid + t;

    // Diagonal 1: from (-s, -s) to (+s, +s) in XZ plane
    // Quad spanning the diagonal
    let vi = baseVi;
    // Front face of diagonal 1
    vi = this.addQuad(verts, idx, vi,
      [cx - s, y0, cz - s], [cx + s, y0, cz + s], [cx + s, y1, cz + s], [cx - s, y1, cz - s],
      [0, 1, 0], red);
    // Back face of diagonal 1
    vi = this.addQuad(verts, idx, vi,
      [cx - s, y1, cz - s], [cx + s, y1, cz + s], [cx + s, y0, cz + s], [cx - s, y0, cz - s],
      [0, -1, 0], red);

    // Diagonal 2: from (-s, +s) to (+s, -s) in XZ plane
    // Front face of diagonal 2
    vi = this.addQuad(verts, idx, vi,
      [cx - s, y0, cz + s], [cx + s, y0, cz - s], [cx + s, y1, cz - s], [cx - s, y1, cz + s],
      [0, 1, 0], red);
    // Back face of diagonal 2
    vi = this.addQuad(verts, idx, vi,
      [cx - s, y1, cz + s], [cx + s, y1, cz - s], [cx + s, y0, cz - s], [cx - s, y0, cz + s],
      [0, -1, 0], red);
  }

  private writeHitboxEntry(
    localCx: number, localCy: number, localCz: number,
    halfX: number, halfY: number, halfZ: number,
    pos: { x: number; y: number; z: number },
    rotation: { x: number; y: number; z: number; w: number },
    color: [number, number, number] = [0.0, 1.0, 0.2],
  ): void {
    if (this.hitboxEntryCount >= EntityRenderer.MAX_HITBOX_ENTRIES) return;
    if (!this.hitboxUniformBuffer || !this.viewProjCache) return;

    const rx = rotation.x, ry = rotation.y, rz = rotation.z, rw = rotation.w;
    // Rotate local center by quaternion to get world-space offset
    const cx1 = ry * localCz - rz * localCy;
    const cy1 = rz * localCx - rx * localCz;
    const cz1 = rx * localCy - ry * localCx;
    const cx2 = ry * cz1 - rz * cy1 + rw * cx1;
    const cy2 = rz * cx1 - rx * cz1 + rw * cy1;
    const cz2 = rx * cy1 - ry * cx1 + rw * cz1;
    const worldCx = localCx + 2 * cx2;
    const worldCy = localCy + 2 * cy2;
    const worldCz = localCz + 2 * cz2;

    const hbUniforms = this.reusableHbUniforms;
    for (let i = 0; i < 16; i++) hbUniforms[i] = this.viewProjCache[i];
    hbUniforms[16] = this.cameraPosCache[0];
    hbUniforms[17] = this.cameraPosCache[1];
    hbUniforms[18] = this.cameraPosCache[2];
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
    hbUniforms[32] = this.viewportWidth;
    hbUniforms[33] = this.viewportHeight;
    hbUniforms[34] = this.hitboxLineWidth;
    hbUniforms[35] = 0; // padding for vec3 alignment
    hbUniforms[36] = color[0];
    hbUniforms[37] = color[1];
    hbUniforms[38] = color[2];
    this.device.queue.writeBuffer(this.hitboxUniformBuffer, this.hitboxEntryCount * 256, hbUniforms);
    this.hitboxEntryCount++;
  }

  private ensureDecorationMesh(chunkX: number, chunkZ: number, biome: number, islandSize: number, islandRadius: number): void {
    const key = `${chunkX},${chunkZ}`;
    if (this.decorationMeshes.has(key) || this.decorationEmptyKeys.has(key)) {
      this.activeDecorationKeys.add(key);
      return;
    }

    // Reuse the voxel field already generated by ensureIslandMesh if available
    const existingField = this.islandVoxelFields.get(key) ?? this.islandChunkField.get(key) ?? undefined;
    const placements = generateDecorations(chunkX, chunkZ, biome as BiomeType, islandSize as IslandSize, islandRadius, existingField);
    if (placements.length === 0) {
      this.decorationEmptyKeys.add(key);
      this.activeDecorationKeys.add(key);
      return;
    }

    const mesh = generateDecorationMesh(placements);
    if (mesh.verts.length === 0 || mesh.indices.length === 0) {
      this.decorationEmptyKeys.add(key);
      this.activeDecorationKeys.add(key);
      return;
    }

    const vertices = this.device.createBuffer({
      size: mesh.verts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(vertices, 0, mesh.verts as any);

    // WebGPU writeBuffer requires byte length to be a multiple of 4.
    // Uint16Array indices can have odd length → byteLength not divisible by 4.
    let indexData: Uint16Array = mesh.indices;
    if (mesh.indices.length % 2 !== 0) {
      indexData = new Uint16Array(mesh.indices.length + 1);
      indexData.set(mesh.indices);
    }
    const indices = this.device.createBuffer({
      size: indexData.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(indices, 0, indexData as any);

    this.decorationMeshes.set(key, { vertices, indices, indexCount: mesh.indices.length });
    this.activeDecorationKeys.add(key);
  }

  // Phase 3: Handle terrain LOD change — recreate chunked field at new resolution and re-mesh
  handleTerrainLODChange(chunkX: number, chunkZ: number, newVoxelSize: number): void {
    const key = `${chunkX},${chunkZ}`;

    // Find island metadata (radius, biome, islandSize) from draw entity slots
    let radius = 0;
    let biome = 0;
    let islandSize = 0;
    for (let i = 0; i < this.drawEntityCount; i++) {
      if (this.drawEntityTypes[i] === EntityType.Island &&
          this.drawEntityChunkX[i] === chunkX &&
          this.drawEntityChunkZ[i] === chunkZ) {
        radius = this.drawEntityScales[i];
        biome = this.drawEntityBiome[i];
        islandSize = this.drawEntityIslandSize[i];
        break;
      }
    }
    if (radius <= 0) return;  // island not found in draw entities

    // Clean up old chunk meshes
    const oldChunkMap = this.islandChunkMeshes.get(key);
    if (oldChunkMap) {
      for (const [, chunk] of oldChunkMap) {
        chunk.vertices.destroy();
        chunk.indices.destroy();
        if (chunk.lineIndices) chunk.lineIndices.destroy();
      }
      this.islandChunkMeshes.delete(key);
    }
    this.islandChunkPending.delete(key);
    this.islandChunkTotalChunks.delete(key);
    this.islandChunkCliffNoise.delete(key);
    this.islandChunkedFields.delete(key);
    this.islandChunkedCtxs.delete(key);

    // Also clean up legacy island mesh if present
    const oldMesh = this.islandMeshes.get(key);
    if (oldMesh) {
      oldMesh.vertices.destroy();
      oldMesh.indices.destroy();
      if (oldMesh.lineIndices) oldMesh.lineIndices.destroy();
      this.islandMeshes.delete(key);
    }
    this.islandVoxelFields.delete(key);
    this.islandChunkField.delete(key);

    // Recreate chunked field at new voxel size
    const lodVs = newVoxelSize > 0 ? newVoxelSize : undefined;
    const { field: cf, ctx: cfCtx } = createChunkedVoxelField(chunkX, chunkZ, radius, biome, islandSize, lodVs);

    this.islandChunkedFields.set(key, cf);
    this.islandChunkedCtxs.set(key, cfCtx);

    // Re-setup chunk streaming
    this.setupChunkedIslandFromChunkedField(key, cf, cfCtx, chunkX, chunkZ, radius);
  }

  private ensureIslandMesh(chunkX: number, chunkZ: number, radius: number, biome: number, islandSize: number): void {
    const key = `${chunkX},${chunkZ}`;
    if (this.islandMeshes.has(key) || this.islandEmptyKeys.has(key)) {
      this.activeIslandKeys.add(key);
      return;
    }
    // Already has chunk meshes (partially or fully streamed)
    if (this.islandChunkMeshes.has(key)) {
      this.activeIslandKeys.add(key);
      return;
    }

    // Create a ChunkedVoxelField for on-demand chunk generation.
    // This avoids allocating the full voxel field upfront — chunks are generated
    // lazily during streaming and only non-empty chunks consume memory.
    const { field: cf, ctx: cfCtx } = createChunkedVoxelField(chunkX, chunkZ, radius, biome, islandSize);

    // Store chunked field and context for streaming and deformation
    this.islandChunkedFields.set(key, cf);
    this.islandChunkedCtxs.set(key, cfCtx);

    // Set up chunk streaming using the ChunkedVoxelField
    this.setupChunkedIslandFromChunkedField(key, cf, cfCtx, chunkX, chunkZ, radius);
    this.activeIslandKeys.add(key);
  }

  // Set up chunk streaming from a ChunkedVoxelField (Phase 2 — replaces setupChunkedIsland for islands)
  private setupChunkedIslandFromChunkedField(
    key: string,
    cf: ChunkedVoxelField,
    cfCtx: ChunkedFieldContext,
    chunkX: number,
    chunkZ: number,
    radius: number,
  ): void {
    this.islandChunkMeshes.set(key, new Map());

    // Cache cliff noise function for this island (reused across all chunks)
    const cliffNoise = new PerlinNoise(chunkX * 92837111 + chunkZ * 72635341 ^ 0x56781234);
    this.islandChunkCliffNoise.set(key, (x: number, y: number, z: number) => {
      return cliffNoise.fbm(x * 5.0, z * 5.0, 3, 0.5, 2.0);
    });

    // Build pending chunk list from non-empty chunks in the ChunkedVoxelField
    const islandWorldX = chunkX;
    const islandWorldZ = chunkZ;
    const pending: { cx: number; cy: number; cz: number; chunkKey: string; distSq: number }[] = [];
    let totalChunks = 0;

    for (let cx = 0; cx < cf.chunkDimX; cx++) {
      for (let cy = 0; cy < cf.chunkDimY; cy++) {
        for (let cz = 0; cz < cf.chunkDimZ; cz++) {
          const chunkIdx = cx * cf.chunkDimY * cf.chunkDimZ + cy * cf.chunkDimZ + cz;
          if (cf.chunkOffsets[chunkIdx] < 0) continue; // skip empty chunks

          const gx0 = cx * cf.chunkSize;
          const gz0 = cz * cf.chunkSize;
          const chunkCenterX = islandWorldX + (gx0 + cf.chunkSize / 2) * cf.voxelSize + cf.originX;
          const chunkCenterZ = islandWorldZ + (gz0 + cf.chunkSize / 2) * cf.voxelSize + cf.originZ;
          const distSq = chunkCenterX * chunkCenterX + chunkCenterZ * chunkCenterZ;

          const chunkKey = `${cx},${cy},${cz}`;
          pending.push({ cx, cy, cz, chunkKey, distSq });
          totalChunks++;
        }
      }
    }

    if (totalChunks === 0) {
      this.islandEmptyKeys.add(key);
      this.islandChunkedFields.delete(key);
      this.islandChunkedCtxs.delete(key);
      return;
    }

    pending.sort((a, b) => a.distSq - b.distSq);
    this.islandChunkPending.set(key, pending as any);
    this.islandChunkTotalChunks.set(key, totalChunks);
  }

  // Generate port terrain mesh (flat plateau with beach transition and caves)
  private ensurePortMesh(chunkX: number, chunkZ: number, radius: number, biome: number): void {
    const key = `${chunkX},${chunkZ}`;
    if (this.portTerrainMeshes.has(key) || this.portEmptyKeys.has(key)) {
      this.activePortKeys.add(key);
      return;
    }

    // Generate port voxel field
    const field = generatePortVoxelField(chunkX, chunkZ, radius, biome);
    this.portVoxelFields.set(key, field);

    // Create cliff noise function (minimal for ports — mostly flat)
    const cliffNoise = new PerlinNoise(chunkX * 92837111 + chunkZ * 72635341 ^ 0x56781234);
    const cliffNoiseFn = (x: number, y: number, z: number) => {
      return cliffNoise.fbm(x * 5.0, z * 5.0, 3, 0.5, 2.0);
    };

    // Extract mesh via marching cubes
    const extracted = extractMesh(field, cliffNoiseFn);
    if (extracted.verts.length === 0 || extracted.indices.length === 0) {
      this.portEmptyKeys.add(key);
      this.activePortKeys.add(key);
      return;
    }

    // Convert vertices from world-space to unit-space (divide by radius)
    const verts = extracted.verts;
    for (let i = 0; i < verts.length; i += 9) {
      verts[i] /= radius;
      verts[i + 1] /= radius;
      verts[i + 2] /= radius;
    }

    const vertices = this.device.createBuffer({
      size: verts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(vertices, 0, verts as any);

    const indexBuf = extracted.indices;
    let indexData: Uint16Array | Uint32Array;
    if (!extracted.useUint32 && indexBuf instanceof Uint16Array && indexBuf.length % 2 !== 0) {
      indexData = new Uint16Array(indexBuf.length + 1);
      indexData.set(indexBuf);
    } else {
      indexData = indexBuf as Uint16Array | Uint32Array;
    }

    const indices = this.device.createBuffer({
      size: indexData.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(indices, 0, indexData as any);

    this.portTerrainMeshes.set(key, {
      vertices,
      indices,
      indexCount: indexBuf.length,
      useUint32: extracted.useUint32,
    });
    this.activePortKeys.add(key);
  }

  // Apply a terrain deformation broadcast from the sim worker to the renderer's local voxel field,
  // then rebuild the affected island or port mesh.
  // Queues the deformation for deferred processing in the render loop to avoid blocking the IPC handler.
  applyTerrainDeformation(
    chunkX: number, chunkZ: number, isPort: boolean,
    worldX: number, worldY: number, worldZ: number,
    entityWorldX: number, entityWorldY: number, entityWorldZ: number,
    radius: number, strength: number,
  ): void {
    this.pendingDeformations.push({
      chunkX, chunkZ, isPort,
      worldX, worldY, worldZ,
      entityWorldX, entityWorldY, entityWorldZ,
      radius, strength,
    });
  }

  // Process one pending deformation per frame (called from render loop)
  processPendingDeformations(): void {
    if (this.pendingDeformations.length === 0) return;
    const d = this.pendingDeformations.shift()!;
    this.doApplyTerrainDeformation(
      d.chunkX, d.chunkZ, d.isPort,
      d.worldX, d.worldY, d.worldZ,
      d.entityWorldX, d.entityWorldY, d.entityWorldZ,
      d.radius, d.strength,
    );
  }

  private doApplyTerrainDeformation(
    chunkX: number, chunkZ: number, isPort: boolean,
    worldX: number, worldY: number, worldZ: number,
    entityWorldX: number, entityWorldY: number, entityWorldZ: number,
    radius: number, strength: number,
  ): void {
    const key = `${chunkX},${chunkZ}`;
    // Check for ChunkedVoxelField-based island first (Phase 2)
    const cf = isPort ? null : this.islandChunkedFields.get(key);
    const cfCtx = isPort ? null : this.islandChunkedCtxs.get(key);
    const field = isPort
      ? this.portVoxelFields.get(key)
      : (this.islandVoxelFields.get(key) ?? this.islandChunkField.get(key));
    if (!field && !cf) {
      const islandKeys = [...this.islandVoxelFields.keys()];
      const chunkKeys = [...this.islandChunkField.keys()];
      const meshKeys = [...this.islandMeshes.keys()];
      const chunkMeshKeys = [...this.islandChunkMeshes.keys()];
      console.log(`[EntityRenderer] applyTerrainDeformation: no voxel field for key=${key} isPort=${isPort}`);
      console.log(`[EntityRenderer] islandVoxelFields keys:`, islandKeys);
      console.log(`[EntityRenderer] islandChunkField keys:`, chunkKeys);
      console.log(`[EntityRenderer] islandMeshes keys:`, meshKeys);
      console.log(`[EntityRenderer] islandChunkMeshes keys:`, chunkMeshKeys);
      return;
    }

    // ChunkedVoxelField path: apply deformation to chunked field and rebuild affected chunks
    if (cf && cfCtx) {
      const localX = worldX - entityWorldX;
      const localY = worldY - entityWorldY;
      const localZ = worldZ - entityWorldZ;
      const cvs = cf.voxelSize;
      const cDefRadiusVoxels = Math.ceil(radius / cvs);
      const defRadiusSq = radius * radius;
      const ccx = Math.floor((localX - cf.originX) / cvs);
      const ccy = Math.floor((localY - cf.originY) / cvs);
      const ccz = Math.floor((localZ - cf.originZ) / cvs);

      const dirtyChunkKeys = new Set<string>();
      for (let vx = ccx - cDefRadiusVoxels; vx <= ccx + cDefRadiusVoxels; vx++) {
        if (vx < 0 || vx >= cf.dimX) continue;
        for (let vy = ccy - cDefRadiusVoxels; vy <= ccy + cDefRadiusVoxels; vy++) {
          if (vy < 0 || vy >= cf.dimY) continue;
          for (let vz = ccz - cDefRadiusVoxels; vz <= ccz + cDefRadiusVoxels; vz++) {
            if (vz < 0 || vz >= cf.dimZ) continue;

            const wx = vx * cvs + cf.originX;
            const wy = vy * cvs + cf.originY;
            const wz = vz * cvs + cf.originZ;
            const ddx = wx - localX;
            const ddy = wy - localY;
            const ddz = wz - localZ;
            const distSq = ddx * ddx + ddy * ddy + ddz * ddz;
            if (distSq > defRadiusSq) continue;

            const falloff = 1 - Math.sqrt(distSq) / radius;
            const change = strength * falloff * falloff;

            const chCx = vx >>> cf.chunkBits;
            const chCy = vy >>> cf.chunkBits;
            const chCz = vz >>> cf.chunkBits;
            dirtyChunkKeys.add(`${chCx},${chCy},${chCz}`);

            const oldVal = getChunkedVoxel(cf, vx, vy, vz);
            setChunkedVoxel(cf, vx, vy, vz, oldVal + change);
          }
        }
      }

      // Rebuild affected chunk meshes
      this.rebuildChunkedIslandChunks(key, cf, cfCtx, dirtyChunkKeys);
      return;
    }

    // Legacy VoxelField path
    if (!field) return;
    console.log(`[EntityRenderer] Applying deformation at key=${key} field.dimX=${field.dimX}`);

    // Convert world-space deformation center to island-local coordinates
    const localX = worldX - entityWorldX;
    const localY = worldY - entityWorldY;
    const localZ = worldZ - entityWorldZ;

    const vs = field.voxelSize;
    const defRadiusVoxels = Math.ceil(radius / vs);
    const defRadiusSq = radius * radius;

    const cx = Math.floor((localX - field.originX) / vs);
    const cy = Math.floor((localY - field.originY) / vs);
    const cz = Math.floor((localZ - field.originZ) / vs);

    for (let vx = cx - defRadiusVoxels; vx <= cx + defRadiusVoxels; vx++) {
      if (vx < 0 || vx >= field.dimX) continue;
      for (let vy = cy - defRadiusVoxels; vy <= cy + defRadiusVoxels; vy++) {
        if (vy < 0 || vy >= field.dimY) continue;
        for (let vz = cz - defRadiusVoxels; vz <= cz + defRadiusVoxels; vz++) {
          if (vz < 0 || vz >= field.dimZ) continue;

          const wx = vx * vs + field.originX;
          const wy = vy * vs + field.originY;
          const wz = vz * vs + field.originZ;

          const ddx = wx - localX;
          const ddy = wy - localY;
          const ddz = wz - localZ;
          const distSq = ddx * ddx + ddy * ddy + ddz * ddz;

          if (distSq > defRadiusSq) continue;

          const falloff = 1 - Math.sqrt(distSq) / radius;
          const change = strength * falloff * falloff;

          const idx = vx * field.dimY * field.dimZ + vy * field.dimZ + vz;
          field.data[idx] += change;
        }
      }
    }

    // Rebuild the mesh
    if (isPort) {
      this.rebuildPortMesh(key, field);
    } else if (this.islandChunkMeshes.has(key)) {
      this.rebuildChunkedIsland(key, field, chunkX, chunkZ, localX, localY, localZ, radius);
    } else {
      this.rebuildIslandMesh(key, field, chunkX, chunkZ);
    }
  }

  // Rebuild a non-chunked island mesh from an updated voxel field
  private rebuildIslandMesh(key: string, field: VoxelField, chunkX: number, chunkZ: number): void {
    const old = this.islandMeshes.get(key);
    if (old) {
      old.vertices.destroy();
      old.indices.destroy();
      if (old.lineIndices) old.lineIndices.destroy();
      this.islandMeshes.delete(key);
    }

    const cliffNoise = new PerlinNoise(chunkX * 92837111 + chunkZ * 72635341 ^ 0x56781234);
    const cliffNoiseFn = (x: number, y: number, z: number) => {
      return cliffNoise.fbm(x * 5.0, z * 5.0, 3, 0.5, 2.0);
    };

    const extracted = extractMesh(field, cliffNoiseFn);
    if (extracted.verts.length === 0 || extracted.indices.length === 0) {
      this.islandEmptyKeys.add(key);
      this.activeIslandKeys.add(key);
      return;
    }
    this.islandEmptyKeys.delete(key);

    const r = field.radius;
    const verts = extracted.verts;
    for (let i = 0; i < verts.length; i += 9) {
      verts[i] /= r;
      verts[i + 1] /= r;
      verts[i + 2] /= r;
    }

    const vertices = this.device.createBuffer({
      size: verts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(vertices, 0, verts as any);

    const indexBuf = extracted.indices;
    let indexData: Uint16Array | Uint32Array;
    if (!extracted.useUint32 && indexBuf instanceof Uint16Array && indexBuf.length % 2 !== 0) {
      indexData = new Uint16Array(indexBuf.length + 1);
      indexData.set(indexBuf);
    } else {
      indexData = indexBuf as Uint16Array | Uint32Array;
    }

    const indices = this.device.createBuffer({
      size: indexData.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(indices, 0, indexData as any);

    this.islandMeshes.set(key, {
      vertices,
      indices,
      indexCount: indexBuf.length,
      useUint32: extracted.useUint32,
      lineIndices: null,
      lineIndexCount: 0,
    });
    this.activeIslandKeys.add(key);
  }

  // Rebuild a port terrain mesh from an updated voxel field
  private rebuildPortMesh(key: string, field: VoxelField): void {
    const old = this.portTerrainMeshes.get(key);
    if (old) {
      old.vertices.destroy();
      old.indices.destroy();
      this.portTerrainMeshes.delete(key);
    }

    const chunkX = parseInt(key.split(",")[0]);
    const chunkZ = parseInt(key.split(",")[1]);
    const cliffNoise = new PerlinNoise(chunkX * 92837111 + chunkZ * 72635341 ^ 0x56781234);
    const cliffNoiseFn = (x: number, y: number, z: number) => {
      return cliffNoise.fbm(x * 5.0, z * 5.0, 3, 0.5, 2.0);
    };

    const extracted = extractMesh(field, cliffNoiseFn);
    if (extracted.verts.length === 0 || extracted.indices.length === 0) {
      this.portEmptyKeys.add(key);
      this.activePortKeys.add(key);
      return;
    }
    this.portEmptyKeys.delete(key);

    const r = field.radius;
    const verts = extracted.verts;
    for (let i = 0; i < verts.length; i += 9) {
      verts[i] /= r;
      verts[i + 1] /= r;
      verts[i + 2] /= r;
    }

    const vertices = this.device.createBuffer({
      size: verts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(vertices, 0, verts as any);

    const indexBuf = extracted.indices;
    let indexData: Uint16Array | Uint32Array;
    if (!extracted.useUint32 && indexBuf instanceof Uint16Array && indexBuf.length % 2 !== 0) {
      indexData = new Uint16Array(indexBuf.length + 1);
      indexData.set(indexBuf);
    } else {
      indexData = indexBuf as Uint16Array | Uint32Array;
    }

    const indices = this.device.createBuffer({
      size: indexData.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(indices, 0, indexData as any);

    this.portTerrainMeshes.set(key, {
      vertices,
      indices,
      indexCount: indexBuf.length,
      useUint32: extracted.useUint32,
    });
    this.activePortKeys.add(key);
  }

  // Rebuild only the chunks of a chunked island that overlap the deformation sphere
  private rebuildChunkedIsland(
    key: string, field: VoxelField, chunkX: number, chunkZ: number,
    localX: number, localY: number, localZ: number, defRadius: number,
  ): void {
    const cfg = TERRAIN_CONFIG;
    const sub = cfg.chunkSubdivisions;
    const chunkDimX = Math.ceil(field.dimX / sub);
    const chunkDimY = Math.ceil(field.dimY / sub);
    const chunkDimZ = Math.ceil(field.dimZ / sub);

    const cliffNoiseFn = this.islandChunkCliffNoise.get(key);
    if (!cliffNoiseFn) {
      console.log(`[EntityRenderer] rebuildChunkedIsland: no cliff noise for key=${key}`);
      return;
    }

    const chunkMap = this.islandChunkMeshes.get(key);
    if (!chunkMap) {
      console.log(`[EntityRenderer] rebuildChunkedIsland: no chunk map for key=${key}`);
      return;
    }

    const r = field.radius;
    const vs = field.voxelSize;

    // Convert deformation center to voxel grid coordinates
    const defGx = (localX - field.originX) / vs;
    const defGy = (localY - field.originY) / vs;
    const defGz = (localZ - field.originZ) / vs;
    const defRadiusVoxels = defRadius / vs;

    // Determine which sub-chunk range overlaps the deformation sphere
    const minCx = Math.max(0, Math.floor((defGx - defRadiusVoxels) / chunkDimX));
    const maxCx = Math.min(sub - 1, Math.floor((defGx + defRadiusVoxels) / chunkDimX));
    const minCy = Math.max(0, Math.floor((defGy - defRadiusVoxels) / chunkDimY));
    const maxCy = Math.min(sub - 1, Math.floor((defGy + defRadiusVoxels) / chunkDimY));
    const minCz = Math.max(0, Math.floor((defGz - defRadiusVoxels) / chunkDimZ));
    const maxCz = Math.min(sub - 1, Math.floor((defGz + defRadiusVoxels) / chunkDimZ));

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cz = minCz; cz <= maxCz; cz++) {
          const chunkKey = `${cx},${cy},${cz}`;
          const x0 = cx * chunkDimX;
          const y0 = cy * chunkDimY;
          const z0 = cz * chunkDimZ;
          const x1 = Math.min(field.dimX, x0 + chunkDimX);
          const y1 = Math.min(field.dimY, y0 + chunkDimY);
          const z1 = Math.min(field.dimZ, z0 + chunkDimZ);

          const extracted = extractMeshSubRegion(field, x0, y0, z0, x1, y1, z1, cliffNoiseFn);

          // Destroy old chunk mesh
          const old = chunkMap.get(chunkKey);
          if (old) {
            old.vertices.destroy();
            old.indices.destroy();
            if (old.lineIndices) old.lineIndices.destroy();
            chunkMap.delete(chunkKey);
          }

          if (extracted.verts.length === 0 || extracted.indices.length === 0) continue;

          // Convert to unit space
          const verts = extracted.verts;
          for (let i = 0; i < verts.length; i += 9) {
            verts[i] /= r;
            verts[i + 1] /= r;
            verts[i + 2] /= r;
          }

          const vertices = this.device.createBuffer({
            size: verts.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
          });
          this.device.queue.writeBuffer(vertices, 0, verts as any);

          const indexBuf = extracted.indices;
          let indexData: Uint16Array | Uint32Array;
          if (!extracted.useUint32 && indexBuf instanceof Uint16Array && indexBuf.length % 2 !== 0) {
            indexData = new Uint16Array(indexBuf.length + 1);
            indexData.set(indexBuf);
          } else {
            indexData = indexBuf as Uint16Array | Uint32Array;
          }

          const indices = this.device.createBuffer({
            size: indexData.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
          });
          this.device.queue.writeBuffer(indices, 0, indexData as any);

          chunkMap.set(chunkKey, {
            vertices,
            indices,
            indexCount: indexBuf.length,
            useUint32: extracted.useUint32,
            lineIndices: null,
            lineIndexCount: 0,
          });
        }
      }
    }
  }

  // Rebuild specific chunks of a ChunkedVoxelField-based island after deformation
  private rebuildChunkedIslandChunks(
    key: string,
    cf: ChunkedVoxelField,
    cfCtx: ChunkedFieldContext,
    dirtyChunkKeys: Set<string>,
  ): void {
    const cliffNoiseFn = this.islandChunkCliffNoise.get(key);
    if (!cliffNoiseFn) return;

    const chunkMap = this.islandChunkMeshes.get(key);
    if (!chunkMap) return;

    const r = cf.radius;

    for (const chunkKey of dirtyChunkKeys) {
      const [cx, cy, cz] = chunkKey.split(",").map(Number);

      // Materialize chunk + border for mesh extraction
      const matField = materializeChunkForMesh(cf, cfCtx, cx, cy, cz);
      if (!matField) continue;

      const sub = getChunkMeshSubRegion(cf, cx, cy, cz);
      const extracted = extractMeshSubRegion(matField, sub.x0, sub.y0, sub.z0, sub.x1, sub.y1, sub.z1, cliffNoiseFn);

      // Destroy old chunk mesh
      const old = chunkMap.get(chunkKey);
      if (old) {
        old.vertices.destroy();
        old.indices.destroy();
        if (old.lineIndices) old.lineIndices.destroy();
        chunkMap.delete(chunkKey);
      }

      if (extracted.verts.length === 0 || extracted.indices.length === 0) continue;

      // Convert to unit space
      const verts = extracted.verts;
      for (let i = 0; i < verts.length; i += 9) {
        verts[i] /= r;
        verts[i + 1] /= r;
        verts[i + 2] /= r;
      }

      const vertices = this.device.createBuffer({
        size: verts.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(vertices, 0, verts as any);

      const indexBuf = extracted.indices;
      let indexData: Uint16Array | Uint32Array;
      if (!extracted.useUint32 && indexBuf instanceof Uint16Array && indexBuf.length % 2 !== 0) {
        indexData = new Uint16Array(indexBuf.length + 1);
        indexData.set(indexBuf);
      } else {
        indexData = indexBuf as Uint16Array | Uint32Array;
      }

      const indices = this.device.createBuffer({
        size: indexData.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(indices, 0, indexData as any);

      chunkMap.set(chunkKey, {
        vertices,
        indices,
        indexCount: indexBuf.length,
        useUint32: extracted.useUint32,
        lineIndices: null,
        lineIndexCount: 0,
      });
    }
  }

  // Generate biome-specific port structure mesh (dock, pier, buildings, etc.)
  private ensurePortStructureMesh(
    chunkX: number,
    chunkZ: number,
    radius: number,
    biome: number,
  ): void {
    const key = `${chunkX},${chunkZ}`;
    if (this.portStructureMeshes.has(key)) {
      this.activePortStructureKeys.add(key);
      return;
    }

    // Determine port size from radius
    const portSize = radius <= 18 ? PortSize.Small : radius <= 32 ? PortSize.Medium : PortSize.Large;
    const seed = chunkX * 83492791 + chunkZ * 26515163;

    const portMesh = generatePortMesh({
      size: portSize,
      theme: PortTheme.Fishing,
      services: [],
      seed,
      biome: biome as BiomeType,
    });

    // Find max extent for normalization
    let maxExtent = 0;
    for (let vi = 0; vi < portMesh.vertices.length; vi += 9) {
      const x = portMesh.vertices[vi];
      const y = portMesh.vertices[vi + 1];
      const z = portMesh.vertices[vi + 2];
      maxExtent = Math.max(maxExtent, Math.abs(x), Math.abs(y), Math.abs(z));
    }
    const normScale = maxExtent > 0 ? 1 / maxExtent : 1;

    // Normalize vertices
    const verts = new Float32Array(portMesh.vertices.length);
    for (let vi = 0; vi < portMesh.vertices.length; vi += 9) {
      verts[vi] = portMesh.vertices[vi] * normScale;
      verts[vi + 1] = portMesh.vertices[vi + 1] * normScale;
      verts[vi + 2] = portMesh.vertices[vi + 2] * normScale;
      for (let j = 3; j < 9; j++) {
        verts[vi + j] = portMesh.vertices[vi + j];
      }
    }

    const vertCount = portMesh.vertices.length / 9;
    const useUint32 = vertCount > 65535;
    const indices = useUint32
      ? new Uint32Array(portMesh.indices)
      : new Uint16Array(portMesh.indices);

    const vertices = this.device.createBuffer({
      size: verts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(vertices, 0, verts as any);

    const indexBuffer = this.device.createBuffer({
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(indexBuffer, 0, indices as any);

    this.portStructureMeshes.set(key, {
      vertices,
      indices: indexBuffer,
      indexCount: portMesh.indices.length,
      useUint32,
    });
    this.activePortStructureKeys.add(key);
  }

  // Set up chunked island mesh streaming for large islands.
  // Splits the voxel field into sub-chunks and queues them for progressive generation.
  private setupChunkedIsland(
    key: string,
    field: VoxelField,
    chunkX: number,
    chunkZ: number,
    radius: number,
  ): void {
    const cfg = TERRAIN_CONFIG;
    const sub = cfg.chunkSubdivisions;

    // Store the field for chunk extraction (retained until all chunks are done)
    this.islandChunkField.set(key, field);
    this.islandChunkMeshes.set(key, new Map());

    // Cache cliff noise function for this island (reused across all chunks)
    const cliffNoise = new PerlinNoise(chunkX * 92837111 + chunkZ * 72635341 ^ 0x56781234);
    this.islandChunkCliffNoise.set(key, (x: number, y: number, z: number) => {
      return cliffNoise.fbm(x * 5.0, z * 5.0, 3, 0.5, 2.0);
    });

    // Compute chunk boundaries
    const chunkDimX = Math.ceil(field.dimX / sub);
    const chunkDimY = Math.ceil(field.dimY / sub);
    const chunkDimZ = Math.ceil(field.dimZ / sub);

    // Island world position (center)
    const islandWorldX = chunkX;
    const islandWorldZ = chunkZ;

    const pending: { x: number; y: number; z: number; chunkKey: string; distSq: number }[] = [];
    let totalChunks = 0;

    for (let cx = 0; cx < sub; cx++) {
      for (let cy = 0; cy < sub; cy++) {
        for (let cz = 0; cz < sub; cz++) {
          const x0 = cx * chunkDimX;
          const y0 = cy * chunkDimY;
          const z0 = cz * chunkDimZ;
          const x1 = Math.min(field.dimX, x0 + chunkDimX);
          const y1 = Math.min(field.dimY, y0 + chunkDimY);
          const z1 = Math.min(field.dimZ, z0 + chunkDimZ);

          // Chunk center in world space (approximate)
          const chunkCenterX = islandWorldX + (x0 + chunkDimX / 2) * field.voxelSize + field.originX;
          const chunkCenterZ = islandWorldZ + (z0 + chunkDimZ / 2) * field.voxelSize + field.originZ;
          // Distance squared to island center (will be updated with player pos during streaming)
          const distSq = chunkCenterX * chunkCenterX + chunkCenterZ * chunkCenterZ;

          const chunkKey = `${cx},${cy},${cz}`;
          pending.push({ x: x0, y: y0, z: z0, chunkKey, distSq });
          totalChunks++;
        }
      }
    }

    // Sort by distance (closest first) — will be re-sorted with player position during streaming
    pending.sort((a, b) => a.distSq - b.distSq);
    this.islandChunkPending.set(key, pending);
    this.islandChunkTotalChunks.set(key, totalChunks);
  }

  // Process pending chunk mesh generation with a per-frame time budget.
  // Called each frame from the render loop.
  processIslandChunkStream(playerX: number, playerZ: number): void {
    if (this.islandChunkPending.size === 0) return;

    const cfg = TERRAIN_CONFIG;
    const startTime = performance.now();
    let chunksProcessed = 0;

    for (const [key, pending] of this.islandChunkPending) {
      if (pending.length === 0) continue;

      // Check for ChunkedVoxelField-based island (Phase 2)
      const cf = this.islandChunkedFields.get(key);
      const cfCtx = this.islandChunkedCtxs.get(key);
      const legacyField = this.islandChunkField.get(key);

      // Parse island center from key
      const [chunkXStr, chunkZStr] = key.split(",");
      const islandX = parseFloat(chunkXStr);
      const islandZ = parseFloat(chunkZStr);

      if (cf && cfCtx) {
        // ChunkedVoxelField path: materialize each chunk on demand
        const halfChunk = cf.chunkSize / 2;

        // Update distances and re-sort
        for (let i = 0; i < pending.length; i++) {
          const p = pending[i] as any;
          const gx0 = p.cx * cf.chunkSize;
          const gz0 = p.cz * cf.chunkSize;
          const cx = islandX + (gx0 + halfChunk) * cf.voxelSize + cf.originX;
          const cz = islandZ + (gz0 + halfChunk) * cf.voxelSize + cf.originZ;
          const dx = cx - playerX;
          const dz = cz - playerZ;
          p.distSq = dx * dx + dz * dz;
        }
        pending.sort((a, b) => a.distSq - b.distSq);

        while (pending.length > 0 && chunksProcessed < cfg.streamMaxChunksPerFrame) {
          if (performance.now() - startTime > cfg.streamTimeBudgetMs) break;

          const chunk = pending.shift()! as any;
          const chunkMeshes = this.islandChunkMeshes.get(key);
          if (!chunkMeshes) break;

          const cliffNoiseFn = this.islandChunkCliffNoise.get(key);
          if (!cliffNoiseFn) break;

          // Materialize chunk + 1-voxel border into a temporary VoxelField
          const matField = materializeChunkForMesh(cf, cfCtx, chunk.cx, chunk.cy, chunk.cz);
          if (!matField) {
            chunksProcessed++;
            continue;
          }

          // Get the sub-region within the materialized field that corresponds to the chunk
          const sub = getChunkMeshSubRegion(cf, chunk.cx, chunk.cy, chunk.cz);
          const extracted = extractMeshSubRegion(matField, sub.x0, sub.y0, sub.z0, sub.x1, sub.y1, sub.z1, cliffNoiseFn);
          if (extracted.verts.length === 0 || extracted.indices.length === 0) {
            chunksProcessed++;
            continue;
          }

          // Convert to unit space
          const verts = extracted.verts;
          const r = cf.radius;
          for (let i = 0; i < verts.length; i += 9) {
            verts[i] /= r;
            verts[i + 1] /= r;
            verts[i + 2] /= r;
          }

          const vertices = this.device.createBuffer({
            size: verts.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
          });
          this.device.queue.writeBuffer(vertices, 0, verts as any);

          const indexBuf = extracted.indices;
          let indexData: Uint16Array | Uint32Array;
          if (!extracted.useUint32 && indexBuf instanceof Uint16Array && indexBuf.length % 2 !== 0) {
            indexData = new Uint16Array(indexBuf.length + 1);
            indexData.set(indexBuf);
          } else {
            indexData = indexBuf as Uint16Array | Uint32Array;
          }

          const indices = this.device.createBuffer({
            size: indexData.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
          });
          this.device.queue.writeBuffer(indices, 0, indexData as any);

          chunkMeshes.set(chunk.chunkKey, {
            vertices,
            indices,
            indexCount: indexBuf.length,
            useUint32: extracted.useUint32,
            lineIndices: null,
            lineIndexCount: 0,
          });
          chunksProcessed++;
        }
      } else if (legacyField) {
        // Legacy VoxelField path (for backward compatibility)
        const halfDimX = legacyField.dimX / cfg.chunkSubdivisions / 2;
        const halfDimZ = legacyField.dimZ / cfg.chunkSubdivisions / 2;

        for (let i = 0; i < pending.length; i++) {
          const p = pending[i] as any;
          const cx = islandX + (p.x + halfDimX) * legacyField.voxelSize + legacyField.originX;
          const cz = islandZ + (p.z + halfDimZ) * legacyField.voxelSize + legacyField.originZ;
          const dx = cx - playerX;
          const dz = cz - playerZ;
          p.distSq = dx * dx + dz * dz;
        }
        pending.sort((a, b) => a.distSq - b.distSq);

        while (pending.length > 0 && chunksProcessed < cfg.streamMaxChunksPerFrame) {
          if (performance.now() - startTime > cfg.streamTimeBudgetMs) break;

          const chunk = pending.shift()!;
          const chunkMeshes = this.islandChunkMeshes.get(key);
          if (!chunkMeshes) break;

          const sub = cfg.chunkSubdivisions;
          const chunkDimX = Math.ceil(legacyField.dimX / sub);
          const chunkDimY = Math.ceil(legacyField.dimY / sub);
          const chunkDimZ = Math.ceil(legacyField.dimZ / sub);
          const [cxIdx, cyIdx, czIdx] = (chunk as any).chunkKey.split(",").map(Number);
          const x0 = cxIdx * chunkDimX;
          const y0 = cyIdx * chunkDimY;
          const z0 = czIdx * chunkDimZ;
          const x1 = Math.min(legacyField.dimX, x0 + chunkDimX);
          const y1 = Math.min(legacyField.dimY, y0 + chunkDimY);
          const z1 = Math.min(legacyField.dimZ, z0 + chunkDimZ);

          const cliffNoiseFn = this.islandChunkCliffNoise.get(key);
          if (!cliffNoiseFn) break;

          const extracted = extractMeshSubRegion(legacyField, x0, y0, z0, x1, y1, z1, cliffNoiseFn);
          if (extracted.verts.length === 0 || extracted.indices.length === 0) {
            chunksProcessed++;
            continue;
          }

          const verts = extracted.verts;
          const r = legacyField.radius;
          for (let i = 0; i < verts.length; i += 9) {
            verts[i] /= r;
            verts[i + 1] /= r;
            verts[i + 2] /= r;
          }

          const vertices = this.device.createBuffer({
            size: verts.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
          });
          this.device.queue.writeBuffer(vertices, 0, verts as any);

          const indexBuf = extracted.indices;
          let indexData: Uint16Array | Uint32Array;
          if (!extracted.useUint32 && indexBuf instanceof Uint16Array && indexBuf.length % 2 !== 0) {
            indexData = new Uint16Array(indexBuf.length + 1);
            indexData.set(indexBuf);
          } else {
            indexData = indexBuf as Uint16Array | Uint32Array;
          }

          const indices = this.device.createBuffer({
            size: indexData.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
          });
          this.device.queue.writeBuffer(indices, 0, indexData as any);

          chunkMeshes.set((chunk as any).chunkKey, {
            vertices,
            indices,
            indexCount: indexBuf.length,
            useUint32: extracted.useUint32,
            lineIndices: null,
            lineIndexCount: 0,
          });
          chunksProcessed++;
        }
      } else {
        continue;
      }

      // If all chunks are done, clean up pending state but keep the voxel field
      // and cliff noise for terrain deformation (gun/shovel tools)
      if (pending.length === 0) {
        this.islandChunkPending.delete(key);
        this.islandChunkTotalChunks.delete(key);
      }
    }
  }

  cleanupStaleIslandMeshes(): void {
    for (const [key, mesh] of this.islandMeshes) {
      if (!this.activeIslandKeys.has(key)) {
        mesh.vertices.destroy();
        mesh.indices.destroy();
        if (mesh.lineIndices) mesh.lineIndices.destroy();
        this.islandMeshes.delete(key);
        this.islandVoxelFields.delete(key);
      }
    }
    // Clean up chunked island meshes — but only if all chunks are done streaming
    for (const [key, chunkMap] of this.islandChunkMeshes) {
      if (!this.activeIslandKeys.has(key)) {
        // Keep chunk data alive while streaming is in progress, even if the island
        // is temporarily out of cull range — otherwise the voxel field gets regenerated
        // from scratch every time the island re-enters range, never completing.
        if (this.islandChunkPending.has(key)) continue;
        for (const [, chunk] of chunkMap) {
          chunk.vertices.destroy();
          chunk.indices.destroy();
          if (chunk.lineIndices) chunk.lineIndices.destroy();
        }
        this.islandChunkMeshes.delete(key);
        this.islandChunkPending.delete(key);
        this.islandChunkField.delete(key);
        this.islandChunkTotalChunks.delete(key);
        this.islandChunkCliffNoise.delete(key);
        this.islandChunkedFields.delete(key);
        this.islandChunkedCtxs.delete(key);
      }
    }
    // Clean up empty-state entries that are no longer active
    for (const key of this.islandEmptyKeys) {
      if (!this.activeIslandKeys.has(key)) {
        this.islandEmptyKeys.delete(key);
        this.islandVoxelFields.delete(key);
      }
    }
    // Clean up stale port terrain meshes
    for (const [key, mesh] of this.portTerrainMeshes) {
      if (!this.activePortKeys.has(key)) {
        mesh.vertices.destroy();
        mesh.indices.destroy();
        this.portTerrainMeshes.delete(key);
        this.portVoxelFields.delete(key);
      }
    }
    // Clean up stale port structure meshes
    for (const [key, mesh] of this.portStructureMeshes) {
      if (!this.activePortStructureKeys.has(key)) {
        mesh.vertices.destroy();
        mesh.indices.destroy();
        this.portStructureMeshes.delete(key);
      }
    }
    for (const key of this.portEmptyKeys) {
      if (!this.activePortKeys.has(key)) {
        this.portEmptyKeys.delete(key);
      }
    }
    this.activeIslandKeys.clear();
    this.activePortKeys.clear();
    this.activePortStructureKeys.clear();
  }

  getIslandVoxelField(chunkX: number, chunkZ: number): VoxelField | null {
    return this.islandVoxelFields.get(`${chunkX},${chunkZ}`) ?? null;
  }

  // Extract a camera-centered voxel density grid from nearby terrain fields.
  // Returns packed density data for GPU particle collision, or null if no terrain nearby.
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
    // Collect nearby fields with their world-space origins
    const nearby = this.pooledNearby;
    nearby.length = 0;

    for (let i = 0; i < this.drawEntityCount; i++) {
      const type = this.drawEntityTypes[i];
      if (type !== EntityType.Island && type !== EntityType.Port) continue;

      const ex = this.drawEntityPosX[i] ?? 0;
      const ey = this.drawEntityPosY[i] ?? 0;
      const ez = this.drawEntityPosZ[i] ?? 0;
      const chunkX = this.drawEntityChunkX[i] ?? 0;
      const chunkZ = this.drawEntityChunkZ[i] ?? 0;
      const key = `${chunkX},${chunkZ}`;

      let field: ChunkedVoxelField | VoxelField | null = null;
      let isChunked = false;

      if (type === EntityType.Island) {
        const cf = this.islandChunkedFields.get(key);
        if (cf) { field = cf; isChunked = true; }
        else { field = this.islandVoxelFields.get(key) ?? this.islandChunkField.get(key) ?? null; }
      } else {
        field = this.portVoxelFields.get(key) ?? null;
      }

      if (!field) continue;

      // Check if camera is within field bounds + collision radius
      const vs = field.voxelSize;
      const fox = ex + field.originX;
      const foy = ey + field.originY;
      const foz = ez + field.originZ;
      const fieldMaxX = fox + field.dimX * vs;
      const fieldMaxY = foy + field.dimY * vs;
      const fieldMaxZ = foz + field.dimZ * vs;

      // Expand bounds by collision radius
      if (camX + collisionRadius < fox || camX - collisionRadius > fieldMaxX) continue;
      if (camY + collisionRadius < foy || camY - collisionRadius > fieldMaxY) continue;
      if (camZ + collisionRadius < foz || camZ - collisionRadius > fieldMaxZ) continue;

      nearby.push({
        field,
        isChunked,
        worldOriginX: fox,
        worldOriginY: foy,
        worldOriginZ: foz,
        voxelSize: vs,
        isoLevel: field.isoLevel,
      });
    }

    if (nearby.length === 0) return null;

    // Use the first nearby field's voxel size for the grid
    const voxelSize = nearby[0].voxelSize;
    const isoLevel = nearby[0].isoLevel;

    // Compute grid dimensions — capped to fit within maxVoxelFloats
    const maxDim = Math.floor(Math.cbrt(maxVoxelFloats));
    const desiredExtent = collisionRadius;
    const dim = Math.min(maxDim, Math.ceil((2 * desiredExtent) / voxelSize));
    const dimX = dim;
    const dimY = Math.min(dim, Math.ceil(desiredExtent / voxelSize) * 2);
    const dimZ = dim;

    // Grid origin centered on camera
    const originX = camX - (dimX / 2) * voxelSize;
    const originY = camY - (dimY / 2) * voxelSize;
    const originZ = camZ - (dimZ / 2) * voxelSize;

    const totalVoxels = dimX * dimY * dimZ;
    if (!this.pooledVoxelData || this.pooledVoxelData.length < totalVoxels) {
      this.pooledVoxelData = new Float32Array(totalVoxels);
    }
    const data = this.pooledVoxelData;
    data.fill(-1.0, 0, totalVoxels);

    // Sample from all nearby fields — take max density (solid wins)
    for (const entry of nearby) {
      const field = entry.field;
      const vs = entry.voxelSize;
      const eox = entry.worldOriginX;
      const eoy = entry.worldOriginY;
      const eoz = entry.worldOriginZ;

      for (let gx = 0; gx < dimX; gx++) {
        for (let gz = 0; gz < dimZ; gz++) {
          const worldX = originX + gx * voxelSize;
          const worldZ = originZ + gz * voxelSize;

          // Convert to field-local voxel indices
          const vx = Math.floor((worldX - eox) / vs);
          const vz = Math.floor((worldZ - eoz) / vs);
          if (vx < 0 || vx >= field.dimX || vz < 0 || vz >= field.dimZ) continue;

          for (let gy = 0; gy < dimY; gy++) {
            const worldY = originY + gy * voxelSize;
            const vy = Math.floor((worldY - eoy) / vs);
            if (vy < 0 || vy >= field.dimY) continue;

            let density: number;
            if (entry.isChunked) {
              density = getChunkedVoxel(field as ChunkedVoxelField, vx, vy, vz);
            } else {
              const vf = field as VoxelField;
              density = vf.data[vx * vf.dimY * vf.dimZ + vy * vf.dimZ + vz];
            }

            if (density > data[gx * dimY * dimZ + gy * dimZ + gz]) {
              data[gx * dimY * dimZ + gy * dimZ + gz] = density;
            }
          }
        }
      }
    }

    const result = this.pooledVoxelResult ?? (this.pooledVoxelResult = { data: data, originX, originY, originZ, voxelSize, dimX, dimY, dimZ, isoLevel });
    result.data = data;
    result.originX = originX;
    result.originY = originY;
    result.originZ = originZ;
    result.voxelSize = voxelSize;
    result.dimX = dimX;
    result.dimY = dimY;
    result.dimZ = dimZ;
    result.isoLevel = isoLevel;
    return result;
  }

  cleanupStaleDecorations(): void {
    for (const [key, deco] of this.decorationMeshes) {
      if (!this.activeDecorationKeys.has(key)) {
        deco.vertices.destroy();
        deco.indices.destroy();
        this.decorationMeshes.delete(key);
      }
    }
    for (const key of this.decorationEmptyKeys) {
      if (!this.activeDecorationKeys.has(key)) {
        this.decorationEmptyKeys.delete(key);
      }
    }
    this.activeDecorationKeys.clear();
  }

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

    // Store island metadata for decoration rendering
    if (type === EntityType.Island && islandMeta) {
      this.drawEntityChunkX[idx] = islandMeta.chunkX;
      this.drawEntityChunkZ[idx] = islandMeta.chunkZ;
      this.drawEntityBiome[idx] = islandMeta.biome;
      this.drawEntityIslandSize[idx] = islandMeta.islandSize;
      this.ensureIslandMesh(islandMeta.chunkX, islandMeta.chunkZ, scale, islandMeta.biome, islandMeta.islandSize);
      this.ensureDecorationMesh(islandMeta.chunkX, islandMeta.chunkZ, islandMeta.biome, islandMeta.islandSize, scale);
      // Keep the voxel field for terrain deformation (gun/shovel tools apply deformations to it)
    } else {
      this.drawEntityChunkX[idx] = 0;
      this.drawEntityChunkZ[idx] = 0;
    }

    // Derive port size from entity scale (PORT_SCALE: Small=15, Medium=25, Large=40)
    if (type === EntityType.Port) {
      if (scale <= 18) this.drawEntityPortSizes[idx] = PortSize.Small;
      else if (scale <= 32) this.drawEntityPortSizes[idx] = PortSize.Medium;
      else this.drawEntityPortSizes[idx] = PortSize.Large;
      // Generate port terrain mesh if metadata is available
      if (portMeta) {
        this.drawEntityChunkX[idx] = portMeta.chunkX;
        this.drawEntityChunkZ[idx] = portMeta.chunkZ;
        this.ensurePortMesh(portMeta.chunkX, portMeta.chunkZ, scale, portMeta.biome);
        this.ensurePortStructureMesh(portMeta.chunkX, portMeta.chunkZ, scale, portMeta.biome);
      }
    } else {
      this.drawEntityPortSizes[idx] = -1;
    }

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

    // Lighting params (floats 30-43, bytes 120-172)
    const lp = this.lightingParamsCache;
    uniforms[30] = lp.wetness ?? 0; // wetness (was _pad2)
    uniforms[31] = 0; // _pad3
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

    this.device.queue.writeBuffer(this.uniformBuffer, offset, uniforms);

    // Track draw entity count for renderHitboxes island wireframe iteration
    this.drawEntityCount = idx + 1;

    // Write hitbox uniform(s) — per-cell for boats, per-collider for ports, single for others
    if (this.hitboxUniformBuffer) {

      if ((type === EntityType.Ship || type === EntityType.SmallCraft) &&
          boatSlot >= 0 && this.boatBufferReader?.isValid()) {
        // Per-cell hitboxes showing the BoatCellSystem collision shape (player-on-ship collision).
        // These are NOT the Rapier physics colliders — Rapier uses a single bounding-box cuboid
        // (see RapierPhysicsSystem.buildAllBoatColliders). The Rapier box is drawn in blue below.
        const cells = this.boatBufferReader.getBoatCells(boatSlot);
        const rapierBlue: [number, number, number] = [0.2, 0.6, 1.0];

        // Compute Rapier single-box bounds from ALL cells (matching getShipBounds)
        let rMinX = Infinity, rMaxX = -Infinity;
        let rMinY = Infinity, rMaxY = -Infinity;
        let rMinZ = Infinity, rMaxZ = -Infinity;

        for (let ci = 0; ci < cells.length; ci++) {
          const cell = cells[ci];
          const geo = getCellGeometry(cell.type);
          const sx = cell.sizeX || 1;
          const sz = cell.sizeZ || 1;

          // Accumulate Rapier bounds from ALL cells (not just solid ones)
          const allMinX = cell.gridX * BOAT_CELL_WORLD_SIZE - BOAT_CELL_WORLD_SIZE / 2;
          const allMaxX = allMinX + sx * BOAT_CELL_WORLD_SIZE;
          const allMinZ = cell.gridZ * BOAT_CELL_WORLD_SIZE - BOAT_CELL_WORLD_SIZE / 2;
          const allMaxZ = allMinZ + sz * BOAT_CELL_WORLD_SIZE;
          const walkable = isWalkableSurface(cell.type);
          const allMinY = walkable
            ? cell.gridY * BOAT_LAYER_HEIGHT
            : cell.gridY * BOAT_LAYER_HEIGHT + geo.y0;
          const allMaxY = cell.gridY * BOAT_LAYER_HEIGHT + geo.y1 +
            (cell.sizeY > 1 ? (cell.sizeY - 1) * BOAT_LAYER_HEIGHT : 0);
          if (allMinX < rMinX) rMinX = allMinX;
          if (allMaxX > rMaxX) rMaxX = allMaxX;
          if (allMinZ < rMinZ) rMinZ = allMinZ;
          if (allMaxZ > rMaxZ) rMaxZ = allMaxZ;
          if (allMinY < rMinY) rMinY = allMinY;
          if (allMaxY > rMaxY) rMaxY = allMaxY;

          // Per-cell hitboxes (BoatCellSystem collision) — solid cells only
          if (!hasSolidCollision(cell.type)) continue;
          const halfX = (sx * BOAT_CELL_WORLD_SIZE) / 2;
          const halfZ = (sz * BOAT_CELL_WORLD_SIZE) / 2;
          const cellCx = cell.gridX * BOAT_CELL_WORLD_SIZE + (sx - 1) * BOAT_CELL_WORLD_SIZE / 2;
          const cellCz = cell.gridZ * BOAT_CELL_WORLD_SIZE + (sz - 1) * BOAT_CELL_WORLD_SIZE / 2;

          if (isWalkableSurface(cell.type)) {
            // Thin slab at layer base (BoatCellSystem walkable surface)
            const thinHalfY = 0.05;
            const cy = cell.gridY * BOAT_LAYER_HEIGHT + thinHalfY;
            this.writeHitboxEntry(cellCx, cy, cellCz, halfX, thinHalfY, halfZ, pos, rotation);
          } else if (isWallType(cell.type)) {
            // Wall: per-edge boxes from getWallCollisionBoxes, Y from CELL_GEOMETRY
            const boxes = getWallCollisionBoxes(cell.type, cell.rotation);
            const wallHalfY = (geo.y1 - geo.y0) / 2;
            const cy = cell.gridY * BOAT_LAYER_HEIGHT + geo.y0 + wallHalfY;
            const wallCx = cell.gridX * BOAT_CELL_WORLD_SIZE;
            const wallCz = cell.gridZ * BOAT_CELL_WORLD_SIZE;
            for (let bi = 0; bi < boxes.length; bi++) {
              const b = boxes[bi];
              this.writeHitboxEntry(wallCx + b.offsetX, cy, wallCz + b.offsetZ, b.halfX, wallHalfY, b.halfZ, pos, rotation);
            }
          } else {
            // Solid block: full y0-to-y1 box
            const totalHeight = (geo.y1 - geo.y0) + (cell.sizeY > 1 ? (cell.sizeY - 1) * BOAT_LAYER_HEIGHT : 0);
            const halfY = totalHeight / 2;
            const cy = cell.gridY * BOAT_LAYER_HEIGHT + geo.y0 + halfY;
            this.writeHitboxEntry(cellCx, cy, cellCz, halfX, halfY, halfZ, pos, rotation);
          }
        }

        // Rapier single-box hitbox (ship-vs-ship, ship-vs-port, player-vs-ship when not onboard)
        if (Number.isFinite(rMinX)) {
          const halfX = (rMaxX - rMinX) / 2;
          const halfY = (rMaxY - rMinY) / 2;
          const halfZ = (rMaxZ - rMinZ) / 2;
          const cx = (rMinX + rMaxX) / 2;
          const cy = (rMinY + rMaxY) / 2;
          const cz = (rMinZ + rMaxZ) / 2;
          this.writeHitboxEntry(cx, cy, cz, halfX, halfY, halfZ, pos, rotation, rapierBlue);
        }
      } else if (type === EntityType.Port) {
        // Port: dock + pier cuboid hitboxes matching physics colliders
        const portSize = this.drawEntityPortSizes[idx] ?? PortSize.Small;
        const cd = getPortColliderDims(portSize, scale);
        if (cd) {
          this.writeHitboxEntry(0, cd.dock.centerY, 0, cd.dock.halfW, cd.dock.halfH, cd.dock.halfD, pos, rotation);
          this.writeHitboxEntry(0, cd.pier.centerY, cd.pier.centerZ, cd.pier.halfW, cd.pier.halfH, cd.pier.halfL, pos, rotation);
        }
        // Structure hitboxes (buildings, cranes, lighthouse, breakwater)
        const structBoxes = getPortCollisionBoxes(portSize, scale);
        for (let bi = 0; bi < structBoxes.length; bi++) {
          const box = structBoxes[bi];
          this.writeHitboxEntry(box.cx, box.cy, box.cz, box.halfW, box.halfH, box.halfD, pos, rotation);
        }
      } else if (type === EntityType.Island) {
        // Island hitbox is rendered as a wireframe of the actual trimesh collision surface
        // in renderHitboxes() — no cube entry needed here.
      } else if (type === EntityType.Player) {
        // Player: tight box matching collision capsule height, no entity rotation
        this.writeHitboxEntry(0, PLAYER_HEIGHT / 2, 0, PLAYER_RADIUS, PLAYER_HEIGHT / 2, PLAYER_RADIUS, pos, { x: 0, y: 0, z: 0, w: 1 });
      } else {
        // Generic entity: use entity rotation and scale as half-extents
        this.writeHitboxEntry(0, 0, 0, scale, scale, scale, pos, rotation);
      }
    }
  }

  // --- Instanced rendering methods ---

  static isInstancedType(type: EntityType): boolean {
    return type !== EntityType.Player &&
           type !== EntityType.Ship &&
           type !== EntityType.SmallCraft &&
           type !== EntityType.Island &&
           type !== EntityType.Port;
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
    this.device.queue.writeBuffer(
      this.instanceStorageBuffer,
      0,
      view,
    );
  }

  renderInstanced(passEncoder: GPURenderPassEncoder): void {
    if (!this.instancedPipeline || !this.instancedBindGroup || !this.cubeVertices || !this.cubeIndices || this.instanceCount === 0) { this._lastFrameTriangles = 0; return; }
    passEncoder.setPipeline(this.instancedPipeline);
    passEncoder.setBindGroup(0, this.instancedBindGroup);
    if (this.lightBindGroup) {
      passEncoder.setBindGroup(1, this.lightBindGroup);
    }
    if (this.pbrBindGroup) {
      passEncoder.setBindGroup(2, this.pbrBindGroup);
    }
    passEncoder.setVertexBuffer(0, this.cubeVertices);
    passEncoder.setIndexBuffer(this.cubeIndices, "uint16");
    passEncoder.drawIndexed(this.cubeIndexCount, this.instanceCount);
    this._lastFrameTriangles = Math.floor(this.cubeIndexCount / 3) * this.instanceCount;
  }

  getLastFrameTriangles(): number {
    return this._lastFrameTriangles;
  }

  writeInstancedHitbox(
    pos: { x: number; y: number; z: number },
    scale: number,
    rotation: { x: number; y: number; z: number; w: number },
  ): void {
    this.writeHitboxEntry(0, 0, 0, scale, scale, scale, pos, rotation);
  }

  setPlayerMesh(meshes: MeshData[]): void {
    // Merge all meshes into a single vertex/index buffer with interleaved UVs and colors
    // Vertex format: [px, py, pz, nx, ny, nz, u, v, r, g, b] = 11 floats per vertex
    const allVerts: number[] = [];
    const allIdx: number[] = [];
    let vertOffset = 0;

    for (const mesh of meshes) {
      const vCount = mesh.vertexCount;
      for (let i = 0; i < vCount; i++) {
        // Position + normal (6 floats from mesh.vertices)
        for (let j = 0; j < 6; j++) {
          allVerts.push(mesh.vertices[i * 6 + j]);
        }
        // UV (2 floats from mesh.uvs, or 0 if no UVs)
        if (mesh.uvs) {
          allVerts.push(mesh.uvs[i * 2]);
          allVerts.push(mesh.uvs[i * 2 + 1]);
        } else {
          allVerts.push(0, 0);
        }
        // Color (3 floats from mesh.colors, or 1,1,1 if no colors)
        if (mesh.colors) {
          allVerts.push(mesh.colors[i * 3]);
          allVerts.push(mesh.colors[i * 3 + 1]);
          allVerts.push(mesh.colors[i * 3 + 2]);
        } else {
          allVerts.push(1, 1, 1);
        }
      }
      for (let i = 0; i < mesh.indexCount; i++) {
        allIdx.push((mesh.indices[i] >>> 0) + vertOffset);
      }
      vertOffset += vCount;
    }

    const stride = 11; // 11 floats per vertex (pos3 + normal3 + uv2 + color3)

    // FBX models typically use Z-up; convert to Y-up via -90° X rotation
    // (x, y, z) -> (x, z, -y)  — same transform applied to normals
    for (let i = 0; i < allVerts.length; i += stride) {
      const py = allVerts[i + 1];
      const pz = allVerts[i + 2];
      allVerts[i + 1] = pz;
      allVerts[i + 2] = -py;
      const ny = allVerts[i + 4];
      const nz = allVerts[i + 5];
      allVerts[i + 4] = nz;
      allVerts[i + 5] = -ny;
    }

    // Compute bounding box for normalization (after coordinate transform)
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

    // Normalize: center horizontally, feet at y=0, scale to unit height (1.0)
    // entity.scale (= PLAYER_HEIGHT) is applied by the shader to produce world-space size
    const height = maxY - minY;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const scale = height > 0 ? 1.0 / height : 1.0;

    for (let i = 0; i < allVerts.length; i += stride) {
      allVerts[i] = (allVerts[i] - cx) * scale;
      allVerts[i + 1] = (allVerts[i + 1] - minY) * scale;
      allVerts[i + 2] = (allVerts[i + 2] - cz) * scale;
    }

    // Recompute smooth normals from geometry — FBX normals are often
    // per-polygon-vertex or incorrectly indexed, causing bad shading
    const vertexCount = allVerts.length / stride;
    const newNormals = new Float32Array(vertexCount * 3);

    for (let i = 0; i < allIdx.length; i += 3) {
      const a = allIdx[i], b = allIdx[i + 1], c = allIdx[i + 2];
      const ax = allVerts[a * stride], ay = allVerts[a * stride + 1], az = allVerts[a * stride + 2];
      const bx = allVerts[b * stride], by = allVerts[b * stride + 1], bz = allVerts[b * stride + 2];
      const cxv = allVerts[c * stride], cyv = allVerts[c * stride + 1], czv = allVerts[c * stride + 2];
      // Face normal = cross(B-A, C-A)
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cxv - ax, vy = cyv - ay, vz = czv - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      // Accumulate to each vertex
      newNormals[a * 3] += nx; newNormals[a * 3 + 1] += ny; newNormals[a * 3 + 2] += nz;
      newNormals[b * 3] += nx; newNormals[b * 3 + 1] += ny; newNormals[b * 3 + 2] += nz;
      newNormals[c * 3] += nx; newNormals[c * 3 + 1] += ny; newNormals[c * 3 + 2] += nz;
    }

    // Normalize accumulated normals and write back
    for (let i = 0; i < vertexCount; i++) {
      const nx = newNormals[i * 3];
      const ny = newNormals[i * 3 + 1];
      const nz = newNormals[i * 3 + 2];
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      allVerts[i * stride + 3] = nx / len;
      allVerts[i * stride + 4] = ny / len;
      allVerts[i * stride + 5] = nz / len;
    }

    const vertArray = new Float32Array(allVerts);
    const useUint32 = allIdx.length > 65535 || vertOffset > 65535;
    const idxArray = useUint32 ? new Uint32Array(allIdx) : new Uint16Array(allIdx);

    this.playerMeshVertices = this.device.createBuffer({
      size: vertArray.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.playerMeshVertices, 0, vertArray);

    this.playerMeshIndexFormat = useUint32 ? "uint32" : "uint16";
    this.playerMeshIndexCount = allIdx.length;
    this.playerMeshIndices = this.device.createBuffer({
      size: idxArray.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.playerMeshIndices, 0, idxArray);
  }

  setSkinnedPlayerMesh(modelData: ModelData): void {
    if (!modelData.skin || !this.boneMatrixBuffer || !this.skinnedPlayerBindGroupLayout) {
      console.warn("[EntityRenderer] Cannot set skinned player mesh: missing skin data or pipeline");
      return;
    }

    const isYUp = modelData.format === "gltf" || modelData.format === "glb" || modelData.format === "fbx";

    // Create skeleton animator
    this.skeletonAnimator = new SkeletonAnimator(modelData.skin);

    // Register animations if available
    if (modelData.animations) {
      this.skeletonAnimator.registerAnimations(modelData.animations);
    }

    // Build skinned vertex buffer with joints and weights
    // Vertex format: pos(3) + normal(3) + uv(2) + color(3) + joints(4, uint8) + pad(4) + weights(4) = 64 bytes
    // Using Float32Array for the float parts and Uint8Array for joints, packed into a single ArrayBuffer
    const meshes = modelData.meshes;
    const allVertCount = meshes.reduce((sum, m) => sum + m.vertexCount, 0);
    const stride = 64; // bytes per vertex
    const vertBuffer = new ArrayBuffer(allVertCount * stride);
    const f32View = new Float32Array(vertBuffer);
    const u8View = new Uint8Array(vertBuffer);
    const allIdx: number[] = [];
    let vertOffset = 0;
    let f32Offset = 0; // in floats (stride/4 = 16 floats per vertex)

    for (let mi = 0; mi < meshes.length; mi++) {
      const mesh = meshes[mi];
      const vCount = mesh.vertexCount;

      for (let i = 0; i < vCount; i++) {
        const fOff = f32Offset + i * 16; // 16 floats per vertex (64 bytes / 4)

        if (isYUp) {
          // GLTF is already Y-up — no coordinate swap needed
          f32View[fOff] = mesh.vertices[i * 6];
          f32View[fOff + 1] = mesh.vertices[i * 6 + 1];
          f32View[fOff + 2] = mesh.vertices[i * 6 + 2];
          f32View[fOff + 3] = mesh.vertices[i * 6 + 3];
          f32View[fOff + 4] = mesh.vertices[i * 6 + 4];
          f32View[fOff + 5] = mesh.vertices[i * 6 + 5];
        } else {
          // FBX Z-up to Y-up: (x, y, z) -> (x, z, -y)
          f32View[fOff] = mesh.vertices[i * 6];
          f32View[fOff + 1] = mesh.vertices[i * 6 + 2];
          f32View[fOff + 2] = -mesh.vertices[i * 6 + 1];
          f32View[fOff + 3] = mesh.vertices[i * 6 + 3];
          f32View[fOff + 4] = mesh.vertices[i * 6 + 5];
          f32View[fOff + 5] = -mesh.vertices[i * 6 + 4];
        }

        // UV (2 floats)
        if (mesh.uvs) {
          f32View[fOff + 6] = mesh.uvs[i * 2];
          f32View[fOff + 7] = mesh.uvs[i * 2 + 1];
        } else {
          f32View[fOff + 6] = 0;
          f32View[fOff + 7] = 0;
        }

        // Color (3 floats)
        if (mesh.colors) {
          f32View[fOff + 8] = mesh.colors[i * 3];
          f32View[fOff + 9] = mesh.colors[i * 3 + 1];
          f32View[fOff + 10] = mesh.colors[i * 3 + 2];
        } else {
          f32View[fOff + 8] = 1;
          f32View[fOff + 9] = 1;
          f32View[fOff + 10] = 1;
        }

        // f32View[fOff + 11] = unused padding

        // Joints (4 bytes at byte offset 44 = float offset 11)
        const byteOff = (f32Offset + i * 16) * 4 + 44;
        if (mesh.joints) {
          u8View[byteOff] = mesh.joints[i * 4];
          u8View[byteOff + 1] = mesh.joints[i * 4 + 1];
          u8View[byteOff + 2] = mesh.joints[i * 4 + 2];
          u8View[byteOff + 3] = mesh.joints[i * 4 + 3];
        }

        // Weights (4 floats at byte offset 48 = float offset 12)
        if (mesh.weights) {
          f32View[fOff + 12] = mesh.weights[i * 4];
          f32View[fOff + 13] = mesh.weights[i * 4 + 1];
          f32View[fOff + 14] = mesh.weights[i * 4 + 2];
          f32View[fOff + 15] = mesh.weights[i * 4 + 3];
        }
      }

      for (let i = 0; i < mesh.indexCount; i++) {
        allIdx.push((mesh.indices[i] >>> 0) + vertOffset);
      }
      vertOffset += vCount;
      f32Offset += vCount * 16;
    }

    // Normalize: center horizontally, feet at y=0, scale to unit height
    let minY = Infinity, maxY = -Infinity;
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < allVertCount; i++) {
      const fOff = i * 16;
      const x = f32View[fOff], y = f32View[fOff + 1], z = f32View[fOff + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const height = maxY - minY;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const scale = height > 0 ? 1.0 / height : 1.0;

    for (let i = 0; i < allVertCount; i++) {
      const fOff = i * 16;
      f32View[fOff] = (f32View[fOff] - cx) * scale;
      f32View[fOff + 1] = (f32View[fOff + 1] - minY) * scale;
      f32View[fOff + 2] = (f32View[fOff + 2] - cz) * scale;
    }

    // Build normalization matrix N = T * S * R and its inverse N^-1 = R^-1 * S^-1 * T^-1
    // For GLTF (Y-up): R = identity, so N = T * S
    // For FBX (Z-up): R = Z-up to Y-up rotation
    const normMat = new Float32Array(16);
    const invNormMat = new Float32Array(16);
    const invScale = 1.0 / scale;
    if (isYUp) {
      // N = T * S (column-major, no rotation)
      // N = [s,0,0,0, 0,s,0,0, 0,0,s,0, -cx*s,-minY*s,-cz*s,1]
      normMat[0] = scale; normMat[1] = 0; normMat[2] = 0; normMat[3] = 0;
      normMat[4] = 0; normMat[5] = scale; normMat[6] = 0; normMat[7] = 0;
      normMat[8] = 0; normMat[9] = 0; normMat[10] = scale; normMat[11] = 0;
      normMat[12] = -cx * scale; normMat[13] = -minY * scale; normMat[14] = -cz * scale; normMat[15] = 1;
      // N^-1 = S^-1 * T^-1 = [1/s,0,0,0, 0,1/s,0,0, 0,0,1/s,0, cx,minY,cz,1]
      invNormMat[0] = invScale; invNormMat[1] = 0; invNormMat[2] = 0; invNormMat[3] = 0;
      invNormMat[4] = 0; invNormMat[5] = invScale; invNormMat[6] = 0; invNormMat[7] = 0;
      invNormMat[8] = 0; invNormMat[9] = 0; invNormMat[10] = invScale; invNormMat[11] = 0;
      invNormMat[12] = cx; invNormMat[13] = minY; invNormMat[14] = cz; invNormMat[15] = 1;
    } else {
      // N = T * S * R (column-major)
      // R = [1,0,0,0, 0,0,1,0, 0,-1,0,0, 0,0,0,1]
      // S*R = [s,0,0,0, 0,0,s,0, 0,-s,0,0, 0,0,0,1]
      // T*S*R = [s,0,0,0, 0,0,s,0, 0,-s,0,0, -cx*s,-minY*s,-cz*s,1]
      normMat[0] = scale; normMat[1] = 0; normMat[2] = 0; normMat[3] = 0;
      normMat[4] = 0; normMat[5] = 0; normMat[6] = -scale; normMat[7] = 0;
      normMat[8] = 0; normMat[9] = scale; normMat[10] = 0; normMat[11] = 0;
      normMat[12] = -cx * scale; normMat[13] = -minY * scale; normMat[14] = -cz * scale; normMat[15] = 1;
      // N^-1 = R^-1 * S^-1 * T^-1
      // R^-1 = [1,0,0,0, 0,0,-1,0, 0,1,0,0, 0,0,0,1] (Y-up to Z-up: (x,y,z)->(x,-z,y))
      // R^-1 * (S^-1 * T^-1) = [1/s,0,0,0, 0,0,-1/s,0, 0,1/s,0,0, cx,minY,cz,1]
      invNormMat[0] = invScale; invNormMat[1] = 0; invNormMat[2] = 0; invNormMat[3] = 0;
      invNormMat[4] = 0; invNormMat[5] = 0; invNormMat[6] = invScale; invNormMat[7] = 0;
      invNormMat[8] = 0; invNormMat[9] = -invScale; invNormMat[10] = 0; invNormMat[11] = 0;
      invNormMat[12] = cx; invNormMat[13] = minY; invNormMat[14] = cz; invNormMat[15] = 1;
    }

    if (this.skeletonAnimator) {
      this.skeletonAnimator.setNormalizationMatrix(normMat, invNormMat);
    }

    // Recompute smooth normals
    const newNormals = new Float32Array(allVertCount * 3);
    for (let i = 0; i < allIdx.length; i += 3) {
      const a = allIdx[i], b = allIdx[i + 1], c = allIdx[i + 2];
      const ax = f32View[a * 16], ay = f32View[a * 16 + 1], az = f32View[a * 16 + 2];
      const bx = f32View[b * 16], by = f32View[b * 16 + 1], bz = f32View[b * 16 + 2];
      const cxv = f32View[c * 16], cyv = f32View[c * 16 + 1], czv = f32View[c * 16 + 2];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cxv - ax, vy = cyv - ay, vz = czv - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      newNormals[a * 3] += nx; newNormals[a * 3 + 1] += ny; newNormals[a * 3 + 2] += nz;
      newNormals[b * 3] += nx; newNormals[b * 3 + 1] += ny; newNormals[b * 3 + 2] += nz;
      newNormals[c * 3] += nx; newNormals[c * 3 + 1] += ny; newNormals[c * 3 + 2] += nz;
    }
    for (let i = 0; i < allVertCount; i++) {
      const nx = newNormals[i * 3];
      const ny = newNormals[i * 3 + 1];
      const nz = newNormals[i * 3 + 2];
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      f32View[i * 16 + 3] = nx / len;
      f32View[i * 16 + 4] = ny / len;
      f32View[i * 16 + 5] = nz / len;
    }

    // Upload vertex buffer
    this.skinnedPlayerVertices = this.device.createBuffer({
      size: vertBuffer.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.skinnedPlayerVertices, 0, vertBuffer);

    // Upload index buffer
    const useUint32 = allIdx.length > 65535 || vertOffset > 65535;
    const idxArray = useUint32 ? new Uint32Array(allIdx) : new Uint16Array(allIdx);
    this.skinnedPlayerIndexFormat = useUint32 ? "uint32" : "uint16";
    this.skinnedPlayerIndexCount = allIdx.length;
    this.skinnedPlayerIndices = this.device.createBuffer({
      size: idxArray.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.skinnedPlayerIndices, 0, idxArray);

    // Create render bind group (reuses playerSampler and playerTexture)
    this.skinnedPlayerBindGroup = this.device.createBindGroup({
      layout: this.skinnedPlayerBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer!, size: 256 } },
        { binding: 1, resource: this.playerSampler! },
        { binding: 2, resource: this.playerTexture!.createView() },
        { binding: 3, resource: { buffer: this.boneMatrixBuffer! } },
      ],
    });

    // Initialize GPU skinning buffers and compute pipeline
    if (this.skeletonAnimator) {
      const boneCount = this.skeletonAnimator.getBoneCount();
      this.skinningBoneCount = boneCount;

      // Skinning uniform buffer: boneCount, hasNormalization, padding, normMatrix, invNormMatrix
      const skinningUniformSize = 144; // 16 bytes header + 64 bytes * 2 matrices
      this.skinningUniformBuffer = this.device.createBuffer({
        size: skinningUniformSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      // Local transform buffers (updated each frame via queue.writeBuffer)
      this.localPosBuffer = this.device.createBuffer({
        size: boneCount * 4 * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.localRotBuffer = this.device.createBuffer({
        size: boneCount * 4 * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.localScaleBuffer = this.device.createBuffer({
        size: boneCount * 4 * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      // Static data buffers (uploaded once)
      this.parentIndexBuffer = this.device.createBuffer({
        size: boneCount * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.inverseBindBuffer = this.device.createBuffer({
        size: boneCount * 16 * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      // Upload static data
      const parentIndices = this.skeletonAnimator.getParentIndices();
      const parentCopy = new Int32Array(parentIndices.length); parentCopy.set(parentIndices);
      this.device.queue.writeBuffer(this.parentIndexBuffer, 0, parentCopy.buffer);
      const inverseBind = this.skeletonAnimator.getInverseBindMatricesFlat();
      const ibmCopy = new Float32Array(inverseBind.length); ibmCopy.set(inverseBind);
      this.device.queue.writeBuffer(this.inverseBindBuffer, 0, ibmCopy.buffer);

      // Upload skinning uniforms (bone count, normalization matrices)
      const normMat = this.skeletonAnimator.getNormalizationMatrix();
      const invNormMat = this.skeletonAnimator.getInverseNormalizationMatrix();
      const hasNorm = normMat && invNormMat ? 1 : 0;
      const uniformData = new ArrayBuffer(skinningUniformSize);
      const u32View = new Uint32Array(uniformData);
      const f32View = new Float32Array(uniformData);
      u32View[0] = boneCount;
      u32View[1] = hasNorm;
      if (normMat) f32View.set(normMat, 4); // offset 16 bytes = 4 floats
      if (invNormMat) f32View.set(invNormMat, 20); // offset 80 bytes = 20 floats
      this.device.queue.writeBuffer(this.skinningUniformBuffer, 0, uniformData);

      // Create compute bind group
      this.skinningComputeBindGroup = this.device.createBindGroup({
        layout: this.skinningComputeBindGroupLayout!,
        entries: [
          { binding: 0, resource: { buffer: this.skinningUniformBuffer! } },
          { binding: 1, resource: { buffer: this.localPosBuffer! } },
          { binding: 2, resource: { buffer: this.localRotBuffer! } },
          { binding: 3, resource: { buffer: this.localScaleBuffer! } },
          { binding: 4, resource: { buffer: this.parentIndexBuffer! } },
          { binding: 5, resource: { buffer: this.inverseBindBuffer! } },
          { binding: 6, resource: { buffer: this.boneMatrixBuffer! } },
        ],
      });

      // Initialize with rest pose: update animator, upload local transforms, dispatch compute
      this.skeletonAnimator.update(0, 0, 0);
      this.updateBoneLocalTransforms();
      const initEncoder = this.device.createCommandEncoder();
      this.dispatchSkinningCompute(initEncoder);
      this.device.queue.submit([initEncoder.finish()]);
    }

    console.log(`[EntityRenderer] Skinned player mesh loaded: ${allVertCount} vertices, ${allIdx.length} indices, ${modelData.skin?.bones.length ?? 0} bones`);
  }

  updateBoneLocalTransforms(): void {
    if (!this.skeletonAnimator || !this.localPosBuffer || !this.localRotBuffer || !this.localScaleBuffer) return;
    const pos = this.skeletonAnimator.getLocalPosFlat();
    const rot = this.skeletonAnimator.getLocalRotFlat();
    const scale = this.skeletonAnimator.getLocalScaleFlat();
    const posCopy = new Float32Array(pos.length); posCopy.set(pos);
    const rotCopy = new Float32Array(rot.length); rotCopy.set(rot);
    const scaleCopy = new Float32Array(scale.length); scaleCopy.set(scale);
    this.device.queue.writeBuffer(this.localPosBuffer, 0, posCopy.buffer);
    this.device.queue.writeBuffer(this.localRotBuffer, 0, rotCopy.buffer);
    this.device.queue.writeBuffer(this.localScaleBuffer, 0, scaleCopy.buffer);
  }

  dispatchSkinningCompute(encoder: GPUCommandEncoder): void {
    if (!this.skinningComputePipeline || !this.skinningComputeBindGroup || this.skinningBoneCount === 0) return;
    const passEncoder = encoder.beginComputePass();
    passEncoder.setPipeline(this.skinningComputePipeline);
    passEncoder.setBindGroup(0, this.skinningComputeBindGroup);
    const workgroupCount = Math.ceil(this.skinningBoneCount / 64);
    passEncoder.dispatchWorkgroups(workgroupCount);
    passEncoder.end();
  }

  getSkeletonAnimator(): SkeletonAnimator | null {
    return this.skeletonAnimator;
  }

  addClothingPiece(name: string, modelData: ModelData): void {
    if (!modelData.skin || !this.skinnedPlayerBindGroupLayout) {
      console.warn(`[EntityRenderer] Cannot add clothing piece "${name}": missing skin data or pipeline`);
      return;
    }

    const meshes = modelData.meshes;
    const allVertCount = meshes.reduce((sum, m) => sum + m.vertexCount, 0);
    const stride = 64;
    const vertBuffer = new ArrayBuffer(allVertCount * stride);
    const f32View = new Float32Array(vertBuffer);
    const u8View = new Uint8Array(vertBuffer);
    const allIdx: number[] = [];
    let vertOffset = 0;
    let f32Offset = 0;

    // Use the same bone name-to-index mapping as the main skeleton
    const mainSkin = this.skeletonAnimator
      ? null
      : null; // We'll use the bone indices from the clothing's own skin, remapped to main skeleton

    for (let mi = 0; mi < meshes.length; mi++) {
      const mesh = meshes[mi];
      const vCount = mesh.vertexCount;

      for (let i = 0; i < vCount; i++) {
        const fOff = f32Offset + i * 16;

        f32View[fOff] = mesh.vertices[i * 6];
        f32View[fOff + 1] = mesh.vertices[i * 6 + 2];
        f32View[fOff + 2] = -mesh.vertices[i * 6 + 1];

        f32View[fOff + 3] = mesh.vertices[i * 6 + 3];
        f32View[fOff + 4] = mesh.vertices[i * 6 + 5];
        f32View[fOff + 5] = -mesh.vertices[i * 6 + 4];

        if (mesh.uvs) {
          f32View[fOff + 6] = mesh.uvs[i * 2];
          f32View[fOff + 7] = mesh.uvs[i * 2 + 1];
        }

        if (mesh.colors) {
          f32View[fOff + 8] = mesh.colors[i * 3];
          f32View[fOff + 9] = mesh.colors[i * 3 + 1];
          f32View[fOff + 10] = mesh.colors[i * 3 + 2];
        } else {
          f32View[fOff + 8] = 1;
          f32View[fOff + 9] = 1;
          f32View[fOff + 10] = 1;
        }

        // Remap joint indices from clothing's bone indices to main skeleton's bone indices
        const byteOff = (f32Offset + i * 16) * 4 + 44;
        if (mesh.joints && modelData.skin) {
          for (let j = 0; j < 4; j++) {
            const clothingBoneIdx = mesh.joints[i * 4 + j];
            const boneName = modelData.skin.bones[clothingBoneIdx]?.name ?? "";
            const mainBoneIdx = this.skeletonAnimator
              ? (this.skeletonAnimator as any).boneNameToIndex.get(boneName) ?? 0
              : 0;
            u8View[byteOff + j] = mainBoneIdx;
          }
        }

        if (mesh.weights) {
          f32View[fOff + 12] = mesh.weights[i * 4];
          f32View[fOff + 13] = mesh.weights[i * 4 + 1];
          f32View[fOff + 14] = mesh.weights[i * 4 + 2];
          f32View[fOff + 15] = mesh.weights[i * 4 + 3];
        }
      }

      for (let i = 0; i < mesh.indexCount; i++) {
        allIdx.push((mesh.indices[i] >>> 0) + vertOffset);
      }
      vertOffset += vCount;
      f32Offset += vCount * 16;
    }

    // Apply same normalization as main mesh
    let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < allVertCount; i++) {
      const fOff = i * 16;
      const x = f32View[fOff], y = f32View[fOff + 1], z = f32View[fOff + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const height = maxY - minY;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const scale = height > 0 ? 1.0 / height : 1.0;
    for (let i = 0; i < allVertCount; i++) {
      const fOff = i * 16;
      f32View[fOff] = (f32View[fOff] - cx) * scale;
      f32View[fOff + 1] = (f32View[fOff + 1] - minY) * scale;
      f32View[fOff + 2] = (f32View[fOff + 2] - cz) * scale;
    }

    // Recompute smooth normals
    const newNormals = new Float32Array(allVertCount * 3);
    for (let i = 0; i < allIdx.length; i += 3) {
      const a = allIdx[i], b = allIdx[i + 1], c = allIdx[i + 2];
      const ux = f32View[b * 16] - f32View[a * 16], uy = f32View[b * 16 + 1] - f32View[a * 16 + 1], uz = f32View[b * 16 + 2] - f32View[a * 16 + 2];
      const vx = f32View[c * 16] - f32View[a * 16], vy = f32View[c * 16 + 1] - f32View[a * 16 + 1], vz = f32View[c * 16 + 2] - f32View[a * 16 + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      newNormals[a * 3] += nx; newNormals[a * 3 + 1] += ny; newNormals[a * 3 + 2] += nz;
      newNormals[b * 3] += nx; newNormals[b * 3 + 1] += ny; newNormals[b * 3 + 2] += nz;
      newNormals[c * 3] += nx; newNormals[c * 3 + 1] += ny; newNormals[c * 3 + 2] += nz;
    }
    for (let i = 0; i < allVertCount; i++) {
      const nx = newNormals[i * 3], ny = newNormals[i * 3 + 1], nz = newNormals[i * 3 + 2];
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      f32View[i * 16 + 3] = nx / len;
      f32View[i * 16 + 4] = ny / len;
      f32View[i * 16 + 5] = nz / len;
    }

    const vertGPUBuffer = this.device.createBuffer({
      size: vertBuffer.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(vertGPUBuffer, 0, vertBuffer);

    const useUint32 = allIdx.length > 65535 || vertOffset > 65535;
    const idxArray = useUint32 ? new Uint32Array(allIdx) : new Uint16Array(allIdx);
    const idxGPUBuffer = this.device.createBuffer({
      size: idxArray.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(idxGPUBuffer, 0, idxArray);

    this.clothingPieces.push({
      name,
      vertices: vertGPUBuffer,
      indices: idxGPUBuffer,
      indexCount: allIdx.length,
      indexFormat: useUint32 ? "uint32" : "uint16",
      texture: null,
      visible: true,
    });

    console.log(`[EntityRenderer] Clothing piece "${name}" loaded: ${allVertCount} vertices, ${allIdx.length} indices`);
  }

  setBedMesh(meshes: MeshData[]): void {
    // Convert FBX mesh to boat vertex format: [px, py, pz, nx, ny, nz, r, g, b] = 9 floats
    // FBX models use Z-up; convert to Y-up via (x, y, z) -> (x, z, -y)
    const stride = 9;
    const allVerts: number[] = [];
    const allIdx: number[] = [];
    let vertOffset = 0;

    for (let mi = 0; mi < meshes.length; mi++) {
      const mesh = meshes[mi];
      const vCount = mesh.vertexCount;
      for (let i = 0; i < vCount; i++) {
        let px = mesh.vertices[i * 6];
        let py = mesh.vertices[i * 6 + 1];
        let pz = mesh.vertices[i * 6 + 2];
        let nx = mesh.vertices[i * 6 + 3];
        let ny = mesh.vertices[i * 6 + 4];
        let nz = mesh.vertices[i * 6 + 5];

        // Z-up to Y-up: (x, y, z) -> (x, z, -y)
        const tmpY = py;
        py = pz;
        pz = -tmpY;
        const tmpNY = ny;
        ny = nz;
        nz = -tmpNY;

        // Color from mesh.colors or default white
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

    // Compute bounding box for normalization
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

    // Scale to fit the 1x2 cell footprint (1 cell wide in X, 2 cells long in Z)
    // Scale X and Z independently to fill the footprint; scale Y to fit within layer height
    const sizeX = maxX - minX;
    const sizeY = maxY - minY;
    const sizeZ = maxZ - minZ;
    const targetX = BOAT_CELL_WORLD_SIZE * 0.9; // slight margin
    const targetZ = BOAT_CELL_WORLD_SIZE * 2 * 0.9;
    const targetY = BOAT_LAYER_HEIGHT * 0.45; // bed height ~0.45 of a layer
    const scaleX = targetX / (sizeX || 1);
    const scaleZ = targetZ / (sizeZ || 1);
    const scaleY = Math.min(targetY / (sizeY || 1), Math.max(scaleX, scaleZ));

    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;

    // Center horizontally, place bottom at y=0
    for (let i = 0; i < allVerts.length; i += stride) {
      allVerts[i] = (allVerts[i] - cx) * scaleX;
      allVerts[i + 1] = (allVerts[i + 1] - minY) * scaleY;
      allVerts[i + 2] = (allVerts[i + 2] - cz) * scaleZ;
    }

    this.bedMeshVerts = allVerts;
    this.bedMeshIdx = allIdx;
    this.bedMeshVertCount = allVerts.length / stride;
  }

  setPlayerTexture(image: ImageBitmap | HTMLImageElement): void {
    if (this.playerTexture) this.playerTexture.destroy();
    this.playerTexture = this.device.createTexture({
      size: [image.width, image.height],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture(
      { source: image },
      { texture: this.playerTexture },
      [image.width, image.height],
    );
    // Recreate bind group with new texture
    if (this.playerBindGroupLayout && this.playerSampler && this.uniformBuffer) {
      this.playerBindGroup = this.device.createBindGroup({
        layout: this.playerBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer, size: 256 } },
          { binding: 1, resource: this.playerSampler },
          { binding: 2, resource: this.playerTexture.createView() },
        ],
      });
    }
  }

  render(passEncoder: GPURenderPassEncoder, idx: number): void {
    if (!this.bindGroup || !this.uniformBuffer) { return; }

    let tris = 0;

    // Bind dynamic light storage buffer (group 1) — same for all lit pipelines in this frame
    if (this.lightBindGroup) {
      passEncoder.setBindGroup(1, this.lightBindGroup);
    }

    // Bind PBR resources (group 2) — BRDF LUT + sampler for IBL
    if (this.pbrBindGroup) {
      passEncoder.setBindGroup(2, this.pbrBindGroup);
    }

    const type = this.drawEntityTypes[idx] ?? EntityType.Player;
    const isBoat = type === EntityType.Ship || type === EntityType.SmallCraft;
    const boatSlot = this.drawEntityBoatSlots[idx] ?? -1;

    // Use skinned player mesh for Player entities when available (rigged character with skeletal animation)
    if (type === EntityType.Player && this.skinnedPlayerVertices && this.skinnedPlayerIndices && this.skinnedPlayerPipeline && this.skinnedPlayerBindGroup) {
      passEncoder.setPipeline(this.skinnedPlayerPipeline);
      passEncoder.setBindGroup(0, this.skinnedPlayerBindGroup, [idx * 256]);
      passEncoder.setVertexBuffer(0, this.skinnedPlayerVertices);
      passEncoder.setIndexBuffer(this.skinnedPlayerIndices, this.skinnedPlayerIndexFormat);
      passEncoder.drawIndexed(this.skinnedPlayerIndexCount);
      tris += Math.floor(this.skinnedPlayerIndexCount / 3);

      // Render clothing pieces (share same bone matrix bind group)
      for (let ci = 0; ci < this.clothingPieces.length; ci++) {
        const piece = this.clothingPieces[ci];
        if (!piece.visible) continue;
        passEncoder.setVertexBuffer(0, piece.vertices);
        passEncoder.setIndexBuffer(piece.indices, piece.indexFormat);
        passEncoder.drawIndexed(piece.indexCount);
        tris += Math.floor(piece.indexCount / 3);
      }
      this._lastFrameTriangles += tris;
      return;
    }

    // Use player model mesh for Player entities when available
    if (type === EntityType.Player && this.playerMeshVertices && this.playerMeshIndices && this.playerPipeline && this.playerBindGroup) {
      passEncoder.setPipeline(this.playerPipeline);
      passEncoder.setBindGroup(0, this.playerBindGroup, [idx * 256]);
      passEncoder.setVertexBuffer(0, this.playerMeshVertices);
      passEncoder.setIndexBuffer(this.playerMeshIndices, this.playerMeshIndexFormat);
      passEncoder.drawIndexed(this.playerMeshIndexCount);
      this._lastFrameTriangles += Math.floor(this.playerMeshIndexCount / 3);
      return;
    }

    // Island: use per-island volumetric mesh (marching cubes, pos+normal+color vertex format)
    if (type === EntityType.Island && this.islandPipeline) {
      const chunkX = this.drawEntityChunkX[idx] ?? 0;
      const chunkZ = this.drawEntityChunkZ[idx] ?? 0;
      const islandKey = `${chunkX},${chunkZ}`;
      const islandMesh = this.islandMeshes.get(islandKey);
      if (islandMesh && islandMesh.indexCount > 0) {
        passEncoder.setPipeline(this.islandPipeline);
        passEncoder.setBindGroup(0, this.bindGroup, [idx * 256]);
        passEncoder.setVertexBuffer(0, islandMesh.vertices);
        passEncoder.setIndexBuffer(islandMesh.indices, islandMesh.useUint32 ? "uint32" : "uint16");
        passEncoder.drawIndexed(islandMesh.indexCount);
        tris += Math.floor(islandMesh.indexCount / 3);

        // Render decorations for this island (second draw call, same pipeline/uniform)
        const deco = this.decorationMeshes.get(islandKey);
        if (deco && deco.indexCount > 0) {
          passEncoder.setVertexBuffer(0, deco.vertices);
          passEncoder.setIndexBuffer(deco.indices, "uint16");
          passEncoder.drawIndexed(deco.indexCount);
          tris += Math.floor(deco.indexCount / 3);
        }
      } else {
        // Render chunked island meshes (progressive streaming)
        const chunkMap = this.islandChunkMeshes.get(islandKey);
        if (chunkMap && chunkMap.size > 0) {
          passEncoder.setPipeline(this.islandPipeline);
          passEncoder.setBindGroup(0, this.bindGroup, [idx * 256]);
          const chunkEntries = Array.from(chunkMap.values());
          for (let ci = 0; ci < chunkEntries.length; ci++) {
            const chunk = chunkEntries[ci];
            if (chunk.indexCount > 0) {
              passEncoder.setVertexBuffer(0, chunk.vertices);
              passEncoder.setIndexBuffer(chunk.indices, chunk.useUint32 ? "uint32" : "uint16");
              passEncoder.drawIndexed(chunk.indexCount);
              tris += Math.floor(chunk.indexCount / 3);
            }
          }
          // Render decorations for this island
          const deco = this.decorationMeshes.get(islandKey);
          if (deco && deco.indexCount > 0) {
            passEncoder.setVertexBuffer(0, deco.vertices);
            passEncoder.setIndexBuffer(deco.indices, "uint16");
            passEncoder.drawIndexed(deco.indexCount);
            tris += Math.floor(deco.indexCount / 3);
          }
        }
      }
      this._lastFrameTriangles += tris;
      return;
    }

    // Port: render terrain base + dedicated procedural mesh with boat pipeline
    if (type === EntityType.Port) {
      // First: render port terrain (flat plateau with beach/caves) using island pipeline
      const chunkX = this.drawEntityChunkX[idx] ?? 0;
      const chunkZ = this.drawEntityChunkZ[idx] ?? 0;
      const portTerrainKey = `${chunkX},${chunkZ}`;
      const portTerrain = this.portTerrainMeshes.get(portTerrainKey);
      if (portTerrain && portTerrain.indexCount > 0 && this.islandPipeline) {
        passEncoder.setPipeline(this.islandPipeline);
        passEncoder.setBindGroup(0, this.bindGroup, [idx * 256]);
        passEncoder.setVertexBuffer(0, portTerrain.vertices);
        passEncoder.setIndexBuffer(portTerrain.indices, portTerrain.useUint32 ? "uint32" : "uint16");
        passEncoder.drawIndexed(portTerrain.indexCount);
        tris += Math.floor(portTerrain.indexCount / 3);
      }

      // Second: render biome-specific port structures (dock, pier, buildings)
      const portStruct = this.portStructureMeshes.get(portTerrainKey);
      if (portStruct && portStruct.indexCount > 0 && this.boatPipeline) {
        passEncoder.setPipeline(this.boatPipeline);
        passEncoder.setBindGroup(0, this.bindGroup, [idx * 256]);
        passEncoder.setVertexBuffer(0, portStruct.vertices);
        passEncoder.setIndexBuffer(portStruct.indices, portStruct.useUint32 ? "uint32" : "uint16");
        passEncoder.drawIndexed(portStruct.indexCount);
        tris += Math.floor(portStruct.indexCount / 3);
        this._lastFrameTriangles += tris;
        return;
      }

      // Fallback: legacy pre-generated per-size mesh
      if (this.boatPipeline) {
        const portSize = this.drawEntityPortSizes[idx] ?? PortSize.Medium;
        const ps = portSize === PortSize.Small ? 0 : portSize === PortSize.Medium ? 1 : 2;
        const pv = this.portVertices[ps];
        const pi = this.portIndices[ps];
        const pic = this.portIndexCounts[ps];
        if (pv && pi && pic > 0) {
          passEncoder.setPipeline(this.boatPipeline);
          passEncoder.setBindGroup(0, this.bindGroup, [idx * 256]);
          passEncoder.setVertexBuffer(0, pv);
          passEncoder.setIndexBuffer(pi, "uint16");
          passEncoder.drawIndexed(pic);
          this._lastFrameTriangles += Math.floor(pic / 3);
          return;
        }
      }
    }

    if (isBoat && this.boatPipeline && this.boatVertices && this.boatIndices && boatSlot >= 0) {
      const count = this.boatIndexCounts[boatSlot] ?? 0;
      const offset = this.boatIndexOffsets[boatSlot] ?? 0;
      if (count > 0) {
        passEncoder.setPipeline(this.boatPipeline);
        passEncoder.setBindGroup(0, this.bindGroup, [idx * 256]);
        passEncoder.setVertexBuffer(0, this.boatVertices);
        passEncoder.setIndexBuffer(this.boatIndices, "uint16");
        passEncoder.drawIndexed(count, 1, offset, 0, 0);
        this._lastFrameTriangles += Math.floor(count / 3);
        return;
      }
    }
    if (this.pipeline && this.cubeVertices && this.cubeIndices) {
      passEncoder.setPipeline(this.pipeline);
      passEncoder.setBindGroup(0, this.bindGroup, [idx * 256]);
      passEncoder.setVertexBuffer(0, this.cubeVertices);
      passEncoder.setIndexBuffer(this.cubeIndices, "uint16");
      passEncoder.drawIndexed(this.cubeIndexCount);
      this._lastFrameTriangles += Math.floor(this.cubeIndexCount / 3);
    }
  }

  renderHitboxes(passEncoder: GPURenderPassEncoder): void {
    if (!this.showHitboxes || !this.hitboxPipeline || !this.hitboxQuadVertices || !this.hitboxQuadIndices || !this.hitboxBindGroup || !this.hitboxUniformBuffer) return;

    passEncoder.setPipeline(this.hitboxPipeline);
    passEncoder.setVertexBuffer(0, this.hitboxQuadVertices);
    passEncoder.setIndexBuffer(this.hitboxQuadIndices, "uint16");

    for (let i = 0; i < this.hitboxEntryCount; i++) {
      passEncoder.setBindGroup(0, this.hitboxBindGroup, [i * 256]);
      passEncoder.drawIndexed(this.hitboxQuadIndexCount);
    }

    // Render island wireframe hitboxes — shows the actual trimesh collision surface
    // instead of a bounding cube. Uses the main uniform buffer (entity pos/scale/rotation).
    if (this.islandWireframePipeline && this.bindGroup) {
      passEncoder.setPipeline(this.islandWireframePipeline);
      for (let i = 0; i < this.drawEntityCount; i++) {
        if (this.drawEntityTypes[i] === EntityType.Island) {
          const chunkX = this.drawEntityChunkX[i] ?? 0;
          const chunkZ = this.drawEntityChunkZ[i] ?? 0;
          const islandKey = `${chunkX},${chunkZ}`;
          const islandMesh = this.islandMeshes.get(islandKey);
          if (islandMesh && islandMesh.lineIndices && islandMesh.lineIndexCount > 0) {
            passEncoder.setVertexBuffer(0, islandMesh.vertices);
            passEncoder.setIndexBuffer(islandMesh.lineIndices, islandMesh.useUint32 ? "uint32" : "uint16");
            passEncoder.setBindGroup(0, this.bindGroup, [i * 256]);
            passEncoder.drawIndexed(islandMesh.lineIndexCount);
          }
        }
      }
    }
  }

  private ensureHoloCapacity(neededVerts: number, neededIndices: number): boolean {
    if (neededVerts <= this.holoVertCapacity && neededIndices <= this.holoIndexCapacity) {
      return true;
    }
    if (!this.holoVertices || !this.holoIndices) return false;

    // Grow to 2x the needed size (avoids frequent reallocations)
    const newVertCap = Math.max(neededVerts, this.holoVertCapacity * 2);
    const newIndexCap = Math.max(neededIndices, this.holoIndexCapacity * 2);

    this.holoVertices.destroy();
    this.holoIndices.destroy();

    this.holoVertices = this.device.createBuffer({
      size: newVertCap * 36,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.holoIndices = this.device.createBuffer({
      size: newIndexCap * 2,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.holoVertCapacity = newVertCap;
    this.holoIndexCapacity = newIndexCap;
    console.log(`[Holo] Buffers resized to ${newVertCap} verts / ${newIndexCap} indices`);
    return true;
  }

  // Render holo preview for boat building
  renderHoloPreview(
    passEncoder: GPURenderPassEncoder,
    shipPos: { x: number; y: number; z: number },
    shipRot: { x: number; y: number; z: number; w: number },
  ): void {
    if (!this.holoPipeline || !this.holoVertices || !this.holoIndices || !this.bindGroup || !this.uniformBuffer || !this.viewProjCache) return;
    if (!this.boatBufferReader || !this.boatBufferReader.isValid()) return;

    const preview = this.boatBufferReader.getPreview();
    if (!preview.visible) return;

    // Convert grid coords to local world position (relative to ship center)
    const localX = preview.gridX * BOAT_CELL_WORLD_SIZE;
    const localZ = preview.gridZ * BOAT_CELL_WORLD_SIZE;
    const localY = preview.gridY * BOAT_LAYER_HEIGHT;

    // Rotate local offset by ship rotation
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

    const holoPos = {
      x: shipPos.x + worldLocalX,
      y: shipPos.y + worldLocalY,
      z: shipPos.z + worldLocalZ,
    };

    // Generate cell-shaped geometry for the preview
    const s = BOAT_CELL_WORLD_SIZE / 2;
    const cx = 0, cy = 0, cz = 0; // centered at origin, entityPos handles offset
    const cellType = preview.cellType;

    const holoVerts = this.holoVertsBuf;
    const holoIndices = this.holoIdxBuf;
    holoVerts.length = 0;
    holoIndices.length = 0;
    const baseVi = 0;

    if (cellType === 255) {
      // Delete mode: red X
      this.genDeleteXCell(cx, cy, cz, s, holoVerts, holoIndices, baseVi);
    } else {
      // Build mode: use FBX mesh for BED, otherwise unified 2D extrusion
      const bedSize = { sizeX: 1, sizeY: 1, sizeZ: 2 };
      const dummyCell: CellInfo = {
        type: cellType,
        rotation: preview.rotation ?? 0,
        gridX: 0, gridY: 0, gridZ: 0,
        sizeX: cellType === BoatCellType.BED ? bedSize.sizeX : 1,
        sizeY: cellType === BoatCellType.BED ? bedSize.sizeY : 1,
        sizeZ: cellType === BoatCellType.BED ? bedSize.sizeZ : 1,
      };
      if (cellType === BoatCellType.BED && this.bedMeshVertCount > 0) {
        this.generateFBXCellMesh(dummyCell, this.holoEmptyCellMap, this.bedMeshVerts, this.bedMeshIdx, holoVerts, holoIndices, baseVi);
      } else {
        this.generateCellMesh(dummyCell, this.holoEmptyCellMap, holoVerts, holoIndices, baseVi);
      }
    }

    // Ensure holo buffers are large enough (auto-resizes if FBX model exceeds capacity)
    const neededVerts = holoVerts.length / 9;
    const neededIndices = holoIndices.length;
    if (!this.ensureHoloCapacity(neededVerts, neededIndices)) {
      console.warn("[Holo] Failed to allocate holo buffers, skipping preview");
      return;
    }
    const vertData = new Float32Array(holoVerts);
    this.device.queue.writeBuffer(this.holoVertices, 0, vertData);

    // Upload index data
    const idxData = new Uint16Array(holoIndices);
    this.device.queue.writeBuffer(this.holoIndices, 0, idxData);
    const indexCount = holoIndices.length;

    // Use a uniform slot at the end of the buffer
    const holoIdx = 511; // last slot
    const offset = holoIdx * 256;
    const uniforms = this.reusableUniforms;
    for (let i = 0; i < 16; i++) uniforms[i] = this.viewProjCache[i];
    uniforms[16] = this.cameraPosCache[0];
    uniforms[17] = this.cameraPosCache[1];
    uniforms[18] = this.cameraPosCache[2];
    uniforms[19] = performance.now() / 1000;
    uniforms[20] = holoPos.x;
    uniforms[21] = holoPos.y;
    uniforms[22] = holoPos.z;
    uniforms[23] = 1; // scale = 1 (geometry already in world units)
    uniforms[24] = shipRot.x; // rotate ghost to match ship orientation
    uniforms[25] = shipRot.y;
    uniforms[26] = shipRot.z;
    uniforms[27] = shipRot.w;
    const holoDv = new DataView(uniforms.buffer);
    holoDv.setUint32(112, 0, true); // entityType
    // Lighting params (same layout as entity uniforms)
    const lp = this.lightingParamsCache;
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
    this.device.queue.writeBuffer(this.uniformBuffer, offset, uniforms);

    passEncoder.setPipeline(this.holoPipeline);
    passEncoder.setBindGroup(0, this.bindGroup, [holoIdx * 256]);
    passEncoder.setVertexBuffer(0, this.holoVertices);
    passEncoder.setIndexBuffer(this.holoIndices, "uint16");
    passEncoder.drawIndexed(indexCount);
  }

  // Render anchor 3D mesh and chain for all anchored ships.
  // Uses proper lit geometry with depthCompare: always (visible through water/terrain).
  renderAnchors(passEncoder: GPURenderPassEncoder, simReader: SimBufferReader): void {
    if (!this.anchorPipeline3D || !this.bindGroup || !this.uniformBuffer || !this.anchorMeshVerts || !this.anchorMeshIdx || !this.chainLinkVerts || !this.chainLinkIdx || !this.viewProjCache) return;
    if (!simReader.isValid()) return;

    const entityCount = simReader.getEntityCount();
    const segments = EntityRenderer.ROPE_SEGMENTS;
    let uniformSlot = EntityRenderer.MAX_DRAW_ENTITIES - 1;
    const maxSlot = 450;

    interface DrawCmd { slot: number; pos: { x: number; y: number; z: number }; scale: number; rot: { x: number; y: number; z: number; w: number }; mesh: "anchor" | "chain" }
    const drawList: DrawCmd[] = [];

    for (let i = 0; i < entityCount; i++) {
      const entSlot = simReader.getEntitySlot(i);
      if (!entSlot) continue;
      const type = entSlot.u32[ENT.TYPE];
      if (type !== EntityType.Ship && type !== EntityType.SmallCraft) continue;

      const ax = entSlot.f32[ENT.DATA + 8];
      const az = entSlot.f32[ENT.DATA + 9];
      if (!Number.isFinite(ax) || !Number.isFinite(az)) continue;

      const sx = entSlot.f32[ENT.POS_X];
      const sy = entSlot.f32[ENT.POS_Y];
      const sz = entSlot.f32[ENT.POS_Z];
      const heading = entSlot.f32[ENT.DATA + 3] ?? 0;
      const bowX = sx + (-Math.sin(heading)) * ANCHOR_BOW_OFFSET;
      const bowZ = sz + (-Math.cos(heading)) * ANCHOR_BOW_OFFSET;
      const bowY = sy + 1.0;
      const anchorY = ANCHOR_DEPTH;

      // Anchor mesh (identity rotation, scale 1.5)
      if (uniformSlot < maxSlot) break;
      drawList.push({ slot: uniformSlot, pos: { x: ax, y: anchorY, z: az }, scale: 1.5, rot: { x: 0, y: 0, z: 0, w: 1 }, mesh: "anchor" });
      uniformSlot--;

      // Chain segments along catenary curve
      const dx = ax - bowX;
      const dz = az - bowZ;
      const vertDist = anchorY - bowY;
      const straightDist = Math.sqrt(dx * dx + dz * dz + vertDist * vertDist);
      const sag = Math.max(0, (straightDist * 1.3 - straightDist) * 0.5);

      const chainStep = Math.max(1, Math.floor(segments / 8));
      let prevPx = bowX, prevPy = bowY, prevPz = bowZ;
      for (let s = chainStep; s <= segments; s += chainStep) {
        if (uniformSlot < maxSlot) break;
        const t = s / segments;
        const px = bowX + dx * t;
        const catenary = 4 * sag * t * (1 - t);
        const py = bowY + vertDist * t - catenary;
        const pz = bowZ + dz * t;

        // Direction from previous to current point
        const ddx = px - prevPx, ddy = py - prevPy, ddz = pz - prevPz;
        const dlen = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz) || 1;
        const dirx = ddx / dlen, diry = ddy / dlen, dirz = ddz / dlen;

        // Quaternion to rotate Y-axis (0,1,0) to direction (dirx,diry,dirz)
        // axis = cross(Y, dir) = (-dirz, 0, dirx), angle = acos(diry)
        const ax2 = -dirz, ay2 = 0, az2 = dirx;
        const axisLen = Math.sqrt(ax2 * ax2 + az2 * az2);
        let qx, qy, qz, qw;
        if (axisLen < 0.001) {
          // Parallel or anti-parallel to Y
          if (diry > 0) { qx = 0; qy = 0; qz = 0; qw = 1; }
          else { qx = 1; qy = 0; qz = 0; qw = 0; }
        } else {
          const angle = Math.acos(Math.max(-1, Math.min(1, diry)));
          const halfAngle = angle / 2;
          const s2 = Math.sin(halfAngle);
          qx = (ax2 / axisLen) * s2;
          qy = (ay2 / axisLen) * s2;
          qz = (az2 / axisLen) * s2;
          qw = Math.cos(halfAngle);
        }

        drawList.push({ slot: uniformSlot, pos: { x: (px + prevPx) / 2, y: (py + prevPy) / 2, z: (pz + prevPz) / 2 }, scale: 1.0, rot: { x: qx, y: qy, z: qz, w: qw }, mesh: "chain" });
        uniformSlot--;

        prevPx = px; prevPy = py; prevPz = pz;
      }
    }

    if (drawList.length === 0) return;

    // Write all uniforms first
    for (const d of drawList) {
      this.writeAnchorUniform(d.slot, d.pos, d.scale, d.rot);
    }

    // Encode draws — anchor and chain use different meshes
    passEncoder.setPipeline(this.anchorPipeline3D!);
    if (this.lightBindGroup) {
      passEncoder.setBindGroup(1, this.lightBindGroup);
    }
    if (this.pbrBindGroup) {
      passEncoder.setBindGroup(2, this.pbrBindGroup);
    }
    for (const d of drawList) {
      if (d.mesh === "anchor") {
        passEncoder.setVertexBuffer(0, this.anchorMeshVerts!);
        passEncoder.setIndexBuffer(this.anchorMeshIdx!, "uint16");
        passEncoder.setBindGroup(0, this.bindGroup, [d.slot * 256]);
        passEncoder.drawIndexed(this.anchorMeshIndexCount);
      } else {
        passEncoder.setVertexBuffer(0, this.chainLinkVerts!);
        passEncoder.setIndexBuffer(this.chainLinkIdx!, "uint16");
        passEncoder.setBindGroup(0, this.bindGroup, [d.slot * 256]);
        passEncoder.drawIndexed(this.chainLinkIndexCount);
      }
    }
  }

  // Write entity uniform for anchor rendering (uses boat pipeline uniform layout)
  private writeAnchorUniform(idx: number, pos: { x: number; y: number; z: number }, scale: number, rot: { x: number; y: number; z: number; w: number }): void {
    if (!this.uniformBuffer || !this.viewProjCache) return;

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
    uniforms[24] = rot.x;
    uniforms[25] = rot.y;
    uniforms[26] = rot.z;
    uniforms[27] = rot.w;
    const dv = new DataView(uniforms.buffer);
    dv.setUint32(112, EntityType.Ship, true);

    const lp = this.lightingParamsCache;
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

    this.device.queue.writeBuffer(this.uniformBuffer, idx * 256, uniforms);
  }
}
