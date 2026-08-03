// ============================================================================
// CloudSystem — renders 3 continuous cloud layers as low-poly marching cubes meshes
// Each layer is a single large voxel field sampled from world-space Perlin noise.
// Layers scroll with the player and drift with wind.
// ============================================================================

import { DEPTH_FORMAT, MSAA_SAMPLE_COUNT, calculateViewProj } from "@downdraft/core";
import { ExtractedMesh } from "@downdraft/plugin-marching-cubes";
import {
    CLOUD_CONFIG,
    CloudLayerType,
    generateCloudLayerField,
} from "@shared/cloud-generator";
import { extractCloudMesh } from "@shared/marching-cubes";
import { WeatherType } from "@shared/types";
import { CameraState } from "./camera-system";

// --- WGSL Shader ---
const CLOUD_WGSL = /* wgsl */ `
struct CloudUniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  timeOfDay: f32,
  weatherType: u32,
  sunDir: vec3<f32>,
  sunIntensity: f32,
  moonDir: vec3<f32>,
  moonIntensity: f32,
  time: f32,
  weatherBlend: f32,
  fogColor: vec3<f32>,
  fogDensity: f32,
};

@group(0) @binding(0) var<uniform> uniforms: CloudUniforms;

struct PerLayerUniforms {
  layerPos: vec3<f32>,
  _pad: f32,
};

@group(0) @binding(1) var<uniform> perLayer: PerLayerUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec3<f32>,
  @location(3) viewDist: f32,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = input.position + perLayer.layerPos;
  output.worldPos = worldPos;
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  output.normal = input.normal;
  output.color = input.color;
  output.viewDist = length(uniforms.cameraPos - worldPos);
  return output;
}

fn weatherTint(weather: u32) -> vec3<f32> {
  if (weather == 0u) { return vec3<f32>(1.0, 1.0, 1.0); }
  if (weather == 1u) { return vec3<f32>(1.0, 1.0, 1.0); }
  if (weather == 2u) { return vec3<f32>(0.7, 0.7, 0.72); }
  if (weather == 3u) { return vec3<f32>(0.55, 0.55, 0.58); }
  if (weather == 4u) { return vec3<f32>(0.25, 0.25, 0.30); }
  if (weather == 5u) { return vec3<f32>(0.6, 0.6, 0.62); }
  if (weather == 8u) { return vec3<f32>(0.4, 0.15, 0.08); }
  if (weather == 9u) { return vec3<f32>(0.85, 0.88, 0.92); }
  return vec3<f32>(1.0, 1.0, 1.0);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let N = normalize(input.normal);
  let baseColor = input.color;

  let sunDir = normalize(uniforms.sunDir);
  let moonDir = normalize(uniforms.moonDir);
  let sunNdotL = max(dot(N, sunDir), 0.0);
  let moonNdotL = max(dot(N, moonDir), 0.0);

  let dayFactor = smoothstep(0.2, 0.4, uniforms.timeOfDay) * (1.0 - smoothstep(0.65, 0.8, uniforms.timeOfDay));
  let sunsetFactor = smoothstep(0.15, 0.25, uniforms.timeOfDay) * (1.0 - smoothstep(0.25, 0.35, uniforms.timeOfDay))
    + smoothstep(0.65, 0.75, uniforms.timeOfDay) * (1.0 - smoothstep(0.75, 0.85, uniforms.timeOfDay));

  let sunColor = mix(vec3<f32>(1.0, 0.6, 0.3), vec3<f32>(1.0, 0.97, 0.9), dayFactor);
  let moonColor = vec3<f32>(0.7, 0.7, 0.75);

  let sunLight = sunColor * sunNdotL * uniforms.sunIntensity;
  let moonLight = moonColor * moonNdotL * uniforms.moonIntensity;
  let ambient = vec3<f32>(0.45, 0.45, 0.47) * (0.4 + dayFactor * 0.4);

  // Bounce light for underside
  let bottomFactor = max(-N.y, 0.0);
  let bounceColor = mix(vec3<f32>(0.8, 0.82, 0.85), vec3<f32>(1.0, 0.9, 0.75), dayFactor);
  let bounce = bounceColor * bottomFactor * (0.3 + dayFactor * 0.3);

  var litColor = baseColor * (sunLight + moonLight + ambient + bounce);

  // Sunset tint
  litColor = mix(litColor, litColor * vec3<f32>(1.0, 0.6, 0.4), sunsetFactor * 0.4);

  // Weather tinting
  let tint = weatherTint(uniforms.weatherType);
  litColor = mix(litColor, litColor * tint, 0.5);

  // Soft alpha
  let V = normalize(uniforms.cameraPos - input.worldPos);
  let NdotV = max(dot(N, V), 0.0);
  let edgeAlpha = smoothstep(0.0, 0.15, NdotV);
  let distFade = 1.0 - smoothstep(2000.0, 4000.0, input.viewDist);
  let baseAlpha = 0.65 + 0.3 * NdotV;
  let alpha = baseAlpha * edgeAlpha * distFade;

  // Distance fog
  let fogFactor = 1.0 - exp(-uniforms.fogDensity * input.viewDist);
  litColor = mix(litColor, uniforms.fogColor, fogFactor * 0.5);

  return vec4<f32>(litColor, alpha);
}
`;

// --- Per-layer state ---
interface CloudLayer {
  layerType: CloudLayerType;
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

const LAYER_ORDER: CloudLayerType[] = ["stratus"];

export class CloudSystem {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer | null = null;

  private layers: CloudLayer[] = [];
  private genThisFrame = 0;
  private uniformData = new Float32Array(40);
  private uniformU32View = new Uint32Array(this.uniformData.buffer);
  private perLayerData = new Float32Array(4);

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  async init(): Promise<void> {
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

    // Initialize 3 cloud layers
    for (const layerType of LAYER_ORDER) {
      const cfg = CLOUD_CONFIG.layers[layerType];
      this.layers.push({
        layerType,
        vertexBuffer: null,
        indexBuffer: null,
        indexCount: 0,
        useUint32: false,
        perLayerUniform: this.device.createBuffer({
          size: 16, // vec3 + f32 = 4 floats = 16 bytes
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
      const regenDist = CLOUD_CONFIG.regenDistance;

      if (!layer.generated || distSq > regenDist * regenDist) {
        layer.pendingRegen = true;
      }
    }

    // Process pending layer generation (one at a time for performance)
    this.processPendingGen(weatherType);
  }

  private processPendingGen(weatherType: WeatherType): void {
    const maxPerFrame = CLOUD_CONFIG.maxLayerGenPerFrame;
    const budgetMs = CLOUD_CONFIG.layerGenTimeBudgetMs;
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
    const field = generateCloudLayerField(
      layer.layerType,
      layer.centerX,
      layer.centerZ,
      weatherType,
      layer.windOffsetX,
      layer.windOffsetZ,
    );

    const extracted: ExtractedMesh = extractCloudMesh(field);
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
    passEncoder: GPURenderPassEncoder,
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
    if (!this.pipeline || !this.uniformBuffer) return;

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

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms as unknown as BufferSource);

    passEncoder.setPipeline(this.pipeline);

    for (const layer of this.layers) {
      if (!layer.generated || !layer.vertexBuffer || !layer.indexBuffer || !layer.bindGroup) continue;
      if (layer.indexCount === 0) continue;

      // Per-layer uniform: world position of the field center
      // The mesh vertices are relative to field origin, so we offset by (centerX, altitude, centerZ)
      // minus the wind offset that was baked into the field at generation time
      const perLayerData = this.perLayerData;
      perLayerData[0] = layer.genCenterX - layer.windOffsetX;
      perLayerData[1] = layer.altitude;
      perLayerData[2] = layer.genCenterZ - layer.windOffsetZ;
      perLayerData[3] = 0;
      this.device.queue.writeBuffer(layer.perLayerUniform, 0, perLayerData);

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
    }
    if (this.uniformBuffer) {
      this.uniformBuffer.destroy();
      this.uniformBuffer = null;
    }
  }
}
