// ============================================================================
// BlockGridPass3D — renders blocks as 3D cubes with perspective projection.
//
// Uses instanced rendering: one cube geometry, many instances.
// Per-instance: world position, block ID, face visibility mask, light level.
// Background blocks at Z=-1, foreground at Z=0 (true 2.5D depth layering).
// ============================================================================

import { DEPTH_FORMAT } from "@downdraft/core";

import BLOCK_RENDER_3D_FS from "../shaders/block-render-3d.wgsl?raw";
import { getBlockPalette } from "../shared/block-registry";
import {
    ACTIVE_GRID_CELLS, ACTIVE_GRID_H, ACTIVE_GRID_W
} from "../shared/constants";
import { CROP_LOOKUP } from "../shared/crops";
import {
    PADDED_EXPLORED_ROW_BYTES,
    PADDED_GRID_ROW_BYTES,
    PADDED_LIGHT_ROW_BYTES,
    RenderBufferReader,
} from "../shared/render-buffer";
import { isTreeBlock } from "../shared/tree-species";
import { lookAtIP, multiplyIP, perspectiveIP, type Mat4 } from "./matrix";

// --- Cube geometry ---
// 6 faces × 4 vertices = 24 vertices. Each vertex: localPos(3) + normal(3) + faceId(1) = 7 floats.
const CUBE_VERTICES = new Float32Array([
  // Face 0: +X (right) — normal (1, 0, 0)
  1, 0, 0,  1, 0, 0,  0,
  1, 1, 0,  1, 0, 0,  0,
  1, 1, 1,  1, 0, 0,  0,
  1, 0, 1,  1, 0, 0,  0,
  // Face 1: -X (left) — normal (-1, 0, 0)
  0, 0, 1,  -1, 0, 0,  1,
  0, 1, 1,  -1, 0, 0,  1,
  0, 1, 0,  -1, 0, 0,  1,
  0, 0, 0,  -1, 0, 0,  1,
  // Face 2: +Y (bottom) — normal (0, 1, 0)
  0, 1, 0,  0, 1, 0,  2,
  1, 1, 0,  0, 1, 0,  2,
  1, 1, 1,  0, 1, 0,  2,
  0, 1, 1,  0, 1, 0,  2,
  // Face 3: -Y (top) — normal (0, -1, 0)
  0, 0, 1,  0, -1, 0,  3,
  1, 0, 1,  0, -1, 0,  3,
  1, 0, 0,  0, -1, 0,  3,
  0, 0, 0,  0, -1, 0,  3,
  // Face 4: +Z (front) — normal (0, 0, 1)
  0, 0, 1,  0, 0, 1,  4,
  1, 0, 1,  0, 0, 1,  4,
  1, 1, 1,  0, 0, 1,  4,
  0, 1, 1,  0, 0, 1,  4,
  // Face 5: -Z (back) — normal (0, 0, -1)
  1, 0, 0,  0, 0, -1,  5,
  0, 0, 0,  0, 0, -1,  5,
  0, 1, 0,  0, 0, -1,  5,
  1, 1, 0,  0, 0, -1,  5,
]);

const CUBE_INDICES = new Uint16Array([
  // Face 0: +X
  0, 1, 2,  0, 2, 3,
  // Face 1: -X
  4, 5, 6,  4, 6, 7,
  // Face 2: +Y
  8, 9, 10,  8, 10, 11,
  // Face 3: -Y
  12, 13, 14,  12, 14, 15,
  // Face 4: +Z
  16, 17, 18,  16, 18, 19,
  // Face 5: -Z
  20, 21, 22,  20, 22, 23,
]);

const VERT_STRIDE = 7 * 4; // 7 floats per vertex
const INSTANCE_STRIDE = 5 * 4; // 5 floats per instance (vec3 pos + vec2 data)

// Face mask bits (must match shader)
const FACE_RIGHT  = 1 << 0; // +X
const FACE_LEFT   = 1 << 1; // -X
const FACE_BOTTOM = 1 << 2; // +Y
const FACE_TOP    = 1 << 3; // -Y
const FACE_FRONT  = 1 << 4; // +Z
const FACE_BACK   = 1 << 5; // -Z

/** A foreground neighbor is "transparent" for face-culling purposes if it's
 *  air OR a crop/wild forageable block (bushes, mushrooms, ...). Those are
 *  rendered as 2D sprites by CropSpritePass, not 3D cubes, so a solid block
 *  adjacent to one must show its face — otherwise the bush leaves a visual
 *  hole in the terrain surface that interrupts the light gradient. */
const isAirOrCrop = (id: number): boolean => id === 0 || CROP_LOOKUP[id] !== 0;

// Depth layering: 4-layer system.
//   Layer 1 (Z= 0): foreground front  ← closest to camera
//   Layer 2 (Z=-1): foreground back   ← player walks here
//   Layer 3 (Z=-2): background (trees + terrain) ← behind player
//   Layer 4 (Z=-3): back wall (deep background)   ← farthest
const FG_Z_LAYERS = [0, -1];
const BG_Z_LAYERS = [-2, -3];
const NUM_FG_LAYERS = FG_Z_LAYERS.length;
const NUM_BG_LAYERS = BG_Z_LAYERS.length;

export class BlockGridPass3D {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private depthFormat: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private bgPipeline: GPURenderPipeline | null = null; // background: depth-tested cubes
  private waterPipeline: GPURenderPipeline | null = null; // water: alpha-blended, no depth-write
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  private cubeVertexBuffer: GPUBuffer | null = null;
  private cubeIndexBuffer: GPUBuffer | null = null;
  private instanceBuffer: GPUBuffer | null = null;
  private paletteTexture: GPUTexture | null = null;
  private paletteView: GPUTextureView | null = null;
  private lightTexture: GPUTexture | null = null;
  private lightView: GPUTextureView | null = null;
  private exploredTexture: GPUTexture | null = null;
  private exploredView: GPUTextureView | null = null;
  // Grid textures: block IDs uploaded as r8unorm so the shader can sample
  // neighbor IDs directly (avoids computing them per-cell in JS).
  private fgGridTexture: GPUTexture | null = null;
  private fgGridView: GPUTextureView | null = null;
  private bgGridTexture: GPUTexture | null = null;
  private bgGridView: GPUTextureView | null = null;
  private depthTexture: GPUTexture | null = null;

  gridW: number;
  gridH: number;

  // Scratch instance data (rebuilt each frame)
  private instanceData: Float32Array;
  private fgInstanceCount = 0;  // foreground instances (depth-tested)
  private bgWallInstanceCount = 0;  // back wall instances (Z=-3, drawn first)
  private bgTreeInstanceCount = 0;  // tree instances (Z=-2, drawn after back wall)
  private bgInstanceCount = 0;  // total background (back wall + trees)
  private waterInstanceCount = 0; // water instances (transparent, drawn after characters)
  private instanceCount = 0;    // total (for buffer sizing)

  // Scratch light/explored upload buffers (padded to 256-byte rows)
  // Light is RGBA8 (4 bytes/pixel); explored is R8 (1 byte/pixel).
  private paddedLight: Uint8Array;
  private paddedExplored: Uint8Array;
  private paddedLightRowBytes: number; // bytes per row for RGBA8 light (256-aligned)
  private paddedExploredRowBytes: number; // bytes per row for R8 explored (256-aligned)
  // Scratch grid upload buffers (block IDs as R8, padded to 256-byte rows)
  private paddedFgGrid: Uint8Array;
  private paddedBgGrid: Uint8Array;
  private paddedGridRowBytes: number; // bytes per row for R8 grid (256-aligned)

  // Cached view-projection matrix
  private viewProj: Mat4 = new Float32Array(16);
  // Preallocated scratch matrices (avoid per-frame allocation in updateCamera)
  private _projScratch: Mat4 = new Float32Array(16);
  private _viewScratch: Mat4 = new Float32Array(16);
  // Preallocated camera uniform buffer (32 floats = 128 bytes)
  private _cameraUniform: Float32Array<ArrayBuffer> = new Float32Array(32);

  // Debug: when true, disable fog-of-war + shadow darkening (F1).
  // The light texture is cleared to full white and the explored texture
  // to full white, so the shader renders everything fully lit with no fog.
  private debugNoShadows = false;

  // Tracked depth texture size
  private depthW = 0;
  private depthH = 0;

  constructor(device: GPUDevice, format: GPUTextureFormat, depthFormat: GPUTextureFormat = DEPTH_FORMAT) {
    this.device = device;
    this.format = format;
    this.depthFormat = depthFormat;
    this.gridW = ACTIVE_GRID_W;
    this.gridH = ACTIVE_GRID_H;
    // Max instances = all cells (fg double-rendered + bg double-rendered).
    this.instanceData = new Float32Array(ACTIVE_GRID_CELLS * (NUM_FG_LAYERS + NUM_BG_LAYERS) * 5);
    // Light: RGBA8 (4 bytes/pixel) → bytesPerRow must be multiple of 256.
    this.paddedLightRowBytes = Math.ceil((ACTIVE_GRID_W * 4) / 256) * 256;
    // Explored: R8 (1 byte/pixel) → bytesPerRow must be multiple of 256.
    this.paddedExploredRowBytes = Math.ceil(ACTIVE_GRID_W / 256) * 256;
    this.paddedLight = new Uint8Array(this.paddedLightRowBytes * ACTIVE_GRID_H);
    this.paddedExplored = new Uint8Array(this.paddedExploredRowBytes * ACTIVE_GRID_H);
    // Grid textures: R8 (1 byte/pixel), same alignment as explored.
    this.paddedGridRowBytes = this.paddedExploredRowBytes;
    this.paddedFgGrid = new Uint8Array(this.paddedGridRowBytes * ACTIVE_GRID_H);
    this.paddedBgGrid = new Uint8Array(this.paddedGridRowBytes * ACTIVE_GRID_H);
  }

  init(): void {
    // Camera uniform buffer (viewProj matrix + camera params)
    // 16 floats for matrix + 12 floats for params + originX + originY + pad = 31 floats
    // Pad to 128 bytes (multiple of 16)
    this.cameraBuffer = this.device.createBuffer({
      size: 128,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Cube vertex buffer
    this.cubeVertexBuffer = this.device.createBuffer({
      size: CUBE_VERTICES.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.cubeVertexBuffer, 0, CUBE_VERTICES.buffer as BufferSource);

    // Cube index buffer
    this.cubeIndexBuffer = this.device.createBuffer({
      size: CUBE_INDICES.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.cubeIndexBuffer, 0, CUBE_INDICES.buffer as BufferSource);

    // Instance buffer (large enough for all possible instances)
    this.instanceBuffer = this.device.createBuffer({
      size: this.instanceData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    this.createTextures();

    // Palette texture: 256 blocks × 1 pixel RGBA
    const palette = getBlockPalette();
    this.paletteTexture = this.device.createTexture({
      size: [256, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.paletteView = this.paletteTexture.createView();
    this.device.queue.writeTexture(
      { texture: this.paletteTexture },
      palette as unknown as BufferSource,
      { bytesPerRow: 256 * 4, rowsPerImage: 1 },
      [256, 1],
    );

    // Bind group layout
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }, // camera
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }, // palette
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }, // light
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }, // explored
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }, // fgGrid
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }, // bgGrid
      ],
    });

    const shader = this.device.createShaderModule({ code: BLOCK_RENDER_3D_FS });
    const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });

    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shader,
        entryPoint: "vs_main",
        buffers: [
          {
            // Cube geometry
            arrayStride: VERT_STRIDE,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },  // localPos
              { shaderLocation: 1, offset: 12, format: "float32x3" }, // normal
              { shaderLocation: 2, offset: 24, format: "float32" },   // faceId
            ],
          },
          {
            // Instance data
            arrayStride: INSTANCE_STRIDE,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 3, offset: 0, format: "float32x3" },  // instancePos
              { shaderLocation: 4, offset: 12, format: "float32x2" }, // instanceData (blockId, faceMask)
            ],
          },
        ],
      },
      fragment: {
        module: shader,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "none", // face mask handles culling
      },
      depthStencil: {
        format: this.depthFormat,
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

    // Background pipeline: no depth test — always render.
    // The background is painted first (back wall, then trees), then the
    // foreground is drawn on top with depth testing. This ensures the
    // back wall is always visible behind the foreground (like a wallpaper),
    // which is the standard 2.5D approach. Without this, the back wall at
    // Z=-3 would be almost completely occluded by foreground blocks at Z=0
    // due to the 20° pitch angle leaving only a tiny perspective gap.
    this.bgPipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shader,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: VERT_STRIDE,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x3" },
              { shaderLocation: 2, offset: 24, format: "float32" },
            ],
          },
          {
            arrayStride: INSTANCE_STRIDE,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 3, offset: 0, format: "float32x3" },
              { shaderLocation: 4, offset: 12, format: "float32x2" },
            ],
          },
        ],
      },
      fragment: {
        module: shader,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "none",
      },
      depthStencil: {
        format: this.depthFormat,
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

    // Water pipeline: alpha-blended, depth-tested but NO depth-write.
    // Water is rendered after the character pass so the player stays visible
    // behind water. Disabling depth-write prevents water from occluding
    // characters/objects drawn before it; depth-test still keeps water behind
    // opaque terrain that's closer to the camera.
    this.waterPipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shader,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: VERT_STRIDE,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x3" },
              { shaderLocation: 2, offset: 24, format: "float32" },
            ],
          },
          {
            arrayStride: INSTANCE_STRIDE,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 3, offset: 0, format: "float32x3" },
              { shaderLocation: 4, offset: 12, format: "float32x2" },
            ],
          },
        ],
      },
      fragment: {
        module: shader,
        entryPoint: "fs_main",
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "none",
      },
      depthStencil: {
        format: this.depthFormat,
        depthWriteEnabled: false,
        depthCompare: "less",
      },
    });

    this.createBindGroup();
  }

  private createTextures(): void {
    // Light texture (rgba8unorm — RGB light color + A pad)
    this.lightTexture = this.device.createTexture({
      size: [this.gridW, this.gridH],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.lightView = this.lightTexture.createView();

    // Explored texture (r8unorm)
    this.exploredTexture = this.device.createTexture({
      size: [this.gridW, this.gridH],
      format: "r8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.exploredView = this.exploredTexture.createView();

    // Grid textures: block IDs as r8unorm (shader samples neighbors directly)
    this.fgGridTexture = this.device.createTexture({
      size: [this.gridW, this.gridH],
      format: "r8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.fgGridView = this.fgGridTexture.createView();

    this.bgGridTexture = this.device.createTexture({
      size: [this.gridW, this.gridH],
      format: "r8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.bgGridView = this.bgGridTexture.createView();
  }

  private createBindGroup(): void {
    if (!this.bindGroupLayout || !this.cameraBuffer || !this.paletteView ||
        !this.lightView || !this.exploredView || !this.fgGridView || !this.bgGridView) return;
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: this.paletteView },
        { binding: 2, resource: this.lightView },
        { binding: 3, resource: this.exploredView },
        { binding: 4, resource: this.fgGridView },
        { binding: 5, resource: this.bgGridView },
      ],
    });
  }

  /** Ensure depth texture matches canvas size. Call after resize. */
  ensureDepthTexture(canvasW: number, canvasH: number): void {
    if (this.depthTexture && this.depthW === canvasW && this.depthH === canvasH) return;
    this.depthTexture?.destroy();
    this.depthTexture = this.device.createTexture({
      size: [canvasW, canvasH],
      format: this.depthFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthW = canvasW;
    this.depthH = canvasH;
  }

  getDepthTextureView(): GPUTextureView | null {
    return this.depthTexture?.createView() ?? null;
  }

  /** Expose the volumetric light texture view so other passes (e.g. crop
   *  sprites) can sample the same per-cell lighting as the block grid. */
  getLightView(): GPUTextureView | null {
    return this.lightView;
  }

  /** Expose the fog-of-war (explored) texture view so other passes can apply
   *  the same unexplored-cell black-out as the block grid. */
  getExploredView(): GPUTextureView | null {
    return this.exploredView;
  }

  /** Get the current view-projection matrix (computed in updateCamera). */
  getViewProj(): Mat4 {
    return this.viewProj;
  }

  /** Build instance data from the grid. Called each sim tick (30Hz).
   *  Optional camera params enable view culling (only build instances for
   *  the visible rectangle). When omitted, the full grid is built. */
  updateGrid(
    foreground: Uint16Array,
    background: Uint16Array,
    camX = 0, camY = 0, camZoom = 0, camCW = 0, camCH = 0,
  ): void {
    let idx = 0;
    const data = this.instanceData;
    const W = this.gridW;
    const H = this.gridH;

    // View culling bounds (full grid if camera info not provided).
    let xMin = 0, xMax = W, yMin = 0, yMax = H;
    if (camZoom > 0 && camCW > 0 && camCH > 0) {
      const CULL_MARGIN = 8;
      const visW = camCW / camZoom;
      const visH = camCH / camZoom;
      xMin = Math.max(0, Math.floor(camX - visW * 0.5 - CULL_MARGIN));
      xMax = Math.min(W, Math.ceil(camX + visW * 0.5 + CULL_MARGIN));
      yMin = Math.max(0, Math.floor(camY - visH * 0.5 - CULL_MARGIN));
      yMax = Math.min(H, Math.ceil(camY + visH * 0.5 + CULL_MARGIN));
    }

    // Upload block IDs as textures so the shader can sample neighbor IDs
    // directly (avoids 4 per-cell neighbor lookups in JS).
    this.uploadGridTextures(foreground, background);

    // --- Foreground blocks (rendered at 2 Z depths: Z=0 and Z=-1) ---
    // Layer 1 (Z=0): front face visible. Layer 2 (Z=-1): back face visible.
    // Both layers show top/bottom/side faces based on neighbors.
    for (let layer = 0; layer < NUM_FG_LAYERS; layer++) {
      const layerZ = FG_Z_LAYERS[layer];
      for (let y = yMin; y < yMax; y++) {
        for (let x = xMin; x < xMax; x++) {
          const cellIdx = y * W + x;
          const packedFg = foreground[cellIdx];
          const blockId = packedFg & 0xFF;
          if (blockId === 0) continue;
          // Crop + wild forageable blocks are rendered as 2D sprites by
          // CropSpritePass, not as 3D cubes here.
          if (CROP_LOOKUP[blockId] !== 0) continue;
          // Water is rendered in a separate transparent pass (after characters)
          // so the player stays visible behind it. Skip it here to avoid
          // double-rendering in the opaque pass.
          if (blockId === BLOCK_WATER) continue;

          let faceMask = 0;
          if (x >= W - 1 || isAirOrCrop(foreground[y * W + (x + 1)] & 0xFF)) faceMask |= FACE_RIGHT;
          if (x <= 0 || isAirOrCrop(foreground[y * W + (x - 1)] & 0xFF)) faceMask |= FACE_LEFT;
          if (y >= H - 1 || isAirOrCrop(foreground[(y + 1) * W + x] & 0xFF)) faceMask |= FACE_BOTTOM;
          if (y <= 0 || isAirOrCrop(foreground[(y - 1) * W + x] & 0xFF)) faceMask |= FACE_TOP;

          if (layer === 0) {
            // Front layer (Z=0): show front face (facing camera)
            faceMask |= FACE_FRONT;
          } else {
            // Back layer (Z=-1): show back face (facing away from camera, into the world)
            // Only show back face if there's no background block behind it
            if ((background[cellIdx] & 0xFF) === 0) faceMask |= FACE_BACK;
            // Also show front face for the back layer (so you see the interior)
            faceMask |= FACE_FRONT;
          }

          data[idx * 5 + 0] = x;
          data[idx * 5 + 1] = y;
          data[idx * 5 + 2] = layerZ;
          data[idx * 5 + 3] = blockId;
          data[idx * 5 + 4] = faceMask;
          idx++;
        }
      }
    }
    this.fgInstanceCount = idx;

    // --- Background blocks ---
    // Layer 4 (Z=-3): back wall — all background blocks EXCEPT trees.
    // Layer 3 (Z=-2): main background — all background blocks (trees + terrain).
    // Render deepest first (layer 4) so painter's algorithm stacks correctly.

    // Layer 4: back wall (terrain only, no trees) at Z=-3
    for (let y = yMin; y < yMax; y++) {
      for (let x = xMin; x < xMax; x++) {
        const cellIdx = y * W + x;
        const packedBg = background[cellIdx];
        const blockId = packedBg & 0xFF;
        if (blockId === 0) continue;
        if (isTreeBlock(blockId)) continue;

        let faceMask = 0;
        faceMask |= FACE_FRONT;
        // Only cull faces against other layer-4 blocks (non-tree background).
        // Trees are in layer 3 (Z=-2), not layer 4 (Z=-3), so they don't occlude
        // back wall faces — depth testing handles inter-layer occlusion.
        const isWall = (v: number) => v !== 0 && !isTreeBlock(v);
        if (y <= 0 || !isWall(background[(y - 1) * W + x] & 0xFF)) faceMask |= FACE_TOP;
        if (y >= H - 1 || !isWall(background[(y + 1) * W + x] & 0xFF)) faceMask |= FACE_BOTTOM;
        if (x >= W - 1 || !isWall(background[y * W + (x + 1)] & 0xFF)) faceMask |= FACE_RIGHT;
        if (x <= 0 || !isWall(background[y * W + (x - 1)] & 0xFF)) faceMask |= FACE_LEFT;

        data[idx * 5 + 0] = x;
        data[idx * 5 + 1] = y;
        data[idx * 5 + 2] = BG_Z_LAYERS[1]; // Z=-3 (layer 4)
        data[idx * 5 + 3] = blockId;
        data[idx * 5 + 4] = faceMask;
        idx++;
      }
    }
    this.bgWallInstanceCount = idx - this.fgInstanceCount;

    // Layer 3: all background blocks (trees + terrain) at Z=-2
    for (let y = yMin; y < yMax; y++) {
      for (let x = xMin; x < xMax; x++) {
        const cellIdx = y * W + x;
        const packedBg = background[cellIdx];
        const blockId = packedBg & 0xFF;
        if (blockId === 0) continue;

        let faceMask = 0;
        faceMask |= FACE_FRONT;
        const isSolid = (v: number) => v !== 0;
        if (y <= 0 || !isSolid(background[(y - 1) * W + x] & 0xFF)) faceMask |= FACE_TOP;
        if (y >= H - 1 || !isSolid(background[(y + 1) * W + x] & 0xFF)) faceMask |= FACE_BOTTOM;
        if (x >= W - 1 || !isSolid(background[y * W + (x + 1)] & 0xFF)) faceMask |= FACE_RIGHT;
        if (x <= 0 || !isSolid(background[y * W + (x - 1)] & 0xFF)) faceMask |= FACE_LEFT;

        data[idx * 5 + 0] = x;
        data[idx * 5 + 1] = y;
        data[idx * 5 + 2] = BG_Z_LAYERS[0]; // Z=-2 (layer 3)
        data[idx * 5 + 3] = blockId;
        data[idx * 5 + 4] = faceMask;
        idx++;
      }
    }
    this.bgTreeInstanceCount = idx - this.fgInstanceCount - this.bgWallInstanceCount;
    this.bgInstanceCount = idx - this.fgInstanceCount;

    // --- Water (transparent) instances — rendered separately after characters ---
    // Water is excluded from the fg loop above so it's not double-rendered in
    // the opaque pass. Here we build water-only instances at the end of the
    // instance data, using the same 2-layer (Z=0, Z=-1) scheme as fg blocks.
    for (let layer = 0; layer < NUM_FG_LAYERS; layer++) {
      const layerZ = FG_Z_LAYERS[layer];
      for (let y = yMin; y < yMax; y++) {
        for (let x = xMin; x < xMax; x++) {
          const cellIdx = y * W + x;
          const packedFg = foreground[cellIdx];
          const blockId = packedFg & 0xFF;
          if (blockId !== BLOCK_WATER) continue;

          let faceMask = 0;
          if (x >= W - 1 || isAirOrCrop(foreground[y * W + (x + 1)] & 0xFF)) faceMask |= FACE_RIGHT;
          if (x <= 0 || isAirOrCrop(foreground[y * W + (x - 1)] & 0xFF)) faceMask |= FACE_LEFT;
          if (y >= H - 1 || isAirOrCrop(foreground[(y + 1) * W + x] & 0xFF)) faceMask |= FACE_BOTTOM;
          if (y <= 0 || isAirOrCrop(foreground[(y - 1) * W + x] & 0xFF)) faceMask |= FACE_TOP;

          if (layer === 0) {
            faceMask |= FACE_FRONT;
          } else {
            if ((background[cellIdx] & 0xFF) === 0) faceMask |= FACE_BACK;
            faceMask |= FACE_FRONT;
          }

          data[idx * 5 + 0] = x;
          data[idx * 5 + 1] = y;
          data[idx * 5 + 2] = layerZ;
          data[idx * 5 + 3] = blockId;
          data[idx * 5 + 4] = faceMask;
          idx++;
        }
      }
    }
    this.waterInstanceCount = idx - this.fgInstanceCount - this.bgInstanceCount;
    this.instanceCount = idx;

    // Upload instance data
    if (idx > 0) {
      this.device.queue.writeBuffer(
        this.instanceBuffer!, 0,
        data.buffer as BufferSource,
        0,
        idx * 5 * 4, // only upload used portion
      );
    }
  }

  /**
   * Upload pre-built instance data + padded textures from the render SAB.
   * This is the worker-accelerated path: the grid-builder worker has already
   * done the O(W×H) instance building + texture padding off the main thread.
   * The main thread only does GPU uploads (writeBuffer + writeTexture) — no
   * JS loops.
   */
  updateGridFromBuffer(reader: RenderBufferReader): void {
    const fgCount = reader.getFgCount();
    const bgWallCount = reader.getBgWallCount();
    const bgTreeCount = reader.getBgTreeCount();
    const waterCount = reader.getWaterCount();
    const totalCount = reader.getTotalCount();

    this.fgInstanceCount = fgCount;
    this.bgWallInstanceCount = bgWallCount;
    this.bgTreeInstanceCount = bgTreeCount;
    this.bgInstanceCount = bgWallCount + bgTreeCount;
    this.waterInstanceCount = waterCount;
    this.instanceCount = totalCount;

    // Upload instance data (only the used portion).
    // NOTE: reader.instanceData is a view into the render SAB, so we must
    // pass byteOffset as the source offset — not 0 (which would read the
    // SAB header instead of the instance data region).
    if (totalCount > 0) {
      this.device.queue.writeBuffer(
        this.instanceBuffer!, 0,
        reader.instanceData.buffer as BufferSource,
        reader.instanceData.byteOffset,
        totalCount * 5 * 4,
      );
    }

    // Upload pre-padded grid textures (fg + bg block IDs as R8).
    // Same byteOffset fix: the views are into the render SAB, not standalone.
    this.device.queue.writeTexture(
      { texture: this.fgGridTexture! },
      reader.paddedFgGrid.buffer as BufferSource,
      { offset: reader.paddedFgGrid.byteOffset, bytesPerRow: PADDED_GRID_ROW_BYTES, rowsPerImage: this.gridH },
      [this.gridW, this.gridH],
    );
    this.device.queue.writeTexture(
      { texture: this.bgGridTexture! },
      reader.paddedBgGrid.buffer as BufferSource,
      { offset: reader.paddedBgGrid.byteOffset, bytesPerRow: PADDED_GRID_ROW_BYTES, rowsPerImage: this.gridH },
      [this.gridW, this.gridH],
    );
  }

  /**
   * Upload pre-padded light texture from the render SAB.
   * Worker-accelerated: no row-by-row padding loop on the main thread.
   */
  updateLightFromBuffer(reader: RenderBufferReader): void {
    if (!this.lightTexture) return;
    if (this.debugNoShadows) {
      this.paddedLight.fill(255);
      this.device.queue.writeTexture(
        { texture: this.lightTexture },
        this.paddedLight.buffer as BufferSource,
        { bytesPerRow: this.paddedLightRowBytes, rowsPerImage: this.gridH },
        [this.gridW, this.gridH],
      );
      return;
    }
    this.device.queue.writeTexture(
      { texture: this.lightTexture },
      reader.paddedLight.buffer as BufferSource,
      { offset: reader.paddedLight.byteOffset, bytesPerRow: PADDED_LIGHT_ROW_BYTES, rowsPerImage: this.gridH },
      [this.gridW, this.gridH],
    );
  }

  /**
   * Upload pre-padded explored texture from the render SAB.
   * Worker-accelerated: no row-by-row padding loop on the main thread.
   */
  updateExploredFromBuffer(reader: RenderBufferReader): void {
    if (!this.exploredTexture) return;
    if (this.debugNoShadows) {
      this.paddedExplored.fill(1);
      this.device.queue.writeTexture(
        { texture: this.exploredTexture },
        this.paddedExplored.buffer as BufferSource,
        { bytesPerRow: this.paddedExploredRowBytes, rowsPerImage: this.gridH },
        [this.gridW, this.gridH],
      );
      return;
    }
    this.device.queue.writeTexture(
      { texture: this.exploredTexture },
      reader.paddedExplored.buffer as BufferSource,
      { offset: reader.paddedExplored.byteOffset, bytesPerRow: PADDED_EXPLORED_ROW_BYTES, rowsPerImage: this.gridH },
      [this.gridW, this.gridH],
    );
  }

  /** Upload fg/bg block IDs as r8unorm textures for shader-side neighbor lookup. */
  private uploadGridTextures(foreground: Uint16Array, background: Uint16Array): void {
    const W = this.gridW;
    const H = this.gridH;
    const rowBytes = this.paddedGridRowBytes;

    // Extract block IDs (low byte) into padded buffers
    for (let y = 0; y < H; y++) {
      const srcOff = y * W;
      const dstOff = y * rowBytes;
      for (let x = 0; x < W; x++) {
        this.paddedFgGrid[dstOff + x] = foreground[srcOff + x] & 0xFF;
        this.paddedBgGrid[dstOff + x] = background[srcOff + x] & 0xFF;
      }
    }

    this.device.queue.writeTexture(
      { texture: this.fgGridTexture! },
      this.paddedFgGrid.buffer as BufferSource,
      { bytesPerRow: rowBytes, rowsPerImage: H },
      [W, H],
    );
    this.device.queue.writeTexture(
      { texture: this.bgGridTexture! },
      this.paddedBgGrid.buffer as BufferSource,
      { bytesPerRow: rowBytes, rowsPerImage: H },
      [W, H],
    );
  }

  /** Debug: get instance counts for diagnostics. */
  getInstanceCounts(): { fg: number; bgWall: number; bgTree: number; water: number; total: number } {
    return {
      fg: this.fgInstanceCount,
      bgWall: this.bgWallInstanceCount,
      bgTree: this.bgTreeInstanceCount,
      water: this.waterInstanceCount,
      total: this.instanceCount,
    };
  }

  /** Enable/disable debug no-shadows mode (F1). When enabled, light + explored
   *  textures are filled with full-white so everything renders fully lit. */
  setDebugNoShadows(enabled: boolean): void {
    this.debugNoShadows = enabled;
  }

  updateLight(grid: Uint8Array): void {
    if (!this.lightTexture) return;

    if (this.debugNoShadows) {
      // Debug mode: fill light texture with full white (RGBA = 255,255,255,255)
      this.paddedLight.fill(255);
      this.device.queue.writeTexture(
        { texture: this.lightTexture },
        this.paddedLight.buffer as BufferSource,
        { bytesPerRow: this.paddedLightRowBytes, rowsPerImage: this.gridH },
        [this.gridW, this.gridH],
      );
      return;
    }

    // Copy RGBA8 rows into padded buffer (bytesPerRow must be 256-aligned).
    // grid is RGBA8: 4 bytes/cell, row length = gridW * 4.
    const srcRowBytes = this.gridW * 4;
    for (let y = 0; y < this.gridH; y++) {
      this.paddedLight.set(
        grid.subarray(y * srcRowBytes, (y + 1) * srcRowBytes),
        y * this.paddedLightRowBytes,
      );
    }
    this.device.queue.writeTexture(
      { texture: this.lightTexture },
      this.paddedLight.buffer as BufferSource,
      { bytesPerRow: this.paddedLightRowBytes, rowsPerImage: this.gridH },
      [this.gridW, this.gridH],
    );
  }

  updateExplored(grid: Uint8Array): void {
    if (!this.exploredTexture) return;

    if (this.debugNoShadows) {
      // Debug mode: fill explored texture with full white (everything visible)
      this.paddedExplored.fill(1);
      this.device.queue.writeTexture(
        { texture: this.exploredTexture },
        this.paddedExplored.buffer as BufferSource,
        { bytesPerRow: this.paddedExploredRowBytes, rowsPerImage: this.gridH },
        [this.gridW, this.gridH],
      );
      return;
    }

    for (let y = 0; y < this.gridH; y++) {
      this.paddedExplored.set(
        grid.subarray(y * this.gridW, (y + 1) * this.gridW),
        y * this.paddedExploredRowBytes,
      );
    }
    this.device.queue.writeTexture(
      { texture: this.exploredTexture },
      this.paddedExplored.buffer as BufferSource,
      { bytesPerRow: this.paddedExploredRowBytes, rowsPerImage: this.gridH },
      [this.gridW, this.gridH],
    );
  }

  /**
   * Update camera uniforms + compute view-projection matrix.
   * The camera is positioned above and in front of the target, at a slight
   * pitch angle, creating the 2.5D perspective view.
   */
  updateCamera(
    camX: number, camY: number, zoom: number,
    canvasW: number, canvasH: number, daylight: number,
    mineX: number = -1, mineY: number = -1, mineDamage: number = 0,
    originX: number = 0, originY: number = 0,
  ): void {
    // Camera pitch angle (radians). 0° = dead-on, facing the block grid straight on.
    const pitchAngle = 0;

    // Camera distance based on zoom: visible_height = 2 * d * tan(fov/2)
    // We want canvasH/zoom cells visible vertically at the target plane.
    const fov = 50 * Math.PI / 180;
    const visibleHeight = canvasH / zoom;
    const distance = (visibleHeight * 0.5) / Math.tan(fov * 0.5);
    const height = distance * Math.sin(pitchAngle);
    const horiz = distance * Math.cos(pitchAngle);

    // Camera position: above (smaller Y, Y goes down) and pulled back in Z.
    // The target is at the blockhead's position; the eye is above and behind.
    const eye: [number, number, number] = [camX, camY - height, horiz];
    const target: [number, number, number] = [camX, camY, 0];
    const up: [number, number, number] = [0, -1, 0]; // world Y goes down, so "up" is -Y

    // Compute view-projection matrix (in-place, no allocation)
    const aspect = canvasW / canvasH;
    const near = 0.1;
    const far = distance * 3 + 100;

    perspectiveIP(this._projScratch, fov, aspect, near, far);
    lookAtIP(this._viewScratch, eye, target, up);
    multiplyIP(this.viewProj, this._projScratch, this._viewScratch);

    // Write camera uniform buffer (reuse preallocated array)
    // Layout: viewProj (16 floats) + camPos (3) + zoom (1) + canvasW (1) + canvasH (1)
    //         + daylight (1) + mineX (1) + mineY (1) + mineDamage (1) + pad (1)
    //         + originX (1) + originY (1) + pad2 (2) = 32 floats = 128 bytes
    const u = this._cameraUniform;
    u.set(this.viewProj, 0);
    u[16] = eye[0];
    u[17] = eye[1];
    u[18] = eye[2];
    u[19] = zoom;
    u[20] = canvasW;
    u[21] = canvasH;
    u[22] = daylight;
    u[23] = mineX;
    u[24] = mineY;
    u[25] = mineDamage;
    u[26] = 0; // pad
    u[27] = originX;
    u[28] = originY;
    u[29] = 0; // pad
    u[30] = 0; // pad
    u[31] = 0; // pad
    this.device.queue.writeBuffer(this.cameraBuffer!, 0, u);
  }

  render(pass: GPURenderPassEncoder): void {
    if (!this.pipeline || !this.bindGroup || !this.cubeVertexBuffer ||
        !this.cubeIndexBuffer || !this.instanceBuffer) return;
    if (this.instanceCount === 0) return;

    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.cubeVertexBuffer);
    pass.setIndexBuffer(this.cubeIndexBuffer, "uint16");

    // 1. Draw layer 4 (Z=-3) — back wall, depth-tested.
    if (this.bgPipeline && this.bgWallInstanceCount > 0) {
      pass.setPipeline(this.bgPipeline);
      pass.setVertexBuffer(1, this.instanceBuffer, this.fgInstanceCount * INSTANCE_STRIDE);
      pass.drawIndexed(CUBE_INDICES.length, this.bgWallInstanceCount);
    }

    // 2. Draw layer 3 (Z=-2) — main background, depth-tested.
    if (this.bgPipeline && this.bgTreeInstanceCount > 0) {
      pass.setPipeline(this.bgPipeline);
      pass.setVertexBuffer(1, this.instanceBuffer,
        (this.fgInstanceCount + this.bgWallInstanceCount) * INSTANCE_STRIDE);
      pass.drawIndexed(CUBE_INDICES.length, this.bgTreeInstanceCount);
    }

    // 3. Draw foreground (Z=0, Z=-1) — depth-tested, writes depth.
    //    Closest to camera; overwrites background where they overlap.
    if (this.fgInstanceCount > 0) {
      pass.setPipeline(this.pipeline);
      pass.setVertexBuffer(1, this.instanceBuffer, 0);
      pass.drawIndexed(CUBE_INDICES.length, this.fgInstanceCount);
    }
  }

  /**
   * Render water instances as a transparent, alpha-blended pass.
   * Call AFTER the character pass so the player is visible behind water.
   * Uses depth-test (so water is occluded by closer opaque terrain) but
   * does NOT write depth (so water doesn't occlude objects drawn before it).
   */
  renderWater(pass: GPURenderPassEncoder): void {
    if (!this.waterPipeline || !this.bindGroup || !this.cubeVertexBuffer ||
        !this.cubeIndexBuffer || !this.instanceBuffer) return;
    if (this.waterInstanceCount === 0) return;

    // Water instances are stored after fg + bgWall + bgTree in the instance buffer.
    const waterOffset = (this.fgInstanceCount + this.bgInstanceCount) * INSTANCE_STRIDE;
    pass.setPipeline(this.waterPipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.cubeVertexBuffer);
    pass.setIndexBuffer(this.cubeIndexBuffer, "uint16");
    pass.setVertexBuffer(1, this.instanceBuffer, waterOffset);
    pass.drawIndexed(CUBE_INDICES.length, this.waterInstanceCount);
  }

  destroy(): void {
    this.cameraBuffer?.destroy();
    this.cubeVertexBuffer?.destroy();
    this.cubeIndexBuffer?.destroy();
    this.instanceBuffer?.destroy();
    this.paletteTexture?.destroy();
    this.lightTexture?.destroy();
    this.exploredTexture?.destroy();
    this.depthTexture?.destroy();
  }
}
