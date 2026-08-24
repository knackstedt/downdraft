// ============================================================================
// DropPass — renders world drop items as 2D spinning quads
//
// Each drop is a small flat quad that spins around the vertical (Y) axis.
// The quad is positioned at the drop's active-grid coordinates and rendered
// through the same 3D view-projection matrix as the block grid, so it stays
// aligned with the world at any camera angle.
//
// Two rendering modes:
//   - Textured: fruit drops use a 16x16 sprite from fruit-spritesheet.png.
//     The sprite is sampled with alpha blending for transparent edges.
//   - Solid color: non-fruit drops (wood, stone, etc.) use a flat color from
//     the drop registry.
//
// The spin creates a pseudo-3D "billboard" effect: as the quad rotates, it
// narrows and widens, mimicking a spinning item.
// ============================================================================

import fruitSpritesheetUrl from "../assets/fruit-spritesheet.png";
import {
    getDropColor, getFruitSprite,
    SPRITESHEET_COLS, SPRITESHEET_ROWS, SPRITESHEET_TILE_PX,
} from "../shared/drop-registry";
import { type Mat4 } from "./matrix";

const DROP_WGSL = `
struct Uniforms {
  viewProj : mat4x4f,
  canvasW : f32,
  canvasH : f32,
  dropCount : f32,
  hasTexture : f32,
};

struct DropInstance {
  x : f32,
  y : f32,
  spin : f32,
  uOffset : f32,   // >= 0 = textured (UV offset in atlas), < 0 = solid color
  vOffset : f32,
  r : f32,         // solid color (used when uOffset < 0)
  g : f32,
  b : f32,
};

@group(0) @binding(0) var<uniform> uniforms : Uniforms;
@group(0) @binding(1) var<storage, read> drops : array<DropInstance>;
@group(0) @binding(2) var fruitSampler : sampler;
@group(0) @binding(3) var fruitTexture : texture_2d<f32>;

struct VsOut {
  @builtin(position) pos : vec4f,
  @location(0) color : vec3f,
  @location(1) uv : vec2f,
  @location(2) isTextured : f32,
  @location(3) edgeDist : f32,
};

const QUAD_SIZE = 0.6; // blocks

// Spritesheet UV dimensions (each sprite is 16px in a 608x96 texture)
const SPRITE_U = 16.0 / 608.0;
const SPRITE_V = 16.0 / 96.0;

@vertex
fn vs_main(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VsOut {
  let drop = drops[ii];
  let corners = array<vec2f, 4>(
    vec2f(-0.5, -0.5),  // bottom-left
    vec2f( 0.5, -0.5),  // bottom-right
    vec2f(-0.5,  0.5),  // top-left
    vec2f( 0.5,  0.5),  // top-right
  );
  let c = corners[vi];

  // Spin: scale X by cos(spin) to simulate Y-axis rotation.
  let cosA = cos(drop.spin);
  let rotX = c.x * cosA;

  let worldX = drop.x + rotX * QUAD_SIZE;
  let worldY = drop.y + c.y * QUAD_SIZE;
  let worldZ = -0.5;

  var out : VsOut;
  out.pos = uniforms.viewProj * vec4f(worldX, worldY, worldZ, 1.0);
  out.color = vec3f(drop.r, drop.g, drop.b);
  out.edgeDist = max(abs(c.x), abs(c.y)) * 2.0;

  // UV: map corner (-0.5..0.5) to (0..1) within the sprite cell.
  // For textured drops, offset by the sprite's UV in the atlas.
  let cornerU = c.x + 0.5;
  let cornerV = c.y + 0.5;
  if (drop.uOffset >= 0.0) {
    out.uv = vec2f(drop.uOffset + cornerU * SPRITE_U, drop.vOffset + cornerV * SPRITE_V);
    out.isTextured = 1.0;
  } else {
    out.uv = vec2f(0.0, 0.0);
    out.isTextured = 0.0;
  }

  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4f {
  let border = smoothstep(0.85, 1.0, in.edgeDist);

  // Always sample the texture (textureSample requires uniform control flow,
  // so we use textureSampleLevel with LOD 0 which has no such restriction).
  // For non-textured drops, the sample result is simply ignored.
  let texColor = textureSampleLevel(fruitTexture, fruitSampler, in.uv, 0.0);

  // Mix between textured and solid color based on the isTextured flag.
  // Use select() for branchless blending — avoids non-uniform control flow.
  let texFrag = vec4f(texColor.rgb * (1.0 - border * 0.3), texColor.a);
  let solidFrag = vec4f(in.color * (1.0 - border * 0.4), 1.0);

  let useTextured = min(in.isTextured, uniforms.hasTexture);
  return mix(solidFrag, texFrag, step(0.5, useTextured));
}
`;

const MAX_DROP_INSTANCES = 512;
// Per instance: x, y, spin, uOffset, vOffset, r, g, b = 8 floats
const DROP_INSTANCE_STRIDE = 8;

export interface DropRenderData {
  x: number;
  y: number;
  spin: number;
  itemCode: number;
}

export class DropPass {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private instanceBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private fruitTexture: GPUTexture | null = null;
  private sampler: GPUSampler | null = null;
  private dropCount = 0;
  private textureLoaded = false;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  /** Async-load the fruit spritesheet. Safe to call after init(). */
  async loadFruitTexture(): Promise<void> {
    if (this.textureLoaded) return;
    try {
      const response = await fetch(fruitSpritesheetUrl);
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      const texture = this.device.createTexture({
        size: [bitmap.width, bitmap.height],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture },
        [bitmap.width, bitmap.height],
      );
      this.fruitTexture = texture;
      this.sampler = this.device.createSampler({
        magFilter: "nearest",
        minFilter: "nearest",
      });
      this.textureLoaded = true;
      // Rebuild bind group now that the texture exists
      this.buildBindGroup();
    } catch (e) {
      console.warn("[DropPass] Failed to load fruit spritesheet:", e);
    }
  }

  init(): void {
    const shader = this.device.createShaderModule({ code: DROP_WGSL });

    // Uniform buffer: mat4x4 (64 bytes) + 5 floats (20 bytes) = 84 → round to 96
    this.uniformBuffer = this.device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Instance storage buffer
    this.instanceBuffer = this.device.createBuffer({
      size: MAX_DROP_INSTANCES * DROP_INSTANCE_STRIDE * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Create a placeholder texture (1x1 transparent) so the bind group is
    // always valid, even before the real texture loads.
    this.fruitTexture = this.device.createTexture({
      size: [1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const transparent = new Uint8Array([0, 0, 0, 0]);
    this.device.queue.writeTexture(
      { texture: this.fruitTexture },
      transparent,
      { bytesPerRow: 4 },
      [1, 1],
    );

    this.sampler = this.device.createSampler({
      magFilter: "nearest",
      minFilter: "nearest",
    });

    this.buildBindGroup();

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shader, entryPoint: "vs_main" },
      fragment: {
        module: shader,
        entryPoint: "fs_main",
        targets: [{
          format: this.format,
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        }],
      },
      primitive: { topology: "triangle-strip" },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: false,
        depthCompare: "always", // drops always render on top
      },
    });
  }

  private bindGroupLayout: GPUBindGroupLayout | null = null;

  private buildBindGroup(): void {
    if (!this.uniformBuffer || !this.instanceBuffer || !this.fruitTexture || !this.sampler) return;

    if (!this.bindGroupLayout) {
      this.bindGroupLayout = this.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
          { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
          { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        ],
      });
    }

    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.instanceBuffer } },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: this.fruitTexture.createView() },
      ],
    });
  }

  update(viewProj: Mat4, canvasW: number, canvasH: number, dropData: DropRenderData[]): void {
    if (!this.uniformBuffer || !this.instanceBuffer) return;

    // Write uniforms
    const u = new Float32Array(21); // 16 (mat4) + 5
    u.set(viewProj, 0);
    u[16] = canvasW;
    u[17] = canvasH;
    u[18] = Math.min(dropData.length, MAX_DROP_INSTANCES);
    u[19] = this.textureLoaded ? 1 : 0;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, u);

    // Build instance data
    const count = Math.min(dropData.length, MAX_DROP_INSTANCES);
    const data = new Float32Array(MAX_DROP_INSTANCES * DROP_INSTANCE_STRIDE);
    for (let i = 0; i < count; i++) {
      const d = dropData[i];
      const off = i * DROP_INSTANCE_STRIDE;
      data[off + 0] = d.x;
      data[off + 1] = d.y;
      data[off + 2] = d.spin;

      // Check if this drop has a fruit sprite
      const sprite = getFruitSprite(d.itemCode);
      if (sprite) {
        // Textured: compute UV offset in the atlas
        data[off + 3] = sprite.col * SPRITESHEET_TILE_PX / (SPRITESHEET_COLS * SPRITESHEET_TILE_PX);
        data[off + 4] = sprite.row * SPRITESHEET_TILE_PX / (SPRITESHEET_ROWS * SPRITESHEET_TILE_PX);
        // Color is unused for textured drops, but set it as fallback
        const color = getDropColor(d.itemCode);
        data[off + 5] = color[0] / 255;
        data[off + 6] = color[1] / 255;
        data[off + 7] = color[2] / 255;
      } else {
        // Solid color: uOffset = -1 (sentinel for "not textured")
        data[off + 3] = -1;
        data[off + 4] = 0;
        const color = getDropColor(d.itemCode);
        data[off + 5] = color[0] / 255;
        data[off + 6] = color[1] / 255;
        data[off + 7] = color[2] / 255;
      }
    }
    this.device.queue.writeBuffer(this.instanceBuffer, 0, data);
    this.dropCount = count;
  }

  render(pass: GPURenderPassEncoder): void {
    if (!this.pipeline || !this.bindGroup || this.dropCount === 0) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(4, this.dropCount); // 4 verts per quad, N instances
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.instanceBuffer?.destroy();
    this.fruitTexture?.destroy();
  }
}
