// ============================================================================
// CloudSystem — renders continuous cloud layers as low-poly marching cubes meshes
// Each layer is a single large voxel field sampled from world-space Perlin noise.
// Layers scroll with the player and drift with wind.
// ============================================================================

import { calculateViewProj, DEPTH_FORMAT, MSAA_SAMPLE_COUNT, type CameraState } from "@downdraft/core";
import type { RenderBackend } from "@downdraft/core/render/backend/render-backend.ts";
import type { BackendBindGroup, BackendBindGroupLayout, BackendBuffer, BackendRenderPipeline, TextureFormat } from "@downdraft/core/render/backend/types.ts";
import { WeatherType } from "@downdraft/plugin-weather";
import type { CloudExtractedMesh, CloudMeshProvider, CloudVoxelField } from "./cloud-provider.ts";
import CLOUD_WGSL from "./shaders/cloud.wgsl?raw";


// --- Per-layer state ---
interface CloudLayer {
  layerType: string;
  // GPU buffers
  vertexBuffer: GPUBuffer | BackendBuffer | null;
  indexBuffer: GPUBuffer | BackendBuffer | null;
  indexCount: number;
  useUint32: boolean;
  // Per-layer uniform buffer
  perLayerUniform: GPUBuffer | BackendBuffer;
  bindGroup: GPUBindGroup | BackendBindGroup | null;
  // World position (center of the field)
  centerX: number;
  centerZ: number;
  altitude: number;
  // Wind drift offset (accumulated)
  windOffsetX: number;
  windOffsetZ: number;
  // Status
  generated: boolean;
  // Last generation center
  genCenterX: number;
  genCenterZ: number;
  // Pending regeneration
  pendingRegen: boolean;
}

export class CloudSystem {
  private device: GPUDevice | null;
  private backend: RenderBackend | null;
  private format: GPUTextureFormat | TextureFormat;
  private provider: CloudMeshProvider;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer | null = null;

  // Backend resources
  private _bgPipeline: BackendRenderPipeline | null = null;
  private _bgBindGroupLayout: BackendBindGroupLayout | null = null;
  private _bgUniformBuffer: BackendBuffer | null = null;

  private layers: CloudLayer[] = [];
  private genThisFrame = 0;
  private uniformData = new Float32Array(40);
  private uniformU32View = new Uint32Array(this.uniformData.buffer);
  private perLayerData = new Float32Array(4);

  constructor(device: GPUDevice | null, format: GPUTextureFormat | TextureFormat, provider: CloudMeshProvider, backend?: RenderBackend | null) {
    this.device = device;
    this.backend = backend ?? null;
    this.format = format;
    this.provider = provider;
  }

  async init(): Promise<void> {
    if (this.backend && !this.device) {
      this.initBackend(this.backend);
      return;
    }
    this.uniformBuffer = this.device!.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bindGroupLayout = this.device!.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true } },
      ],
    });

    const pipelineLayout = this.device!.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    const shaderModule = this.device!.createShaderModule({ code: CLOUD_WGSL });

    this.pipeline = this.device!.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
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
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{
          format: this.format as GPUTextureFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
    });

    // Initialize cloud layers from provider
    const layerTypes = this.provider.getLayerTypes();
    for (const layerType of layerTypes) {
      const cfg = this.provider.getLayerConfig(layerType);
      this.layers.push({
        layerType,
        vertexBuffer: null,
        indexBuffer: null,
        indexCount: 0,
        useUint32: false,
        perLayerUniform: this.device!.createBuffer({
          size: 16,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
        bindGroup: null,
        centerX: 0,
        centerZ: 0,
        altitude: cfg.altitude,
        windOffsetX: 0,
        windOffsetZ: 0,
        generated: false,
        genCenterX: 0,
        genCenterZ: 0,
        pendingRegen: true,
      });
    }

    console.log("[CloudSystem] Initialized with", this.layers.length, "layers");
  }

  private initBackend(backend: RenderBackend): void {
    this._bgUniformBuffer = backend.createBuffer({
      size: 256,
      usage: 0x40 | 0x08, // UNIFORM | COPY_DST
    });

    this._bgBindGroupLayout = backend.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 0x3, buffer: { type: "uniform" } },
        { binding: 1, visibility: 0x3, buffer: { type: "uniform", hasDynamicOffset: true } },
      ],
    });

    const pipelineLayout = backend.createPipelineLayout({
      bindGroupLayouts: [this._bgBindGroupLayout],
    });

    const shaderModule = backend.createShaderModule({ wgsl: CLOUD_WGSL }, "wgsl");

    this._bgPipeline = backend.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
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
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{
          format: this.format as any,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: DEPTH_FORMAT as any, depthWriteEnabled: false, depthCompare: "less-equal" },
    });

    const layerTypes = this.provider.getLayerTypes();
    for (const layerType of layerTypes) {
      const cfg = this.provider.getLayerConfig(layerType);
      this.layers.push({
        layerType,
        vertexBuffer: null,
        indexBuffer: null,
        indexCount: 0,
        useUint32: false,
        perLayerUniform: backend.createBuffer({
          size: 16,
          usage: 0x40 | 0x08,
        }),
        bindGroup: null,
        centerX: 0,
        centerZ: 0,
        altitude: cfg.altitude,
        windOffsetX: 0,
        windOffsetZ: 0,
        generated: false,
        genCenterX: 0,
        genCenterZ: 0,
        pendingRegen: true,
      });
    }

    console.log("[CloudSystem] Initialized with", this.layers.length, "layers (backend)");
  }

  update(
    dt: number,
    playerPos: { x: number; y: number; z: number },
    windDirX: number,
    windDirZ: number,
    windSpeed: number,
    weatherType: WeatherType,
  ): void {
    this.genThisFrame = 0;

    for (const layer of this.layers) {
      // Accumulate wind drift
      layer.windOffsetX += windDirX * windSpeed * dt;
      layer.windOffsetZ += windDirZ * windSpeed * dt;

      // Update center to follow player
      layer.centerX = playerPos.x;
      layer.centerZ = playerPos.z;

      // Check if we need to regenerate (player moved too far from last gen center)
      const dx = layer.centerX - layer.genCenterX;
      const dz = layer.centerZ - layer.genCenterZ;
      const distSq = dx * dx + dz * dz;
      const regenDist = this.provider.getRegenDistance();

      if (!layer.generated || distSq > regenDist * regenDist) {
        layer.pendingRegen = true;
      }
    }

    // Process pending layer generation (one at a time for performance)
    this.processPendingGen(weatherType);
  }

  private processPendingGen(weatherType: WeatherType): void {
    const maxPerFrame = this.provider.getMaxLayerGenPerFrame();
    const budgetMs = this.provider.getLayerGenTimeBudgetMs();
    const startTime = performance.now();

    for (const layer of this.layers) {
      if (!layer.pendingRegen) continue;
      if (this.genThisFrame >= maxPerFrame) break;
      if (performance.now() - startTime > budgetMs) break;

      this.generateLayerMesh(layer, weatherType);
      layer.pendingRegen = false;
      layer.generated = true;
      layer.genCenterX = layer.centerX;
      layer.genCenterZ = layer.centerZ;
      this.genThisFrame++;
    }
  }

  private generateLayerMesh(layer: CloudLayer, weatherType: WeatherType): void {
    const field: CloudVoxelField = this.provider.generateLayerField(
      layer.layerType,
      layer.centerX,
      layer.centerZ,
      weatherType,
      layer.windOffsetX,
      layer.windOffsetZ,
    );

    const extracted: CloudExtractedMesh = this.provider.extractMesh(field);
    if (extracted.verts.length === 0 || extracted.indices.length === 0) {
      let minD = Infinity, maxD = -Infinity, solidCount = 0;
      for (let i = 0; i < field.data.length; i++) {
        const v = field.data[i];
        if (v < minD) minD = v;
        if (v > maxD) maxD = v;
        if (v < field.isoLevel) solidCount++;
      }
      console.warn(`[CloudSystem] Empty mesh for layer=${layer.layerType} iso=${field.isoLevel} densityRange=[${minD.toFixed(3)}, ${maxD.toFixed(3)}] solidVoxels=${solidCount}/${field.data.length} (${(solidCount/field.data.length*100).toFixed(1)}%)`);
      return;
    }

    console.log(`[CloudSystem] Generated layer ${layer.layerType}: ${extracted.verts.length / 9} verts, ${extracted.indices.length} indices`);

    // Vertices are in world space relative to field origin (centered at 0,0,0)
    const verts = extracted.verts;

    // Dispose old buffers
    if (layer.vertexBuffer) { layer.vertexBuffer.destroy(); layer.vertexBuffer = null; }
    if (layer.indexBuffer) { layer.indexBuffer.destroy(); layer.indexBuffer = null; }

    // Create vertex buffer
    if (this.backend && !this.device) {
      layer.vertexBuffer = this.backend.createBuffer({
        size: verts.byteLength,
        usage: 0x20 | 0x08, // VERTEX | COPY_DST
      });
      this.backend.queue.writeBuffer(layer.vertexBuffer as any, 0, verts as any);
    } else {
      layer.vertexBuffer = this.device!.createBuffer({
        size: verts.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.device!.queue.writeBuffer(layer.vertexBuffer, 0, verts as any);
    }

    // Create index buffer
    const indexBuf = extracted.indices;
    let indexData: Uint16Array | Uint32Array;
    if (!extracted.useUint32 && indexBuf instanceof Uint16Array && indexBuf.length % 2 !== 0) {
      indexData = new Uint16Array(indexBuf.length + 1);
      indexData.set(indexBuf);
    } else {
      indexData = indexBuf as Uint16Array | Uint32Array;
    }

    if (this.backend && !this.device) {
      layer.indexBuffer = this.backend.createBuffer({
        size: indexData.byteLength,
        usage: 0x10 | 0x08, // INDEX | COPY_DST
      });
      this.backend.queue.writeBuffer(layer.indexBuffer as any, 0, indexData as any);
    } else {
      layer.indexBuffer = this.device!.createBuffer({
        size: indexData.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      this.device!.queue.writeBuffer(layer.indexBuffer, 0, indexData as any);
    }

    layer.indexCount = indexBuf.length;
    layer.useUint32 = extracted.useUint32;

    // Create bind group
    if (this.backend && !this.device) {
      layer.bindGroup = this.backend.createBindGroup({
        layout: this._bgBindGroupLayout!,
        entries: [
          { binding: 0, resource: { buffer: this._bgUniformBuffer! } },
          { binding: 1, resource: { buffer: layer.perLayerUniform as BackendBuffer, size: 16 } },
        ],
      });
    } else {
      layer.bindGroup = this.device!.createBindGroup({
        layout: this.bindGroupLayout!,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer! } },
          { binding: 1, resource: { buffer: layer.perLayerUniform as GPUBuffer, size: 16 } },
        ],
      });
    }
  }

  render(
    passEncoder: GPURenderPassEncoder | any,
    camera: CameraState,
    timeOfDay: number,
    weatherType: WeatherType,
    _windSpeed: number,
    _windDirX: number,
    _windDirZ: number,
    elapsedTime: number,
    _playerPos: { x: number; y: number; z: number },
    sunDir: [number, number, number],
    sunIntensity: number,
    moonDir: [number, number, number],
    moonIntensity: number,
    fogColor: [number, number, number],
    fogDensity: number,
  ): void {
    const isBackend = !!this._bgPipeline;
    if (isBackend ? !this._bgPipeline : (!this.pipeline || !this.uniformBuffer)) return;

    const viewProj = calculateViewProj(camera);

    // Write main uniforms (same layout as before)
    const uniforms = this.uniformData;
    for (let i = 0; i < 16; i++) uniforms[i] = viewProj[i];
    uniforms[16] = camera.position[0];
    uniforms[17] = camera.position[1];
    uniforms[18] = camera.position[2];
    uniforms[19] = timeOfDay;
    this.uniformU32View[20] = weatherType;
    uniforms[24] = sunDir[0];
    uniforms[25] = sunDir[1];
    uniforms[26] = sunDir[2];
    uniforms[27] = sunIntensity;
    uniforms[28] = moonDir[0];
    uniforms[29] = moonDir[1];
    uniforms[30] = moonDir[2];
    uniforms[31] = moonIntensity;
    uniforms[32] = elapsedTime;
    uniforms[33] = 1.0;
    uniforms[36] = fogColor[0];
    uniforms[37] = fogColor[1];
    uniforms[38] = fogColor[2];
    uniforms[39] = fogDensity;

    const queue = this.device?.queue ?? this.backend?.queue;
    const uniformBuf = this.uniformBuffer ?? this._bgUniformBuffer;
    if (queue && uniformBuf) {
      queue.writeBuffer(uniformBuf as any, 0, uniforms as any);
    }

    passEncoder.setPipeline(isBackend ? this._bgPipeline : this.pipeline);

    for (const layer of this.layers) {
      if (!layer.generated || !layer.vertexBuffer || !layer.indexBuffer || !layer.bindGroup) continue;
      if (layer.indexCount === 0) continue;

      const perLayerData = this.perLayerData;
      perLayerData[0] = layer.genCenterX - layer.windOffsetX;
      perLayerData[1] = layer.altitude;
      perLayerData[2] = layer.genCenterZ - layer.windOffsetZ;
      perLayerData[3] = 0;
      if (queue) {
        queue.writeBuffer(layer.perLayerUniform as any, 0, perLayerData);
      }

      passEncoder.setBindGroup(0, layer.bindGroup, [0]);
      passEncoder.setVertexBuffer(0, layer.vertexBuffer as any);
      passEncoder.setIndexBuffer(layer.indexBuffer as any, layer.useUint32 ? "uint32" : "uint16");
      passEncoder.drawIndexed(layer.indexCount);
    }
  }

  destroy(): void {
    for (const layer of this.layers) {
      if (layer.vertexBuffer) { layer.vertexBuffer.destroy(); layer.vertexBuffer = null; }
      if (layer.indexBuffer) { layer.indexBuffer.destroy(); layer.indexBuffer = null; }
      layer.perLayerUniform.destroy();
    }
    if (this.uniformBuffer) {
      this.uniformBuffer.destroy();
      this.uniformBuffer = null;
    }
  }
}
