// ============================================================================
// Light System — extends LightingSystem with dynamic point/spot lights
// Uses a read-only storage buffer shared across all entity pipelines.
// ============================================================================

import { calculateViewProj, DEPTH_FORMAT, MSAA_SAMPLE_COUNT, type CameraState } from "@downdraft/core";
import { LightingSystem } from "./lighting-system.ts";

export const MAX_POINT_LIGHTS = 32;
export const MAX_SPOT_LIGHTS = 8;
const CULL_MARGIN = 300; // world units beyond light radius for culling

interface PointLightData {
  pos: [number, number, number];
  color: [number, number, number];
  intensity: number;
  radius: number;
}

interface SpotLightData {
  pos: [number, number, number];
  dir: [number, number, number];
  color: [number, number, number];
  intensity: number;
  radius: number;
  cosInner: number;
  cosOuter: number;
}

export class LightSystem extends LightingSystem {
  private lightStorageBuffer: GPUBuffer | null = null;
  private lightBindGroupLayout: GPUBindGroupLayout | null = null;
  private lightBindGroup: GPUBindGroup | null = null;

  private pointLights: PointLightData[] = [];
  private spotLights: SpotLightData[] = [];
  private pointLightCount = 0;
  private spotLightCount = 0;

  // Pre-allocated light objects to avoid per-frame allocation
  private pointLightPool: PointLightData[] = [];
  private spotLightPool: SpotLightData[] = [];

  // Pre-allocated cull arrays to avoid per-frame allocation
  private culledPointIndices: number[] = [];
  private culledPointDistSq: number[] = [];
  private culledSpotIndices: number[] = [];
  private culledSpotDistSq: number[] = [];

  // Packed data for GPU upload — matches WGSL LightStorage struct layout.
  // Header: 4 floats (16 bytes)
  // PointLight: 8 floats (32 bytes) each × MAX_POINT_LIGHTS
  // SpotLight: 16 floats (64 bytes) each × MAX_SPOT_LIGHTS
  private lightDataArray: Float32Array<ArrayBuffer>;
  private lightDataU32: Uint32Array<ArrayBuffer>;

  // Debug gizmo rendering
  showDebugGizmos = false;
  private debugPipeline: GPURenderPipeline | null = null;
  private debugBindGroupLayout: GPUBindGroupLayout | null = null;
  private debugBindGroup: GPUBindGroup | null = null;
  private debugUniformBuffer: GPUBuffer | null = null;
  private debugSphereVerts: GPUBuffer | null = null;
  private debugSphereIndexCount = 0;
  private debugSphereIndexBuffer: GPUBuffer | null = null;
  private debugInstanceBuffer: GPUBuffer | null = null;
  private debugInstanceData: Float32Array<ArrayBuffer> | null = null;

  constructor(device: GPUDevice) {
    super(device);
    const totalFloats = 4 + MAX_POINT_LIGHTS * 8 + MAX_SPOT_LIGHTS * 16;
    this.lightDataArray = new Float32Array(totalFloats);
    this.lightDataU32 = new Uint32Array(this.lightDataArray.buffer);
  }

  init(): void {
    const totalBytes = this.lightDataArray.byteLength;

    this.lightStorageBuffer = this.device.createBuffer({
      size: totalBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.lightBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "read-only-storage", hasDynamicOffset: false },
        },
      ],
    });

    this.lightBindGroup = this.device.createBindGroup({
      layout: this.lightBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.lightStorageBuffer } }],
    });

    // Zero-initialize the buffer so numPointLights/numSpotLights start at 0
    this.device.queue.writeBuffer(this.lightStorageBuffer, 0, this.lightDataArray);
  }

  getLightBindGroup(): GPUBindGroup | null {
    return this.lightBindGroup;
  }

  getLightBindGroupLayout(): GPUBindGroupLayout | null {
    return this.lightBindGroupLayout;
  }

  beginFrame(): void {
    this.pointLightCount = 0;
    this.spotLightCount = 0;
  }

  addPointLight(
    pos: [number, number, number],
    color: [number, number, number],
    intensity: number,
    radius: number,
  ): void {
    if (this.pointLightCount >= MAX_POINT_LIGHTS) return;
    let light = this.pointLightPool[this.pointLightCount];
    if (!light) {
      light = { pos, color, intensity, radius };
      this.pointLightPool[this.pointLightCount] = light;
    } else {
      light.pos = pos;
      light.color = color;
      light.intensity = intensity;
      light.radius = radius;
    }
    this.pointLights[this.pointLightCount] = light;
    this.pointLightCount++;
  }

  addSpotLight(
    pos: [number, number, number],
    dir: [number, number, number],
    color: [number, number, number],
    intensity: number,
    radius: number,
    cosInner: number,
    cosOuter: number,
  ): void {
    if (this.spotLightCount >= MAX_SPOT_LIGHTS) return;
    let light = this.spotLightPool[this.spotLightCount];
    if (!light) {
      light = { pos, dir, color, intensity, radius, cosInner, cosOuter };
      this.spotLightPool[this.spotLightCount] = light;
    } else {
      light.pos = pos;
      light.dir = dir;
      light.color = color;
      light.intensity = intensity;
      light.radius = radius;
      light.cosInner = cosInner;
      light.cosOuter = cosOuter;
    }
    this.spotLights[this.spotLightCount] = light;
    this.spotLightCount++;
  }

  upload(cameraPos: [number, number, number]): void {
    if (!this.lightStorageBuffer) return;

    // Cull and sort point lights by distance to camera (nearest first)
    const culledIndices = this.culledPointIndices;
    const culledDistSq = this.culledPointDistSq;
    culledIndices.length = 0;
    culledDistSq.length = 0;
    for (let i = 0; i < this.pointLightCount; i++) {
      const pl = this.pointLights[i];
      const dx = pl.pos[0] - cameraPos[0];
      const dy = pl.pos[1] - cameraPos[1];
      const dz = pl.pos[2] - cameraPos[2];
      const distSq = dx * dx + dy * dy + dz * dz;
      const maxDist = pl.radius + CULL_MARGIN;
      if (distSq <= maxDist * maxDist) {
        culledIndices.push(i);
        culledDistSq.push(distSq);
      }
    }
    // Simple insertion sort (small N, avoids sort closure allocation)
    for (let i = 1; i < culledIndices.length; i++) {
      const keyIdx = culledIndices[i];
      const keyDist = culledDistSq[i];
      let j = i - 1;
      while (j >= 0 && culledDistSq[j] > keyDist) {
        culledIndices[j + 1] = culledIndices[j];
        culledDistSq[j + 1] = culledDistSq[j];
        j--;
      }
      culledIndices[j + 1] = keyIdx;
      culledDistSq[j + 1] = keyDist;
    }
    const numPoints = Math.min(culledIndices.length, MAX_POINT_LIGHTS);

    // Cull and sort spot lights
    const culledSpotIdx = this.culledSpotIndices;
    const culledSpotDist = this.culledSpotDistSq;
    culledSpotIdx.length = 0;
    culledSpotDist.length = 0;
    for (let i = 0; i < this.spotLightCount; i++) {
      const sl = this.spotLights[i];
      const dx = sl.pos[0] - cameraPos[0];
      const dy = sl.pos[1] - cameraPos[1];
      const dz = sl.pos[2] - cameraPos[2];
      const distSq = dx * dx + dy * dy + dz * dz;
      const maxDist = sl.radius + CULL_MARGIN;
      if (distSq <= maxDist * maxDist) {
        culledSpotIdx.push(i);
        culledSpotDist.push(distSq);
      }
    }
    for (let i = 1; i < culledSpotIdx.length; i++) {
      const keyIdx = culledSpotIdx[i];
      const keyDist = culledSpotDist[i];
      let j = i - 1;
      while (j >= 0 && culledSpotDist[j] > keyDist) {
        culledSpotIdx[j + 1] = culledSpotIdx[j];
        culledSpotDist[j + 1] = culledSpotDist[j];
        j--;
      }
      culledSpotIdx[j + 1] = keyIdx;
      culledSpotDist[j + 1] = keyDist;
    }
    const numSpots = Math.min(culledSpotIdx.length, MAX_SPOT_LIGHTS);

    // Pack into Float32Array matching WGSL LightStorage struct layout
    const data = this.lightDataArray;
    data.fill(0);

    // Header: numPointLights, numSpotLights, pad, pad (u32 values via Uint32Array view)
    this.lightDataU32[0] = numPoints;
    this.lightDataU32[1] = numSpots;
    this.lightDataU32[2] = 0;
    this.lightDataU32[3] = 0;

    // Point lights: 8 floats each starting at offset 4
    for (let i = 0; i < numPoints; i++) {
      const pl = this.pointLights[culledIndices[i]];
      const off = 4 + i * 8;
      data[off] = pl.pos[0];
      data[off + 1] = pl.pos[1];
      data[off + 2] = pl.pos[2];
      data[off + 3] = pl.radius;
      data[off + 4] = pl.color[0];
      data[off + 5] = pl.color[1];
      data[off + 6] = pl.color[2];
      data[off + 7] = pl.intensity;
    }

    // Spot lights: 16 floats each starting at offset 4 + MAX_POINT_LIGHTS * 8
    const spotBase = 4 + MAX_POINT_LIGHTS * 8;
    for (let i = 0; i < numSpots; i++) {
      const sl = this.spotLights[culledSpotIdx[i]];
      const off = spotBase + i * 16;
      data[off] = sl.pos[0];
      data[off + 1] = sl.pos[1];
      data[off + 2] = sl.pos[2];
      data[off + 3] = sl.radius;
      data[off + 4] = sl.dir[0];
      data[off + 5] = sl.dir[1];
      data[off + 6] = sl.dir[2];
      data[off + 7] = sl.cosInner;
      data[off + 8] = sl.color[0];
      data[off + 9] = sl.color[1];
      data[off + 10] = sl.color[2];
      data[off + 11] = sl.cosOuter;
      data[off + 12] = sl.intensity;
      // off + 13, +14, +15 = padding (already zeroed)
    }

    this.device.queue.writeBuffer(this.lightStorageBuffer, 0, data);
  }

  private readonly MAX_DEBUG_INSTANCES = MAX_POINT_LIGHTS + MAX_SPOT_LIGHTS;

  initDebugGizmos(format: GPUTextureFormat): void {
    // Generate unit sphere wireframe (latitude/longitude lines)
    const latSegments = 8;
    const lonSegments = 16;
    const verts: number[] = [];
    for (let lat = 0; lat <= latSegments; lat++) {
      const theta = (lat / latSegments) * Math.PI;
      const y = Math.cos(theta);
      const r = Math.sin(theta);
      for (let lon = 0; lon <= lonSegments; lon++) {
        const phi = (lon / lonSegments) * Math.PI * 2;
        verts.push(r * Math.cos(phi), y, r * Math.sin(phi));
      }
    }
    const indices: number[] = [];
    // Latitude lines
    for (let lat = 0; lat <= latSegments; lat++) {
      for (let lon = 0; lon < lonSegments; lon++) {
        const i = lat * (lonSegments + 1) + lon;
        indices.push(i, i + 1);
      }
    }
    // Longitude lines
    for (let lon = 0; lon <= lonSegments; lon++) {
      for (let lat = 0; lat < latSegments; lat++) {
        const i = lat * (lonSegments + 1) + lon;
        indices.push(i, i + (lonSegments + 1));
      }
    }
    this.debugSphereIndexCount = indices.length;

    this.debugSphereVerts = this.device.createBuffer({
      size: verts.length * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.debugSphereVerts, 0, new Float32Array(verts));

    this.debugSphereIndexBuffer = this.device.createBuffer({
      size: indices.length * 2,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.debugSphereIndexBuffer, 0, new Uint16Array(indices));

    // Instance buffer: 8 floats per instance (pos.xyz, radius, color.rgb, intensity, _pad)
    const instanceFloats = this.MAX_DEBUG_INSTANCES * 8;
    this.debugInstanceData = new Float32Array(instanceFloats);
    this.debugInstanceBuffer = this.device.createBuffer({
      size: instanceFloats * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    this.debugUniformBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.debugBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      ],
    });

    this.debugBindGroup = this.device.createBindGroup({
      layout: this.debugBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.debugUniformBuffer } }],
    });

    const DEBUG_WGSL = /* wgsl */ `
      struct Uniforms {
        viewProj: mat4x4<f32>,
      };
      @group(0) @binding(0) var<uniform> uniforms: Uniforms;

      struct VertexInput {
        @location(0) position: vec3<f32>,
        @location(1) instancePos: vec3<f32>,
        @location(2) instanceRadius: f32,
        @location(3) instanceColor: vec3<f32>,
      };

      struct VertexOutput {
        @builtin(position) clipPos: vec4<f32>,
        @location(0) color: vec3<f32>,
      };

      @vertex
      fn vs_main(input: VertexInput) -> VertexOutput {
        var output: VertexOutput;
        let worldPos = input.position * input.instanceRadius + input.instancePos;
        output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
        output.color = input.instanceColor;
        return output;
      }

      @fragment
      fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
        return vec4<f32>(input.color, 0.4);
      }
    `;

    const shaderModule = this.device.createShaderModule({ code: DEBUG_WGSL });
    this.debugPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.debugBindGroupLayout] }),
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
          { arrayStride: 32, stepMode: "instance", attributes: [
            { shaderLocation: 1, offset: 0, format: "float32x3" },
            { shaderLocation: 2, offset: 12, format: "float32" },
            { shaderLocation: 3, offset: 16, format: "float32x3" },
          ] },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{ format, blend: {
          color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
          alpha: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
        } }],
      },
      primitive: { topology: "line-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: "less",
      },
    });
  }

  renderDebugGizmos(passEncoder: GPURenderPassEncoder, camera: CameraState): void {
    if (!this.showDebugGizmos || !this.debugPipeline || !this.debugBindGroup || !this.debugUniformBuffer) return;
    if (!this.debugInstanceBuffer || !this.debugInstanceData || !this.debugSphereVerts || !this.debugSphereIndexBuffer) return;

    const viewProj = calculateViewProj(camera);
    this.device.queue.writeBuffer(this.debugUniformBuffer, 0, viewProj as unknown as BufferSource);

    // Collect instances from point lights + spot lights
    const data = this.debugInstanceData;
    data.fill(0);
    let count = 0;
    for (let i = 0; i < this.pointLightCount && count < this.MAX_DEBUG_INSTANCES; i++) {
      const pl = this.pointLights[i];
      const off = count * 8;
      data[off] = pl.pos[0]; data[off + 1] = pl.pos[1]; data[off + 2] = pl.pos[2];
      data[off + 3] = pl.radius;
      data[off + 4] = pl.color[0]; data[off + 5] = pl.color[1]; data[off + 6] = pl.color[2];
      count++;
    }
    for (let i = 0; i < this.spotLightCount && count < this.MAX_DEBUG_INSTANCES; i++) {
      const sl = this.spotLights[i];
      const off = count * 8;
      data[off] = sl.pos[0]; data[off + 1] = sl.pos[1]; data[off + 2] = sl.pos[2];
      data[off + 3] = sl.radius;
      data[off + 4] = sl.color[0]; data[off + 5] = sl.color[1]; data[off + 6] = sl.color[2];
      count++;
    }

    this.device.queue.writeBuffer(this.debugInstanceBuffer, 0, data);

    passEncoder.setPipeline(this.debugPipeline);
    passEncoder.setBindGroup(0, this.debugBindGroup);
    passEncoder.setVertexBuffer(0, this.debugSphereVerts);
    passEncoder.setVertexBuffer(1, this.debugInstanceBuffer);
    passEncoder.setIndexBuffer(this.debugSphereIndexBuffer, "uint16");
    passEncoder.drawIndexed(this.debugSphereIndexCount, count);
  }
}
