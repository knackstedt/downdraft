// ============================================================================
// LightAccumPass — renders to a half-res rgba8unorm light accumulation texture.
//
// The light texture covers the full active grid at half resolution (each
// texture pixel = 2×2 grid cells). Material shaders sample it with
// textureLoad(lightTex, coords/2, 0) to get per-cell lighting.
//
// Two sub-passes within one render pass:
//   1. Ambient fill: fullscreen quad fills with the depth-based base ambient
//      color (surface = warm white, deep = cool dark).
//   2. Light quads: instanced radial-gradient quads for each light (additive
//      blend). Light positions are in ACTIVE-GRID LOCAL coords.
//
// This replaces the old depth-based ambient darkening hack in sand-render.wgsl.
// ============================================================================

import LIGHT_WGSL from "../shaders/light-accum.wgsl?raw";
import {
    EXPLOSION_LIGHT_COLOR,
    EXPLOSION_LIGHT_INTENSITY,
    EXPLOSION_LIGHT_RADIUS,
    HEADLAMP_COLOR,
    HEADLAMP_INTENSITY,
    HEADLAMP_RADIUS,
    LIGHT_STRUCT_FLOATS,
    MAX_WORLD_LIGHTS,
} from "../shared/constants";

/** Max total lights = worker lights + renderer lights (headlamp + explosions). */
const MAX_TOTAL_LIGHTS = MAX_WORLD_LIGHTS + 1 + 8; // 128 + 1 headlamp + 8 explosions = 137
const LIGHT_STORAGE_FLOATS = MAX_TOTAL_LIGHTS * LIGHT_STRUCT_FLOATS;

/** A renderer-side light (headlamp, explosion). Positions in WORLD coords. */
export interface RendererLight {
  x: number; // world cell coords
  y: number;
  color: [number, number, number];
  intensity: number;
  radius: number;
}

export class LightAccumPass {
  private device: GPUDevice;
  private format: GPUTextureFormat = "rgba8unorm";

  private ambientPipeline: GPURenderPipeline | null = null;
  private lightPipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private ambientBindGroup: GPUBindGroup | null = null;
  private lightBindGroup: GPUBindGroup | null = null;

  private ambientBuffer: GPUBuffer | null = null;
  private texUniformBuffer: GPUBuffer | null = null;
  private lightStorageBuffer: GPUBuffer | null = null;

  private lightTexture: GPUTexture | null = null;
  private lightView: GPUTextureView | null = null;

  private quadVerts: GPUBuffer | null = null;

  // Packed light data (Float32Array, LIGHT_STRUCT_FLOATS per light) in LOCAL coords
  private lightData: Float32Array;
  private lightCount = 0;

  // Half-res dimensions for the light texture
  private texW = 0;
  private texH = 0;

  constructor(device: GPUDevice) {
    this.device = device;
    this.lightData = new Float32Array(LIGHT_STORAGE_FLOATS);
  }

  init(gridW: number, gridH: number): void {
    // Light texture at half the active grid resolution
    this.texW = Math.ceil(gridW / 2);
    this.texH = Math.ceil(gridH / 2);

    this.createLightTexture();

    this.ambientBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.texUniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.texUniformBuffer, 0, new Float32Array([this.texW, this.texH, 0, 0]));

    this.lightStorageBuffer = this.device.createBuffer({
      size: LIGHT_STORAGE_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Quad vertices for instanced light rendering: 6 verts (2 triangles)
    // covering -1..1 in XY
    const quad = new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1, 1, 1, -1, 1, 1,
    ]);
    this.quadVerts = this.device.createBuffer({
      size: quad.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.quadVerts, 0, quad);

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      ],
    });

    const shader = this.device.createShaderModule({ code: LIGHT_WGSL });

    // Ambient fill pipeline (fullscreen quad, no blending — fills the base)
    this.ambientPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: { module: shader, entryPoint: "vs_ambient", buffers: [{
        arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
      }] },
      fragment: {
        module: shader,
        entryPoint: "fs_ambient",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
    });

    // Light pipeline (instanced quads, additive blending)
    this.lightPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: { module: shader, entryPoint: "vs_light", buffers: [{
        arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
      }] },
      fragment: {
        module: shader,
        entryPoint: "fs_light",
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: "one", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.ambientBindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.ambientBuffer } },
        { binding: 1, resource: { buffer: this.texUniformBuffer } },
        { binding: 2, resource: { buffer: this.lightStorageBuffer } },
      ],
    });
    this.lightBindGroup = this.ambientBindGroup; // same bindings
  }

  private createLightTexture(): void {
    this.lightTexture?.destroy();
    const tex = this.device.createTexture({
      size: [this.texW, this.texH],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.lightTexture = tex;
    this.lightView = tex.createView();
  }

  /** Get the light texture view for sampling by material passes. */
  getLightTextureView(): GPUTextureView | null {
    return this.lightView;
  }

  /**
   * Update the light data: combine worker lights (from SAB, in WORLD coords)
   * with renderer lights (headlamp, explosions, in WORLD coords). Converts
   * all to LOCAL coords by subtracting the origin. Packs into the storage buffer.
   */
  updateLights(
    workerLights: Float32Array,
    workerCount: number,
    rendererLights: RendererLight[],
    originX: number,
    originY: number,
  ): void {
    let count = 0;
    const data = this.lightData;

    // Copy worker lights (already packed in LIGHT_STRUCT_FLOATS format, world coords)
    const wCount = Math.min(workerCount, MAX_WORLD_LIGHTS);
    for (let i = 0; i < wCount; i++) {
      const srcOff = i * LIGHT_STRUCT_FLOATS;
      const dstOff = count * LIGHT_STRUCT_FLOATS;
      // Convert world coords → local coords
      data[dstOff] = workerLights[srcOff] - originX;
      data[dstOff + 1] = workerLights[srcOff + 1] - originY;
      // Copy color, intensity, radius
      data[dstOff + 2] = workerLights[srcOff + 2];
      data[dstOff + 3] = workerLights[srcOff + 3];
      data[dstOff + 4] = workerLights[srcOff + 4];
      data[dstOff + 5] = workerLights[srcOff + 5];
      data[dstOff + 6] = workerLights[srcOff + 6];
      data[dstOff + 7] = 0;
      count++;
    }

    // Add renderer lights (headlamp, explosions) — convert world → local
    for (const light of rendererLights) {
      if (count >= MAX_TOTAL_LIGHTS) break;
      const off = count * LIGHT_STRUCT_FLOATS;
      data[off] = light.x - originX;
      data[off + 1] = light.y - originY;
      data[off + 2] = light.color[0];
      data[off + 3] = light.color[1];
      data[off + 4] = light.color[2];
      data[off + 5] = light.intensity;
      data[off + 6] = light.radius;
      data[off + 7] = 0;
      count++;
    }

    this.lightCount = count;
    this.device.queue.writeBuffer(this.lightStorageBuffer!, 0, data.subarray(0, count * LIGHT_STRUCT_FLOATS) as unknown as BufferSource);
  }

  /** Update the ambient color based on depth (in cells below surface).
   *  Surface = bright sky light. Underground = drops to pure black so dynamic
   *  lights (headlamp, torches, lava) are the only visibility source. */
  updateAmbient(depthCells: number): void {
    // depthCells = actual cells below the surface (not chunk depth)
    // 0 cells: bright daylight (1.0, 1.0, 0.95)
    // 20 cells: moderate — dim, can see shapes
    // 40+ cells: pure black (0.0) — need lights to see anything
    const t = Math.min(depthCells / 40, 1.0);
    const r = 1.0 * (1 - t) * (1 - t);
    const g = 1.0 * (1 - t) * (1 - t);
    const b = 0.95 * (1 - t) * (1 - t);
    this.device.queue.writeBuffer(this.ambientBuffer!, 0, new Float32Array([r, g, b, 1.0]));
  }

  /**
   * Render the light accumulation pass. Must be called BEFORE the main scene
   * render pass, as a separate render pass targeting the light texture.
   */
  render(encoder: GPUCommandEncoder): void {
    if (!this.ambientPipeline || !this.lightPipeline || !this.ambientBindGroup || !this.lightView || !this.quadVerts) return;

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.lightView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });

    // 1. Ambient fill (fullscreen quad)
    pass.setPipeline(this.ambientPipeline);
    pass.setBindGroup(0, this.ambientBindGroup);
    pass.setVertexBuffer(0, this.quadVerts);
    pass.draw(6);

    // 2. Light quads (instanced)
    if (this.lightCount > 0) {
      pass.setPipeline(this.lightPipeline);
      pass.setBindGroup(0, this.lightBindGroup);
      pass.setVertexBuffer(0, this.quadVerts);
      pass.draw(6, this.lightCount);
    }

    pass.end();
  }

  destroy(): void {
    this.lightTexture?.destroy();
    this.ambientBuffer?.destroy();
    this.texUniformBuffer?.destroy();
    this.lightStorageBuffer?.destroy();
    this.quadVerts?.destroy();
  }
}

/** Create a headlamp light at the player's position (world coords). */
export function createHeadlampLight(px: number, py: number): RendererLight {
  return {
    x: px,
    y: py,
    color: HEADLAMP_COLOR,
    intensity: HEADLAMP_INTENSITY,
    radius: HEADLAMP_RADIUS,
  };
}

/** Create an explosion light at the given position with progress-based intensity. */
export function createExplosionLight(x: number, y: number, progress: number): RendererLight {
  // Intensity fades from full to 0 as the explosion ages
  const intensity = EXPLOSION_LIGHT_INTENSITY * (1 - progress);
  const radius = EXPLOSION_LIGHT_RADIUS * (1 - progress * 0.5);
  return {
    x,
    y,
    color: EXPLOSION_LIGHT_COLOR,
    intensity,
    radius,
  };
}
