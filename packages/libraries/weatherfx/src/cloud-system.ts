// ============================================================================
// CloudSystem — renders continuous cloud layers as low-poly marching cubes meshes
// Each layer is a single large voxel field sampled from world-space Perlin noise.
// Layers scroll with the player and drift with wind.
// ============================================================================

import { calculateViewProj, createLogger, DEPTH_FORMAT, MSAA_SAMPLE_COUNT, type CameraState } from "@downdraft/core";
import { WeatherType } from "@downdraft/library-weather";
import { StructView, wgsl } from "@downdraft/shader-graph";
import type { CloudExtractedMesh, CloudMeshProvider, CloudVoxelField } from "./cloud-provider";
import CLOUD_WGSL from "./shaders/cloud.wgsl?raw";

const log = createLogger();

// --- Typed uniform structs (validate against cloud.wgsl) ---
export const CloudUniformsStruct = wgsl.struct("CloudUniforms", {
  viewProj: wgsl.mat4x4f,
  cameraPos: wgsl.vec3f,
  timeOfDay: wgsl.f32,
  weatherType: wgsl.u32,
  sunDir: wgsl.vec3f,
  sunIntensity: wgsl.f32,
  moonDir: wgsl.vec3f,
  moonIntensity: wgsl.f32,
  time: wgsl.f32,
  weatherBlend: wgsl.f32,
  fogColor: wgsl.vec3f,
  fogDensity: wgsl.f32,
});

export const PerLayerUniformsStruct = wgsl.struct("PerLayerUniforms", {
  layerPos: wgsl.vec3f,
  _pad: wgsl.f32,
});


// --- Per-layer state ---
interface CloudLayer {
  layerType: string;
  // GPU buffers
  vertexBuffer: GPUBuffer | null;
  indexBuffer: GPUBuffer | null;
  indexCount: number;
  useUint32: boolean;
  // Per-layer uniform buffer
  perLayerUniform: GPUBuffer;
  bindGroup: GPUBindGroup | null;
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
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private provider: CloudMeshProvider;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer | null = null;

  private layers: CloudLayer[] = [];
  private genThisFrame = 0;
  private _uniformView: StructView | null = null;
  private _uniformBuf: Float32Array | null = null;
  private _perLayerView: StructView | null = null;
  private _perLayerBuf: Float32Array | null = null;

  constructor(device: GPUDevice, format: GPUTextureFormat, provider: CloudMeshProvider) {
    this.device = device;
    this.format = format;
    this.provider = provider;
  }

  async init(): Promise<void> {
    this._uniformBuf = new Float32Array(CloudUniformsStruct.floatCount);
    this._uniformView = CloudUniformsStruct.view(this._uniformBuf);
    this._perLayerBuf = new Float32Array(PerLayerUniformsStruct.floatCount);
    this._perLayerView = PerLayerUniformsStruct.view(this._perLayerBuf);

    this.uniformBuffer = this.device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true } },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    const shaderModule = this.device.createShaderModule({ code: CLOUD_WGSL });

    this.pipeline = this.device.createRenderPipeline({
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
          format: this.format,
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
        perLayerUniform: this.device.createBuffer({
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

    log.info("CloudSystem", `Initialized with ${this.layers.length} layers`);
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

    log.info("CloudSystem", `Generated layer ${layer.layerType}: ${extracted.verts.length / 9} verts, ${extracted.indices.length} indices`);

    // Vertices are in world space relative to field origin (centered at 0,0,0)
    const verts = extracted.verts;

    // Dispose old buffers
    if (layer.vertexBuffer) { layer.vertexBuffer.destroy(); layer.vertexBuffer = null; }
    if (layer.indexBuffer) { layer.indexBuffer.destroy(); layer.indexBuffer = null; }

    // Create vertex buffer
    layer.vertexBuffer = this.device.createBuffer({
      size: verts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(layer.vertexBuffer, 0, verts as any);

    // Create index buffer
    const indexBuf = extracted.indices;
    let indexData: Uint16Array | Uint32Array;
    if (!extracted.useUint32 && indexBuf instanceof Uint16Array && indexBuf.length % 2 !== 0) {
      indexData = new Uint16Array(indexBuf.length + 1);
      indexData.set(indexBuf);
    } else {
      indexData = indexBuf as Uint16Array | Uint32Array;
    }

    layer.indexBuffer = this.device.createBuffer({
      size: indexData.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(layer.indexBuffer, 0, indexData as any);

    layer.indexCount = indexBuf.length;
    layer.useUint32 = extracted.useUint32;

    // Create bind group
    layer.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer! } },
        { binding: 1, resource: { buffer: layer.perLayerUniform, size: 16 } },
      ],
    });
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
    if (!this.pipeline || !this.uniformBuffer || !this._uniformView || !this._uniformBuf) return;

    const viewProj = calculateViewProj(camera);
    const v = this._uniformView;

    // Write main uniforms via typed view
    v.set("viewProj", viewProj);
    v.set("cameraPos", camera.position);
    v.set("timeOfDay", timeOfDay);
    v.setU32("weatherType", weatherType);
    v.set("sunDir", sunDir);
    v.set("sunIntensity", sunIntensity);
    v.set("moonDir", moonDir);
    v.set("moonIntensity", moonIntensity);
    v.set("time", elapsedTime);
    v.set("weatherBlend", 1.0);
    v.set("fogColor", fogColor);
    v.set("fogDensity", fogDensity);

    this.device.queue.writeBuffer(this.uniformBuffer, 0, this._uniformBuf as any);

    passEncoder.setPipeline(this.pipeline);

    for (const layer of this.layers) {
      if (!layer.generated || !layer.vertexBuffer || !layer.indexBuffer || !layer.bindGroup) continue;
      if (layer.indexCount === 0) continue;

      if (!this._perLayerView || !this._perLayerBuf) continue;
      const pv = this._perLayerView;
      pv.set("layerPos", [layer.genCenterX - layer.windOffsetX, layer.altitude, layer.genCenterZ - layer.windOffsetZ]);
      pv.set("_pad", 0);
      this.device.queue.writeBuffer(layer.perLayerUniform, 0, this._perLayerBuf as any);

      passEncoder.setBindGroup(0, layer.bindGroup, [0]);
      passEncoder.setVertexBuffer(0, layer.vertexBuffer);
      passEncoder.setIndexBuffer(layer.indexBuffer, layer.useUint32 ? "uint32" : "uint16");
      passEncoder.drawIndexed(layer.indexCount);
    }
  }

  destroy(): void {
    for (const layer of this.layers) {
      if (layer.vertexBuffer) { layer.vertexBuffer.destroy(); layer.vertexBuffer = null; }
      if (layer.indexBuffer) { layer.indexBuffer.destroy(); layer.indexBuffer = null; }
      layer.perLayerUniform.destroy();
      // GPUBindGroup has no destroy() — just null it.
      layer.bindGroup = null;
    }
    if (this.uniformBuffer) {
      this.uniformBuffer.destroy();
      this.uniformBuffer = null;
    }
    this.pipeline?.destroy();
    this.pipeline = null;
    // GPUBindGroupLayout has no destroy() — just null it.
    this.bindGroupLayout = null;
    this._uniformView = null;
    this._uniformBuf = null;
    this._perLayerView = null;
    this._perLayerBuf = null;
  }
}
