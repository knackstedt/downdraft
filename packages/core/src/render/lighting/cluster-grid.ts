import { mat4, vec3, type Mat4, type Vec3 } from "wgpu-matrix";
import type { RenderBackend } from "../backend/render-backend.ts";
import type { BackendBuffer, BackendBindGroup, BackendBindGroupLayout, BackendShaderModule, BackendRenderPipeline } from "../backend/types.ts";
import { SHADER_STAGE_COMPUTE, SHADER_STAGE_FRAGMENT } from "../backend/types.ts";
import { wgslShader } from "../backend/shader-source.ts";
import {
  CLUSTER_GRID_ENTRY_SIZE,
  computeClusterCount,
  computeLightDataBufferSize,
  computeLightIndexListSize,
  type ClusterGridConfig,
  type ClusterUniforms,
  LIGHT_DATA_SIZE,
  packClusterUniforms,
} from "./cluster-types.ts";

const CLUSTER_BUILD_SHADER = /* wgsl */ `
struct ClusterUniforms {
  clusterDims: vec3<u32>,
  screenWidth: f32,
  screenHeight: f32,
  nearPlane: f32,
  farPlane: f32,
  numLights: u32,
  _pad: u32,
};

struct LightData {
  position: vec4<f32>,
  color: vec4<f32>,
  direction: vec4<f32>,
  params: vec4<f32>,
};

struct ClusterEntry {
  offset: u32,
  count: u32,
};

@group(0) @binding(0) var<uniform> uniforms: ClusterUniforms;
@group(0) @binding(1) var<storage> lightData: array<LightData>;
@group(0) @binding(2) var<storage, read_write> lightGrid: array<ClusterEntry>;
@group(0) @binding(3) var<storage, read_write> lightIndexList: array<u32>;

fn logDepth(near: f32, far: f32, slice: f32, numSlices: f32) -> f32 {
  return near * pow(far / near, slice / numSlices);
}

fn screenToView(uv: vec2<f32>, screenW: f32, screenH: f32) -> vec2<f32> {
  let ndc = uv * 2.0 - 1.0;
  return vec2<f32>(ndc.x * screenW * 0.5, -ndc.y * screenH * 0.5);
}

fn sphereIntersectsAABB(
  center: vec3<f32>,
  radius: f32,
  minPoint: vec3<f32>,
  maxPoint: vec3<f32>,
) -> bool {
  let closest = clamp(center, minPoint, maxPoint);
  let dist = length(center - closest);
  return dist <= radius;
}

fn coneIntersectsAABB(
  apex: vec3<f32>,
  dir: vec3<f32>,
  range: f32,
  cosHalfAngle: f32,
  minPoint: vec3<f32>,
  maxPoint: vec3<f32>,
) -> bool {
  // Simplified: test sphere at midpoint + radius = range * sin(halfAngle) + range*0.5
  let midPoint = apex + dir * range * 0.5;
  let sphereRadius = range * 0.5 + range * sin(acos(cosHalfAngle));
  return sphereIntersectsAABB(midPoint, sphereRadius, minPoint, maxPoint);
}

@compute @workgroup_size(4, 4, 4)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let clusterDims = uniforms.clusterDims;
  if (gid.x >= clusterDims.x || gid.y >= clusterDims.y || gid.z >= clusterDims.z) {
    return;
  }

  let clusterIdx = gid.x + gid.y * clusterDims.x + gid.z * clusterDims.x * clusterDims.y;

  // Compute cluster AABB in view space
  let tileSizeX = 2.0 / f32(clusterDims.x);
  let tileSizeY = 2.0 / f32(clusterDims.y);

  let minNDC = vec2<f32>(
    f32(gid.x) * tileSizeX - 1.0,
    f32(gid.y) * tileSizeY - 1.0,
  );
  let maxNDC = vec2<f32>(
    (f32(gid.x) + 1.0) * tileSizeX - 1.0,
    (f32(gid.y) + 1.0) * tileSizeY - 1.0,
  );

  let near = uniforms.nearPlane;
  let far = uniforms.farPlane;
  let zNear = logDepth(near, far, f32(gid.z), f32(clusterDims.z));
  let zFar = logDepth(near, far, f32(gid.z + 1.0), f32(clusterDims.z));

  // View-space AABB (approximate using NDC at near plane)
  let minPoint = vec3<f32>(minNDC.x * zNear, -maxNDC.y * zNear, zNear);
  let maxPoint = vec3<f32>(maxNDC.x * zNear, -minNDC.y * zNear, zFar);

  var count = 0u;
  let offset = clusterIdx * ${128}u; // maxLightsPerCluster — will be replaced

  for (var i = 0u; i < uniforms.numLights; i = i + 1u) {
    let light = lightData[i];
    let lightType = u32(light.direction.w);
    let lightRange = light.position.w;

    var intersects = false;
    if (lightType == 0u) {
      // Point light — sphere vs AABB
      intersects = sphereIntersectsAABB(light.position.xyz, lightRange, minPoint, maxPoint);
    } else if (lightType == 1u) {
      // Spot light — cone vs AABB
      let cosAngle = light.params.x;
      intersects = coneIntersectsAABB(
        light.position.xyz,
        light.direction.xyz,
        lightRange,
        cosAngle,
        minPoint,
        maxPoint,
      );
    } else {
      // Rect area light — approximate as sphere
      intersects = sphereIntersectsAABB(light.position.xyz, lightRange, minPoint, maxPoint);
    }

    if (intersects) {
      if (count < ${128}u) {
        lightIndexList[offset + count] = i;
        count = count + 1u;
      }
    }
  }

  lightGrid[clusterIdx] = ClusterEntry(offset, count);
}
`;

export class ClusterGrid {
  private config: ClusterGridConfig;
  private device: GPUDevice | null = null;
  private backend: RenderBackend | null = null;

  private uniformBuffer: GPUBuffer | BackendBuffer | null = null;
  private lightDataBuffer: GPUBuffer | BackendBuffer | null = null;
  private lightGridBuffer: GPUBuffer | BackendBuffer | null = null;
  private lightIndexListBuffer: GPUBuffer | BackendBuffer | null = null;

  private computePipeline: GPUComputePipeline | null = null;
  private computeBindGroup: GPUBindGroup | null = null;

  private _bgComputePipeline: BackendRenderPipeline | null = null;
  private _bgBindGroup: BackendBindGroup | null = null;
  private _bgBindGroupLayout: BackendBindGroupLayout | null = null;
  private _bgShader: BackendShaderModule | null = null;
  private _bgUniformBuffer: BackendBuffer | null = null;
  private _bgLightDataBuffer: BackendBuffer | null = null;
  private _bgLightGridBuffer: BackendBuffer | null = null;
  private _bgLightIndexListBuffer: BackendBuffer | null = null;

  private screenWidth = 1920;
  private screenHeight = 1080;
  private currentLightCount = 0;

  constructor(config: ClusterGridConfig, device?: GPUDevice | null, backend?: RenderBackend | null) {
    this.config = config;
    this.device = device ?? null;
    this.backend = backend ?? null;
  }

  get clusterCount(): number { return computeClusterCount(this.config); }
  get lightDataSize(): number { return computeLightDataBufferSize(this.config); }
  get lightGridSize(): number { return this.clusterCount * CLUSTER_GRID_ENTRY_SIZE; }
  get lightIndexListSize(): number { return computeLightIndexListSize(this.config) * 4; }

  prepare(device: GPUDevice): void {
    this.device = device;
    const clusterCount = this.clusterCount;
    const maxLightsPerCluster = this.config.maxLightsPerCluster;

    this.uniformBuffer = device.createBuffer({
      label: "cluster-uniforms",
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.lightDataBuffer = device.createBuffer({
      label: "cluster-light-data",
      size: this.lightDataSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.lightGridBuffer = device.createBuffer({
      label: "cluster-light-grid",
      size: this.lightGridSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.lightIndexListBuffer = device.createBuffer({
      label: "cluster-light-index-list",
      size: this.lightIndexListSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const shader = device.createShaderModule({
      code: CLUSTER_BUILD_SHADER.replace(/\$\{128\}u/g, `${maxLightsPerCluster}u`),
    });

    this.computePipeline = device.createComputePipeline({
      label: "cluster-build",
      layout: "auto",
      compute: { module: shader, entryPoint: "cs_main" },
    });
  }

  prepareBackend(backend: RenderBackend): void {
    this.backend = backend;
    const maxLightsPerCluster = this.config.maxLightsPerCluster;
    const shaderCode = CLUSTER_BUILD_SHADER.replace(/\$\{128\}u/g, `${maxLightsPerCluster}u`);

    this._bgUniformBuffer = backend.createBuffer({
      label: "cluster-uniforms",
      size: 32,
      usage: 0x40 | 0x08,
    });

    this._bgLightDataBuffer = backend.createBuffer({
      label: "cluster-light-data",
      size: this.lightDataSize,
      usage: 0x80 | 0x08,
    });

    this._bgLightGridBuffer = backend.createBuffer({
      label: "cluster-light-grid",
      size: this.lightGridSize,
      usage: 0x80 | 0x08,
    });

    this._bgLightIndexListBuffer = backend.createBuffer({
      label: "cluster-light-index-list",
      size: this.lightIndexListSize,
      usage: 0x80 | 0x08,
    });

    this._bgBindGroupLayout = backend.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: SHADER_STAGE_COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: SHADER_STAGE_COMPUTE, buffer: { type: "storage", hasDynamicOffset: false } },
        { binding: 2, visibility: SHADER_STAGE_COMPUTE, buffer: { type: "storage", hasDynamicOffset: false } },
        { binding: 3, visibility: SHADER_STAGE_COMPUTE, buffer: { type: "storage", hasDynamicOffset: false } },
      ],
    });

    this._bgShader = backend.createShaderModule(wgslShader(shaderCode, "cluster-build"), "wgsl");
  }

  updateUniforms(screenWidth: number, screenHeight: number, numLights: number): void {
    this.screenWidth = screenWidth;
    this.screenHeight = screenHeight;
    this.currentLightCount = numLights;

    const packed = packClusterUniforms(this.config, screenWidth, screenHeight, numLights);
    const queue = this.device?.queue ?? this.backend?.queue;
    const buf = this.uniformBuffer ?? this._bgUniformBuffer;
    if (queue && buf) {
      queue.writeBuffer(buf as any, 0, packed as unknown as BufferSource);
    }
  }

  updateLightData(lightData: Float32Array): void {
    const queue = this.device?.queue ?? this.backend?.queue;
    const buf = this.lightDataBuffer ?? this._bgLightDataBuffer;
    if (queue && buf) {
      queue.writeBuffer(buf as any, 0, lightData as unknown as BufferSource);
    }
  }

  dispatch(encoder: GPUCommandEncoder | null): void {
    if (this.device && this.computePipeline) {
      if (!this.computeBindGroup) {
        this.computeBindGroup = this.device.createBindGroup({
          layout: this.computePipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.uniformBuffer! } },
            { binding: 1, resource: { buffer: this.lightDataBuffer! } },
            { binding: 2, resource: { buffer: this.lightGridBuffer! } },
            { binding: 3, resource: { buffer: this.lightIndexListBuffer! } },
          ],
        });
      }

      const pass = encoder!.beginComputePass({ label: "cluster-build" });
      pass.setPipeline(this.computePipeline);
      pass.setBindGroup(0, this.computeBindGroup);
      const wx = Math.ceil(this.config.clusterX / 4);
      const wy = Math.ceil(this.config.clusterY / 4);
      const wz = Math.ceil(this.config.clusterZ / 4);
      pass.dispatchWorkgroups(wx, wy, wz);
      pass.end();
    }
  }

  getLightGridBuffer(): GPUBuffer | BackendBuffer | null {
    return this.lightGridBuffer ?? this._bgLightGridBuffer;
  }

  getLightIndexListBuffer(): GPUBuffer | BackendBuffer | null {
    return this.lightIndexListBuffer ?? this._bgLightIndexListBuffer;
  }

  getLightDataBuffer(): GPUBuffer | BackendBuffer | null {
    return this.lightDataBuffer ?? this._bgLightDataBuffer;
  }

  getUniformBuffer(): GPUBuffer | BackendBuffer | null {
    return this.uniformBuffer ?? this._bgUniformBuffer;
  }

  getBindGroupLayout(): GPUBindGroupLayout | BackendBindGroupLayout | null {
    if (this.computePipeline) {
      return this.computePipeline.getBindGroupLayout(0);
    }
    return this._bgBindGroupLayout;
  }

  getConfig(): ClusterGridConfig {
    return this.config;
  }

  destroy(): void {
    if (this.device) {
      (this.uniformBuffer as GPUBuffer)?.destroy();
      (this.lightDataBuffer as GPUBuffer)?.destroy();
      (this.lightGridBuffer as GPUBuffer)?.destroy();
      (this.lightIndexListBuffer as GPUBuffer)?.destroy();
    }
  }
}
