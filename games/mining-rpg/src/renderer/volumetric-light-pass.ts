// ============================================================================
// VolumetricLightPass — render-pass-based light diffusion through air/water/solid.
//
// Uses fragment shaders + render targets (no compute shaders, no storage
// textures) for maximum GPU compatibility. Two fragment passes ping-pong
// between two rgba8unorm textures:
//   fs_inject  — seed ambient sky light + world lights
//   fs_diffuse — one Jacobi diffusion iteration (read src texture, write dst)
//
// The alpha channel stores cell type (0=air, 0.5=water, 1.0=solid), packed
// during inject so the diffuse pass avoids grid texture sampling.
//
// Output: a half-res rgba8unorm texture sampled by material shaders and added
// to the LightAccumPass light texture.
// ============================================================================

import { createValidatedShaderModule } from "@downdraft/core";
import VOLUMETRIC_WGSL from "../shaders/volumetric-light.wgsl?raw" with { type: "text" };
import {
    DEFAULT_VOLUMETRIC_LIGHT_CONFIG,
    LIGHT_STRUCT_FLOATS,
    MAX_WORLD_LIGHTS,
    type VolumetricLightConfig,
} from "../shared/constants";

/** Max total lights = worker world lights + glowsticks (renderer-side). */
const MAX_VOL_LIGHTS = MAX_WORLD_LIGHTS + 32;
// Uniform array of LightData structs (8 floats each = 32 bytes).
// Uniform buffer max is 64KB; 160 * 32 = 5120 bytes — well within limits.
const VOL_LIGHT_UNIFORM_FLOATS = MAX_VOL_LIGHTS * LIGHT_STRUCT_FLOATS;

/** A renderer-side light for the volumetric pass (glowsticks). World coords. */
export interface VolRendererLight {
  x: number;
  y: number;
  color: [number, number, number];
  intensity: number;
  radius: number;
}

// Uniform struct layout — must match VolUniforms in volumetric-light.wgsl.
const VOL_UNIFORM_FLOATS = 20;

export class VolumetricLightPass {
  private device: GPUDevice;
  private config: VolumetricLightConfig;

  // If true, skip all render work (set after a GPU error or for debugging).
  disabled = false;

  // Half-res field dimensions (1 texel = 2×2 grid cells)
  private fieldW = 0;
  private fieldH = 0;

  // Ping-pong rgba8unorm render-target textures for diffusion
  private fieldTextureA: GPUTexture | null = null;
  private fieldTextureB: GPUTexture | null = null;
  private fieldViewA: GPUTextureView | null = null;
  private fieldViewB: GPUTextureView | null = null;
  // The "final" field view (the one to sample after render completes)
  private outputView: GPUTextureView | null = null;

  // Uniform buffer for params, storage buffer for light data array
  private uniformBuffer: GPUBuffer | null = null;
  private lightStorageBuffer: GPUBuffer | null = null;
  private uniformData: Float32Array;
  private lightData: Float32Array;
  private lightCount = 0;

  // Render pipelines (inject + diffuse)
  private injectPipeline: GPURenderPipeline | null = null;
  private diffusePipeline: GPURenderPipeline | null = null;

  // Bind groups (recreated when grid view changes)
  private injectBindGroup: GPUBindGroup | null = null;
  private diffuseBindGroupA: GPUBindGroup | null = null; // src=A, dst=B
  private diffuseBindGroupB: GPUBindGroup | null = null; // src=B, dst=A

  // Grid texture view (from SandGridPass) — set each frame
  private gridView: GPUTextureView | null = null;
  private prevGridView: GPUTextureView | null = null;

  // Track origin changes to force bind group recreation
  private prevOriginX = 0;
  private prevOriginY = 0;

  // Bind group layout (shared by both pipelines)
  private bindGroupLayout: GPUBindGroupLayout | null = null;

  constructor(device: GPUDevice, config: Partial<VolumetricLightConfig> = {}) {
    this.device = device;
    this.config = { ...DEFAULT_VOLUMETRIC_LIGHT_CONFIG, ...config };
    this.lightData = new Float32Array(VOL_LIGHT_UNIFORM_FLOATS);
    this.uniformData = new Float32Array(VOL_UNIFORM_FLOATS);
  }

  init(gridW: number, gridH: number): void {
    this.fieldW = Math.ceil(gridW / 2);
    this.fieldH = Math.ceil(gridH / 2);

    this.createFieldTextures();

    this.uniformBuffer = this.device.createBuffer({
      label: "volumetric-light-uniforms",
      size: VOL_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Light data as a storage buffer (read-only) — avoids uniform buffer
    // array alignment/size restrictions.
    this.lightStorageBuffer = this.device.createBuffer({
      label: "volumetric-light-storage",
      size: VOL_LIGHT_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      ],
    });

    const shader = createValidatedShaderModule(this.device, { code: VOLUMETRIC_WGSL, label: "VolumetricLightPass" });
    const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });
    const targetFormat: GPUTextureFormat = "rgba16float";

    this.injectPipeline = this.device.createRenderPipeline({
      label: "volumetric-light-inject",
      layout,
      vertex: { module: shader, entryPoint: "vs_main" },
      fragment: {
        module: shader,
        entryPoint: "fs_inject",
        targets: [{ format: targetFormat }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.diffusePipeline = this.device.createRenderPipeline({
      label: "volumetric-light-diffuse",
      layout,
      vertex: { module: shader, entryPoint: "vs_main" },
      fragment: {
        module: shader,
        entryPoint: "fs_diffuse",
        targets: [{ format: targetFormat }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  private createFieldTextures(): void {
    this.fieldTextureA?.destroy();
    this.fieldTextureB?.destroy();

    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    const size: [number, number] = [this.fieldW, this.fieldH];

    // rgba16float gives enough precision for smooth diffusion gradients.
    // Unlike storage textures, rgba16float render targets are universally
    // supported (required by the WebGPU spec for color attachments).
    this.fieldTextureA = this.device.createTexture({
      label: "volumetric-field-a",
      size,
      format: "rgba16float",
      usage,
    });
    this.fieldViewA = this.fieldTextureA.createView();

    this.fieldTextureB = this.device.createTexture({
      label: "volumetric-field-b",
      size,
      format: "rgba16float",
      usage,
    });
    this.fieldViewB = this.fieldTextureB.createView();

    this.outputView = this.fieldViewA;
  }

  /** Set the grid texture view (from SandGridPass). Called each frame. */
  setGridView(view: GPUTextureView | null): void {
    this.gridView = view;
  }

  updateLights(
    workerLights: Float32Array,
    workerCount: number,
    rendererLights: VolRendererLight[],
    originX: number,
    originY: number,
  ): void {
    let count = 0;
    const data = this.lightData;

    // Active grid bounds in local coords (0..gridW, 0..gridH).
    // Worker lights are in world coords and are scanned every
    // LIGHT_SCAN_INTERVAL ticks (4 ticks ≈ 133ms). Between scans, the active
    // grid origin can shift (chunk border crossing), making some light world
    // coords stale — they'd map to local coords outside the active grid.
    // Filter those out so they don't create "zombie" diffuse glows.
    const gridW = this.fieldW * 2;
    const gridH = this.fieldH * 2;

    const wCount = Math.min(workerCount, MAX_WORLD_LIGHTS);
    for (let i = 0; i < wCount; i++) {
      const srcOff = i * LIGHT_STRUCT_FLOATS;
      const lx = workerLights[srcOff] - originX;
      const ly = workerLights[srcOff + 1] - originY;
      const radius = workerLights[srcOff + 6];
      // Skip lights outside the active grid (stale lights from old origin)
      if (lx + radius < 0 || lx - radius > gridW || ly + radius < 0 || ly - radius > gridH) continue;
      const dstOff = count * LIGHT_STRUCT_FLOATS;
      data[dstOff] = lx;
      data[dstOff + 1] = ly;
      data[dstOff + 2] = workerLights[srcOff + 2];
      data[dstOff + 3] = workerLights[srcOff + 3];
      data[dstOff + 4] = workerLights[srcOff + 4];
      data[dstOff + 5] = workerLights[srcOff + 5];
      data[dstOff + 6] = radius;
      data[dstOff + 7] = 0;
      count++;
    }

    for (const light of rendererLights) {
      if (count >= MAX_VOL_LIGHTS) break;
      const lx = light.x - originX;
      const ly = light.y - originY;
      if (lx + light.radius < 0 || lx - light.radius > gridW || ly + light.radius < 0 || ly - light.radius > gridH) continue;
      const off = count * LIGHT_STRUCT_FLOATS;
      data[off] = lx;
      data[off + 1] = ly;
      data[off + 2] = light.color[0];
      data[off + 3] = light.color[1];
      data[off + 4] = light.color[2];
      data[off + 5] = light.intensity;
      data[off + 6] = light.radius;
      data[off + 7] = 0;
      count++;
    }

    this.lightCount = count;
    this.device.queue.writeBuffer(
      this.lightStorageBuffer!,
      0,
      data.subarray(0, count * LIGHT_STRUCT_FLOATS) as unknown as BufferSource,
    );
  }

  updateUniforms(originX: number, originY: number, surfaceY: number): void {
    const u = this.uniformData;
    const c = this.config;
    u[0] = this.fieldW;
    u[1] = this.fieldH;
    u[2] = originX;
    u[3] = originY;
    u[4] = surfaceY;
    u[5] = c.iterations;
    u[6] = c.airPropagation;
    u[7] = c.waterPropagation;
    u[8] = c.solidPropagation;
    u[9] = c.waterAbsorption[0];
    u[10] = c.waterAbsorption[1];
    u[11] = c.waterAbsorption[2];
    u[12] = c.ambientSurface[0];
    u[13] = c.ambientSurface[1];
    u[14] = c.ambientSurface[2];
    u[15] = c.ambientDepthFalloff;
    u[16] = this.lightCount;
    u[17] = 0;
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, u as unknown as BufferSource);
  }

  getVolumetricTextureView(): GPUTextureView | null {
    return this.outputView;
  }

  getConfig(): VolumetricLightConfig {
    return this.config;
  }

  compute(encoder: GPUCommandEncoder): void {
    if (this.disabled) return;
    if (!this.injectPipeline || !this.diffusePipeline || !this.gridView ||
        !this.fieldViewA || !this.fieldViewB || !this.uniformBuffer ||
        !this.lightStorageBuffer || !this.bindGroupLayout) {
      return;
    }

    if (this.gridView !== this.prevGridView) {
      this.createBindGroups();
      this.prevGridView = this.gridView;
    }
    if (!this.injectBindGroup || !this.diffuseBindGroupA || !this.diffuseBindGroupB) return;

    // Step 1: Inject ambient + world lights into field A
    const injectPass = encoder.beginRenderPass({
      label: "volumetric-light-inject",
      colorAttachments: [{
        view: this.fieldViewA,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    injectPass.setPipeline(this.injectPipeline);
    injectPass.setBindGroup(0, this.injectBindGroup);
    injectPass.draw(3); // fullscreen triangle
    injectPass.end();

    // Step 2: Diffuse — ping-pong between A and B for N iterations
    const N = this.config.iterations;
    let srcIsA = true;
    for (let i = 0; i < N; i++) {
      const bg = srcIsA ? this.diffuseBindGroupA : this.diffuseBindGroupB;
      const dstView = srcIsA ? this.fieldViewB : this.fieldViewA;
      const diffusePass = encoder.beginRenderPass({
        label: `volumetric-light-diffuse-${i}`,
        colorAttachments: [{
          view: dstView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      diffusePass.setPipeline(this.diffusePipeline);
      diffusePass.setBindGroup(0, bg);
      diffusePass.draw(3);
      diffusePass.end();
      srcIsA = !srcIsA;
    }

    this.outputView = (N % 2 === 0) ? this.fieldViewA : this.fieldViewB;
  }

  private createBindGroups(): void {
    if (!this.bindGroupLayout || !this.gridView || !this.fieldViewA ||
        !this.fieldViewB || !this.uniformBuffer || !this.lightStorageBuffer) return;

    // Inject: writes to fieldA. srcField (binding 3) is not used by fs_inject,
    // but we must bind something. Bind fieldB to avoid a read/write conflict.
    this.injectBindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      label: "volumetric-inject",
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.lightStorageBuffer } },
        { binding: 2, resource: this.gridView },
        { binding: 3, resource: this.fieldViewB },
      ],
    });

    // Diffuse A→B: src = fieldA, dst = fieldB
    this.diffuseBindGroupA = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      label: "volumetric-diffuse-a-to-b",
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.lightStorageBuffer } },
        { binding: 2, resource: this.gridView },
        { binding: 3, resource: this.fieldViewA },
      ],
    });

    // Diffuse B→A: src = fieldB, dst = fieldA
    this.diffuseBindGroupB = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      label: "volumetric-diffuse-b-to-a",
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.lightStorageBuffer } },
        { binding: 2, resource: this.gridView },
        { binding: 3, resource: this.fieldViewB },
      ],
    });
  }

  destroy(): void {
    this.fieldTextureA?.destroy();
    this.fieldTextureB?.destroy();
    this.uniformBuffer?.destroy();
    this.lightStorageBuffer?.destroy();
  }
}
