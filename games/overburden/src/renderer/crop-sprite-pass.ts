// ============================================================================
// CropSpritePass — renders crop + wild forageable blocks as 2D billboarded
// quads in the foreground layer.
//
// Crop blocks (category "special", no collision) are NOT rendered as 3D cubes
// by BlockGridPass3D — that pass skips them. Instead, this pass scans the
// foreground grid for crop/wild blocks and draws each as a flat 2D quad
// centered on the cell, sized by growth stage (seed=sprout, mature=full).
//
// The quads are rendered through the same 3D view-projection matrix as the
// block grid so they stay aligned with the world at any camera angle, but
// with depth testing disabled (always on top of the terrain, like drops).
//
// This mirrors DropPass but:
//   - No spin (crops don't rotate)
//   - Per-stage size (seed=0.3, sprout=0.5, growing=0.7, mature=0.9)
//   - Color from the crop's per-stage palette color
//   - Wild crops render at full size (0.85)
// ============================================================================

import { CROP_LOOKUP, getCropByBlock, getWildCropByBlock } from "../shared/crops";
import { type Mat4 } from "./matrix";

const CROP_WGSL = `
struct Uniforms {
  viewProj : mat4x4f,
  canvasW : f32,
  canvasH : f32,
  cropCount : f32,
  _pad : f32,
};

struct CropInstance {
  x : f32,
  y : f32,
  size : f32,
  r : f32,
  g : f32,
  b : f32,
  _pad1 : f32,
  _pad2 : f32,
};

@group(0) @binding(0) var<uniform> uniforms : Uniforms;
@group(0) @binding(1) var<storage, read> crops : array<CropInstance>;

struct VsOut {
  @builtin(position) pos : vec4f,
  @location(0) color : vec3f,
  @location(1) edgeDist : f32,
};

@vertex
fn vs_main(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VsOut {
  let crop = crops[ii];
  // Quad corners (unit square, centered at 0.5)
  // Triangle strip: bottom-left, bottom-right, top-left, top-right
  let corners = array<vec2f, 4>(
    vec2f(-0.5, -0.5),
    vec2f( 0.5, -0.5),
    vec2f(-0.5,  0.5),
    vec2f( 0.5,  0.5),
  );
  let c = corners[vi];

  // No spin — crops are static 2D sprites. Scale by per-instance size.
  let worldX = crop.x + c.x * crop.size;
  let worldY = crop.y + c.y * crop.size;
  // Place at Z=-0.5 (between foreground and background, in front of layer 3)
  // Same depth as drops so crops and drops layer correctly relative to terrain.
  let worldZ = -0.5;

  var out : VsOut;
  out.pos = uniforms.viewProj * vec4f(worldX, worldY, worldZ, 1.0);
  out.color = vec3f(crop.r, crop.g, crop.b);
  out.edgeDist = max(abs(c.x), abs(c.y)) * 2.0;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4f {
  // Subtle border darkening so the sprite has a soft edge
  let border = smoothstep(0.85, 1.0, in.edgeDist);
  let col = in.color * (1.0 - border * 0.4);
  return vec4f(col, 1.0);
}
`;

const MAX_CROP_INSTANCES = 2048; // active grid is 64x128 = 8192; crops are sparse
// Per instance: x, y, size, r, g, b, pad, pad = 8 floats
const CROP_INSTANCE_STRIDE = 8;

// Per-stage sprite sizes (fraction of a cell). Seed is tiny, mature fills
// most of the cell. Wild crops use a fixed size.
const STAGE_SIZES = [0.3, 0.5, 0.7, 0.9];
const WILD_SIZE = 0.85;

export class CropSpritePass {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private instanceBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private cropCount = 0;
  // Preallocated uniform + instance arrays (avoid per-frame allocation)
  private _uniform: Float32Array<ArrayBuffer> = new Float32Array(20);
  private _instanceData: Float32Array<ArrayBuffer> = new Float32Array(MAX_CROP_INSTANCES * CROP_INSTANCE_STRIDE);

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  init(): void {
    const shader = this.device.createShaderModule({ code: CROP_WGSL });

    // Uniform buffer: mat4x4 (64 bytes) + 4 floats (16 bytes) = 80 bytes
    this.uniformBuffer = this.device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Instance storage buffer
    this.instanceBuffer = this.device.createBuffer({
      size: MAX_CROP_INSTANCES * CROP_INSTANCE_STRIDE * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });

    this.bindGroup = this.device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.instanceBuffer } },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shader, entryPoint: "vs_main" },
      fragment: {
        module: shader,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-strip" },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: false,
        depthCompare: "always", // crops always render on top (2D overlay)
      },
    });
  }

  /**
   * Scan the foreground grid for crop/wild blocks and build instance data.
   * Only call when the sim tick has advanced — the foreground grid is
   * unchanged between ticks (30Hz), so scanning it every render frame
   * (60-360Hz) is wasted work.
   * @param foreground  active foreground plane (Uint16Array)
   * @param W           grid width
   * @param H           grid height
   */
  updateInstances(
    foreground: Uint16Array,
    W: number,
    H: number,
  ): void {
    if (!this.instanceBuffer) return;

    // Build instance data by scanning the foreground grid for crop/wild blocks
    // (reuse preallocated buffer — only upload the active portion)
    const data = this._instanceData;
    let count = 0;

    for (let y = 0; y < H && count < MAX_CROP_INSTANCES; y++) {
      for (let x = 0; x < W && count < MAX_CROP_INSTANCES; x++) {
        const blockId = foreground[y * W + x] & 0xFF;
        if (blockId === 0) continue;

        // Fast O(1) lookup instead of Set.has()
        const cropType = CROP_LOOKUP[blockId];
        if (cropType === 0) continue;

        let size: number;
        let color: [number, number, number];

        if (cropType === 1) {
          const entry = getCropByBlock(blockId);
          if (!entry) continue;
          size = STAGE_SIZES[entry.stage];
          color = entry.crop.colors[entry.stage];
        } else {
          const wc = getWildCropByBlock(blockId);
          if (!wc) continue;
          size = WILD_SIZE;
          color = wc.color;
        }

        const off = count * CROP_INSTANCE_STRIDE;
        // Center the quad on the cell (x + 0.5, y + 0.5)
        data[off + 0] = x + 0.5;
        data[off + 1] = y + 0.5;
        data[off + 2] = size;
        data[off + 3] = color[0] / 255;
        data[off + 4] = color[1] / 255;
        data[off + 5] = color[2] / 255;
        data[off + 6] = 0;
        data[off + 7] = 0;
        count++;
      }
    }

    // Only upload the active portion (not the full MAX_CROP_INSTANCES buffer)
    if (count > 0) {
      this.device.queue.writeBuffer(
        this.instanceBuffer, 0,
        data.buffer,
        data.byteOffset,
        count * CROP_INSTANCE_STRIDE * 4,
      );
    }
    this.cropCount = count;
  }

  /**
   * Update camera uniforms (viewProj + canvas size). Call every frame —
   * the camera moves continuously, independent of sim tick changes.
   */
  updateCamera(
    viewProj: Mat4,
    canvasW: number,
    canvasH: number,
  ): void {
    if (!this.uniformBuffer) return;
    const u = this._uniform; // 16 (mat4) + 4
    u.set(viewProj, 0);
    u[16] = canvasW;
    u[17] = canvasH;
    u[18] = this.cropCount;
    u[19] = 0;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, u);
  }

  render(pass: GPURenderPassEncoder): void {
    if (!this.pipeline || !this.bindGroup || this.cropCount === 0) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(4, this.cropCount); // 4 verts per quad, N instances
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.instanceBuffer?.destroy();
  }
}
