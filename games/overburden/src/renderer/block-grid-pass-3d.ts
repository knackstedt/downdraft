// ============================================================================
// BlockGridPass3D — renders blocks as 3D cubes with perspective projection.
//
// Uses instanced rendering: one cube geometry, many instances.
// Per-instance: world position, block ID, face visibility mask, light level.
// Background blocks at Z=-1, foreground at Z=0 (true 2.5D depth layering).
// ============================================================================

import BLOCK_RENDER_3D_FS from "../shaders/block-render-3d.wgsl?raw";
import { getBlockPalette } from "../shared/block-registry";
import {
    ACTIVE_GRID_CELLS, ACTIVE_GRID_H, ACTIVE_GRID_W,
    BLOCK_LEAVES, BLOCK_WOOD,
} from "../shared/constants";
import { lookAt, multiply, perspective, type Mat4 } from "./matrix";

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

// Depth layering: 4-layer system on a 1,2,3,4 scale.
//   Layer 1 (Z= 0): foreground front  ← closest to camera
//   Layer 2 (Z=-1): foreground back   ← player walks here
//   Layer 3 (Z=-2): background front  ← trees
//   Layer 4 (Z=-3): background back   ← back wall
// Foreground blocks are double-rendered at Z=0 and Z=-1 for depth.
// Background blocks are double-rendered at Z=-2 and Z=-3 for depth.
const FG_Z_LAYERS = [0, -1];
const BG_Z_LAYERS = [-2, -3];
const NUM_FG_LAYERS = FG_Z_LAYERS.length;
const NUM_BG_LAYERS = BG_Z_LAYERS.length;

export class BlockGridPass3D {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private depthFormat: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private bgPipeline: GPURenderPipeline | null = null; // background blocks: always pass depth
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
  private depthTexture: GPUTexture | null = null;

  gridW: number;
  gridH: number;

  // Scratch instance data (rebuilt each frame)
  private instanceData: Float32Array;
  private fgInstanceCount = 0;  // foreground instances (depth-tested)
  private bgInstanceCount = 0;  // background instances (always drawn, no depth write)
  private instanceCount = 0;    // total (for buffer sizing)

  // Scratch light/explored upload buffers (padded to 256-byte rows)
  private paddedLight: Uint8Array;
  private paddedExplored: Uint8Array;
  private paddedRowBytes: number;

  // Cached view-projection matrix
  private viewProj: Mat4 = new Float32Array(16);

  // Debug: when true, disable fog-of-war + shadow darkening (F1).
  // The light texture is cleared to full white and the explored texture
  // to full white, so the shader renders everything fully lit with no fog.
  private debugNoShadows = false;

  // Tracked depth texture size
  private depthW = 0;
  private depthH = 0;

  constructor(device: GPUDevice, format: GPUTextureFormat, depthFormat: GPUTextureFormat = "depth24plus") {
    this.device = device;
    this.format = format;
    this.depthFormat = depthFormat;
    this.gridW = ACTIVE_GRID_W;
    this.gridH = ACTIVE_GRID_H;
    // Max instances = all cells (fg double-rendered + bg double-rendered).
    this.instanceData = new Float32Array(ACTIVE_GRID_CELLS * (NUM_FG_LAYERS + NUM_BG_LAYERS) * 5);
    this.paddedRowBytes = Math.ceil(ACTIVE_GRID_W / 256) * 256;
    this.paddedLight = new Uint8Array(this.paddedRowBytes * ACTIVE_GRID_H);
    this.paddedExplored = new Uint8Array(this.paddedRowBytes * ACTIVE_GRID_H);
  }

  init(): void {
    // Camera uniform buffer (viewProj matrix + camera params)
    // 16 floats for matrix + 12 floats for params = 28 floats = 112 bytes
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

    // Background pipeline: always pass depth, don't write depth.
    // This ensures background blocks are drawn first and visible through
    // the perspective gap above foreground blocks. The foreground pipeline
    // (above) then draws on top with proper depth testing.
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
        depthWriteEnabled: false, // don't write depth — foreground will overwrite
        depthCompare: "always",   // always draw, even if behind something
      },
    });

    this.createBindGroup();
  }

  private createTextures(): void {
    // Light texture (r8unorm)
    this.lightTexture = this.device.createTexture({
      size: [this.gridW, this.gridH],
      format: "r8unorm",
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
  }

  private createBindGroup(): void {
    if (!this.bindGroupLayout || !this.cameraBuffer || !this.paletteView ||
        !this.lightView || !this.exploredView) return;
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: this.paletteView },
        { binding: 2, resource: this.lightView },
        { binding: 3, resource: this.exploredView },
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

  /** Get the current view-projection matrix (computed in updateCamera). */
  getViewProj(): Mat4 {
    return this.viewProj;
  }

  /** Build instance data from the grid. Called each frame. */
  updateGrid(foreground: Uint16Array, background: Uint16Array): void {
    let idx = 0;
    const data = this.instanceData;
    const W = this.gridW;
    const H = this.gridH;

    // --- Foreground blocks (rendered at 2 Z depths: Z=0 and Z=-1) ---
    // Layer 1 (Z=0): front face visible. Layer 2 (Z=-1): back face visible.
    // Both layers show top/bottom/side faces based on neighbors.
    for (let layer = 0; layer < NUM_FG_LAYERS; layer++) {
      const layerZ = FG_Z_LAYERS[layer];
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const cellIdx = y * W + x;
          const packedFg = foreground[cellIdx];
          const blockId = packedFg & 0xFF;
          if (blockId === 0) continue;

          let faceMask = 0;
          if (x >= W - 1 || (foreground[y * W + (x + 1)] & 0xFF) === 0) faceMask |= FACE_RIGHT;
          if (x <= 0 || (foreground[y * W + (x - 1)] & 0xFF) === 0) faceMask |= FACE_LEFT;
          if (y >= H - 1 || (foreground[(y + 1) * W + x] & 0xFF) === 0) faceMask |= FACE_BOTTOM;
          if (y <= 0 || (foreground[(y - 1) * W + x] & 0xFF) === 0) faceMask |= FACE_TOP;

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
    // Layer 3 (Z=-2): trees (wood, leaves) — rendered at this depth only.
    // Layer 4 (Z=-3): back wall (everything else in the background grid).
    // This prevents trees from appearing at both depths (which looked like
    // a 5th layer) and keeps the 4-layer system clean.
    // Render deepest first (Z=-3) so painter's algorithm stacks correctly.

    // Layer 4: back wall (all background blocks EXCEPT trees) at Z=-3
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const cellIdx = y * W + x;
        const packedBg = background[cellIdx];
        const blockId = packedBg & 0xFF;
        if (blockId === 0) continue;
        // Skip tree blocks — they go on layer 3
        if (blockId === BLOCK_WOOD || blockId === BLOCK_LEAVES) continue;

        let faceMask = 0;
        faceMask |= FACE_FRONT;
        faceMask |= FACE_TOP;
        if (x >= W - 1 || (background[y * W + (x + 1)] & 0xFF) === 0) faceMask |= FACE_RIGHT;
        if (x <= 0 || (background[y * W + (x - 1)] & 0xFF) === 0) faceMask |= FACE_LEFT;

        data[idx * 5 + 0] = x;
        data[idx * 5 + 1] = y;
        data[idx * 5 + 2] = BG_Z_LAYERS[1]; // Z=-3 (layer 4)
        data[idx * 5 + 3] = blockId;
        data[idx * 5 + 4] = faceMask;
        idx++;
      }
    }

    // Layer 3: trees (wood, leaves) at Z=-2
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const cellIdx = y * W + x;
        const packedBg = background[cellIdx];
        const blockId = packedBg & 0xFF;
        if (blockId === 0) continue;
        // Only render tree blocks at this depth
        if (blockId !== BLOCK_WOOD && blockId !== BLOCK_LEAVES) continue;

        let faceMask = 0;
        faceMask |= FACE_FRONT;
        faceMask |= FACE_TOP;
        if (x >= W - 1 || (background[y * W + (x + 1)] & 0xFF) === 0) faceMask |= FACE_RIGHT;
        if (x <= 0 || (background[y * W + (x - 1)] & 0xFF) === 0) faceMask |= FACE_LEFT;

        data[idx * 5 + 0] = x;
        data[idx * 5 + 1] = y;
        data[idx * 5 + 2] = BG_Z_LAYERS[0]; // Z=-2 (layer 3)
        data[idx * 5 + 3] = blockId;
        data[idx * 5 + 4] = faceMask;
        idx++;
      }
    }
    this.bgInstanceCount = idx - this.fgInstanceCount;
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

  /** Enable/disable debug no-shadows mode (F1). When enabled, light + explored
   *  textures are filled with full-white so everything renders fully lit. */
  setDebugNoShadows(enabled: boolean): void {
    this.debugNoShadows = enabled;
  }

  updateLight(grid: Uint8Array): void {
    if (!this.lightTexture) return;

    if (this.debugNoShadows) {
      // Debug mode: fill light texture with full white (15 = max light)
      this.paddedLight.fill(15);
      this.device.queue.writeTexture(
        { texture: this.lightTexture },
        this.paddedLight.buffer as BufferSource,
        { bytesPerRow: this.paddedRowBytes, rowsPerImage: this.gridH },
        [this.gridW, this.gridH],
      );
      return;
    }

    // Copy into padded buffer
    for (let y = 0; y < this.gridH; y++) {
      this.paddedLight.set(
        grid.subarray(y * this.gridW, (y + 1) * this.gridW),
        y * this.paddedRowBytes,
      );
    }
    this.device.queue.writeTexture(
      { texture: this.lightTexture },
      this.paddedLight.buffer as BufferSource,
      { bytesPerRow: this.paddedRowBytes, rowsPerImage: this.gridH },
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
        { bytesPerRow: this.paddedRowBytes, rowsPerImage: this.gridH },
        [this.gridW, this.gridH],
      );
      return;
    }

    for (let y = 0; y < this.gridH; y++) {
      this.paddedExplored.set(
        grid.subarray(y * this.gridW, (y + 1) * this.gridW),
        y * this.paddedRowBytes,
      );
    }
    this.device.queue.writeTexture(
      { texture: this.exploredTexture },
      this.paddedExplored.buffer as BufferSource,
      { bytesPerRow: this.paddedRowBytes, rowsPerImage: this.gridH },
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
  ): void {
    // Camera pitch angle (radians). ~20° gives a 2.5D perspective
    // that shows block tops and front faces clearly.
    const pitchAngle = 20 * Math.PI / 180;

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

    // Compute view-projection matrix
    const aspect = canvasW / canvasH;
    const near = 0.1;
    const far = distance * 3 + 100;

    const proj = perspective(fov, aspect, near, far);
    const view = lookAt(eye, target, up);
    this.viewProj = multiply(proj, view);

    // Write camera uniform buffer
    // Layout: viewProj (16 floats) + camPos (3) + zoom (1) + canvasW (1) + canvasH (1) + daylight (1) + mineX (1) + mineY (1) + mineDamage (1) + pad (1) = 28 floats
    const u = new Float32Array(32); // 128 bytes / 4
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
    this.device.queue.writeBuffer(this.cameraBuffer!, 0, u);
  }

  render(pass: GPURenderPassEncoder): void {
    if (!this.pipeline || !this.bindGroup || !this.cubeVertexBuffer ||
        !this.cubeIndexBuffer || !this.instanceBuffer) return;
    if (this.instanceCount === 0) return;

    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.cubeVertexBuffer);
    pass.setIndexBuffer(this.cubeIndexBuffer, "uint16");

    // Draw background blocks first (always passes depth, no depth write).
    // Use vertex buffer offset to point to the background portion of the
    // instance buffer (foreground data comes first, background after).
    if (this.bgPipeline && this.bgInstanceCount > 0) {
      pass.setPipeline(this.bgPipeline);
      pass.setVertexBuffer(1, this.instanceBuffer, this.fgInstanceCount * INSTANCE_STRIDE);
      pass.drawIndexed(CUBE_INDICES.length, this.bgInstanceCount);
    }

    // Draw foreground blocks (depth-tested, writes depth).
    // Foreground instances start at offset 0 in the instance buffer.
    if (this.fgInstanceCount > 0) {
      pass.setPipeline(this.pipeline);
      pass.setVertexBuffer(1, this.instanceBuffer, 0);
      pass.drawIndexed(CUBE_INDICES.length, this.fgInstanceCount);
    }
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
