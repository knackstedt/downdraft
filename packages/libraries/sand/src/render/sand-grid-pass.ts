// ============================================================================
// SandGridPass — shared render pass for sand-grid games.
//
// Generalized from the three per-game copies (falling-sand, mining-rpg,
// sandjongg). Renders one or more r32uint grid textures to the canvas using
// the material palette + props textures.
//
// Configurable features:
//   - numLayers > 1: per-layer grid textures + offscreen reflection targets
//     (layer i's offscreen target is sampled by layer i+1 — falling-sand)
//   - camera: adds a camera uniform (offset/zoom/canvas/depth) at binding 5
//     (mining-rpg)
//   - extraTextures: extra float textures bound after the camera binding
//     (light accumulation / volumetric — mining-rpg)
//
// The fragment shader is game-provided — each game's sand-render.wgsl
// declares the bindings it uses.
// ============================================================================

import { createValidatedShaderModule, FULLSCREEN_VS } from "@downdraft/core";
import { buildMaterialProps, buildPalette, PALETTE_SIZE, SHADES_PER_MATERIAL } from "../palette";

export interface SandGridPassConfig {
  device: GPUDevice;
  /** Canvas/present texture format. */
  format: GPUTextureFormat;
  gridW: number;
  gridH: number;
  /** Fragment shader WGSL — appended after FULLSCREEN_VS. */
  fragmentShader: string;
  /** Grid layers. >1 creates offscreen reflection targets. Default: 1. */
  numLayers?: number;
  /** Adds a 32B camera uniform at binding 5 + updateCamera(). Default: false. */
  camera?: boolean;
  /** Extra float-sample textures after the camera binding (or binding 5 when
   *  camera is off). Set per-frame via setExtraTexture(). Default: 0. */
  extraTextures?: number;
}

const EXTRA_TEXTURE_BASE = 6; // bindings 0-5: grid/palette/props/behind/uniform/camera

export class SandGridPass {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private fragmentShader: string;
  private readonly cameraEnabled: boolean;
  private readonly extraTextureCount: number;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private bindGroups: (GPUBindGroup | null)[] = [];
  private uniformBuffer: GPUBuffer | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  private gridTextures: (GPUTexture | null)[] = [];
  private gridViews: (GPUTextureView | null)[] = [];
  private paletteTexture: GPUTexture | null = null;
  private paletteView: GPUTextureView | null = null;
  private propsTexture: GPUTexture | null = null;
  private propsView: GPUTextureView | null = null;
  // Offscreen targets: one per layer (except the frontmost).
  // Layer i's offscreen target is sampled by layer i+1 for reflections.
  private offscreenTargets: (GPUTexture | null)[] = [];
  private offscreenViews: (GPUTextureView | null)[] = [];
  // 1×1 dummy texture for unbound slots (backmost layer's behind, extra textures)
  private dummyTexture: GPUTexture | null = null;
  private dummyView: GPUTextureView | null = null;
  // Extra texture views (light accumulation, volumetric, ...) set per frame.
  private extraViews: (GPUTextureView | null)[] = [];
  private uniformBuf: Float32Array = new Float32Array(4);
  gridW: number;
  gridH: number;
  numLayers: number;

  constructor(config: SandGridPassConfig) {
    this.device = config.device;
    this.format = config.format;
    this.fragmentShader = config.fragmentShader;
    this.gridW = config.gridW;
    this.gridH = config.gridH;
    this.numLayers = config.numLayers ?? 1;
    this.cameraEnabled = config.camera ?? false;
    this.extraTextureCount = config.extraTextures ?? 0;
    this.bindGroups = new Array(this.numLayers).fill(null);
    this.gridTextures = new Array(this.numLayers).fill(null);
    this.gridViews = new Array(this.numLayers).fill(null);
    this.offscreenTargets = new Array(this.numLayers).fill(null);
    this.offscreenViews = new Array(this.numLayers).fill(null);
    this.extraViews = new Array(this.extraTextureCount).fill(null);
  }

  init(canvasW = 1, canvasH = 1): void {
    this.uniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    if (this.cameraEnabled) {
      // 32 bytes = 8 floats (WebGPU requires 16-byte alignment)
      this.cameraBuffer = this.device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }

    // 1×1 dummy texture for unbound texture slots
    this.dummyTexture = this.device.createTexture({
      size: [1, 1],
      format: this.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.dummyView = this.dummyTexture.createView();
    // Clear it to black
    this.device.queue.writeTexture(
      { texture: this.dummyTexture },
      new Uint8Array([0, 0, 0, 0]),
      { bytesPerRow: 4, rowsPerImage: 1 },
      [1, 1],
    );

    for (let i = 0; i < this.numLayers; i++) {
      this.createGridTexture(i);
      // Only create offscreen targets for layers that will be reflected (all but the frontmost)
      if (i < this.numLayers - 1) {
        this.createOffscreenTarget(i, canvasW, canvasH);
      }
    }

    const pal = buildPalette();
    const palW = PALETTE_SIZE * SHADES_PER_MATERIAL;
    this.paletteTexture = this.device.createTexture({
      size: [palW, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.paletteView = this.paletteTexture.createView();
    this.device.queue.writeTexture(
      { texture: this.paletteTexture },
      pal as unknown as BufferSource,
      { bytesPerRow: palW * 4, rowsPerImage: 1 },
      [palW, 1],
    );

    const props = buildMaterialProps();
    this.propsTexture = this.device.createTexture({
      size: [PALETTE_SIZE, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.propsView = this.propsTexture.createView();
    this.device.queue.writeTexture(
      { texture: this.propsTexture },
      props as unknown as BufferSource,
      { bytesPerRow: PALETTE_SIZE * 4, rowsPerImage: 1 },
      [PALETTE_SIZE, 1],
    );

    const entries: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ];
    if (this.cameraEnabled) {
      entries.push({ binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } });
    }
    for (let i = 0; i < this.extraTextureCount; i++) {
      entries.push({
        binding: EXTRA_TEXTURE_BASE + i,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float" },
      });
    }
    this.bindGroupLayout = this.device.createBindGroupLayout({ entries });

    const shader = createValidatedShaderModule(this.device, { code: FULLSCREEN_VS + "\n" + this.fragmentShader, label: "SandGridPass" });
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
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
    });

    for (let i = 0; i < this.numLayers; i++) {
      this.createBindGroup(i);
    }
    this.updateUniforms();
    if (this.cameraEnabled) {
      this.updateCamera(0, 0, 4, canvasW, canvasH);
    }
  }

  private createGridTexture(layer: number): void {
    this.gridTextures[layer]?.destroy();
    const tex = this.device.createTexture({
      size: [this.gridW, this.gridH],
      format: "r32uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.gridTextures[layer] = tex;
    this.gridViews[layer] = tex.createView();
  }

  private createOffscreenTarget(layer: number, w: number, h: number): void {
    this.offscreenTargets[layer]?.destroy();
    const tex = this.device.createTexture({
      size: [w, h],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.offscreenTargets[layer] = tex;
    this.offscreenViews[layer] = tex.createView();
  }

  private createBindGroup(layer: number): void {
    if (!this.bindGroupLayout || !this.gridViews[layer] || !this.paletteView || !this.propsView || !this.uniformBuffer) return;
    // Layer 0 uses the 1×1 dummy; layer i uses layer i-1's offscreen target
    const behindView = layer > 0 ? (this.offscreenViews[layer - 1] ?? this.dummyView) : this.dummyView;
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: this.gridViews[layer]! },
      { binding: 1, resource: this.paletteView },
      { binding: 2, resource: this.propsView },
      { binding: 3, resource: behindView! },
      { binding: 4, resource: { buffer: this.uniformBuffer } },
    ];
    if (this.cameraEnabled) {
      entries.push({ binding: 5, resource: { buffer: this.cameraBuffer! } });
    }
    for (let i = 0; i < this.extraTextureCount; i++) {
      entries.push({
        binding: EXTRA_TEXTURE_BASE + i,
        resource: this.extraViews[i] ?? this.dummyView!,
      });
    }
    this.bindGroups[layer] = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries,
    });
  }

  /** Get the grid texture view for a layer (e.g. shared with compute passes). */
  getGridView(layer = 0): GPUTextureView | null {
    return this.gridViews[layer] ?? null;
  }

  /** Set an extra texture view (light accumulation, volumetric, ...). */
  setExtraTexture(slot: number, view: GPUTextureView | null): void {
    if (slot < 0 || slot >= this.extraTextureCount) return;
    if (this.extraViews[slot] === view) return;
    this.extraViews[slot] = view;
    for (let i = 0; i < this.numLayers; i++) this.createBindGroup(i);
  }

  /** Recreate grid textures (+ offscreen targets when canvas dims are given). */
  resize(gridW: number, gridH: number, canvasW?: number, canvasH?: number): void {
    this.gridW = gridW;
    this.gridH = gridH;
    for (let i = 0; i < this.numLayers; i++) {
      this.createGridTexture(i);
      if (canvasW !== undefined && canvasH !== undefined && i < this.numLayers - 1) {
        this.createOffscreenTarget(i, canvasW, canvasH);
      }
      this.createBindGroup(i);
    }
  }

  updateGrid(grid: Uint32Array, layer = 0): void {
    if (!this.gridTextures[layer]) return;
    this.device.queue.writeTexture(
      { texture: this.gridTextures[layer]! },
      grid.buffer as BufferSource,
      { offset: grid.byteOffset, bytesPerRow: this.gridW * 4, rowsPerImage: this.gridH },
      [this.gridW, this.gridH],
    );
  }

  updateUniforms(): void {
    this.uniformBuf[0] = this.gridW;
    this.uniformBuf[1] = this.gridH;
    this.uniformBuf[2] = performance.now() / 1000;
    this.uniformBuf[3] = 1.0;
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, this.uniformBuf as unknown as BufferSource);
  }

  /** Camera uniforms — only when `camera: true`. */
  updateCamera(camX: number, camY: number, zoom: number, canvasW: number, canvasH: number, depth: number = 0): void {
    if (!this.cameraBuffer) return;
    const u = new Float32Array([camX, camY, zoom, canvasW, canvasH, depth, 0, 0]);
    this.device.queue.writeBuffer(this.cameraBuffer, 0, u);
  }

  /** A layer's offscreen reflection target view (multi-layer configs only). */
  getOffscreenView(layer: number): GPUTextureView | null {
    return this.offscreenViews[layer];
  }

  render(pass: GPURenderPassEncoder, layer = 0): void {
    if (!this.pipeline || !this.bindGroups[layer]) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroups[layer]);
    pass.draw(3);
  }

  destroy(): void {
    for (const t of this.gridTextures) t?.destroy();
    for (const t of this.offscreenTargets) t?.destroy();
    this.paletteTexture?.destroy();
    this.propsTexture?.destroy();
    this.dummyTexture?.destroy();
    this.uniformBuffer?.destroy();
    this.cameraBuffer?.destroy();
    this.pipeline = null;
    this.bindGroups.fill(null);
  }
}
