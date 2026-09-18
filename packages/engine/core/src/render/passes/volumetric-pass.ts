import { createValidatedShaderModule } from "../shader-validator";
import type { WgslStruct } from "@downdraft/engine/shader-graph";
import { f32, mat4x4f, u32, vec3f, vec3u, wgsl } from "@downdraft/engine/shader-graph";
import type { FrameGraphBuilder, GraphRenderContext, TextureHandle } from "../frame-graph";
import { PassType } from "../frame-graph";
import { RenderPass } from "../render-pass";
import {
    DEFAULT_FROXEL_CONFIG,
    DEFAULT_VOLUMETRIC_FOG,
    type FroxelGridConfig,
    type VolumetricFogConfig,
    computeFroxelGridBufferSize,
    computeFroxelLightIndexListSize,
    packVolumetricUniforms
} from "./volumetric-types";

const VolumetricUniforms: WgslStruct = wgsl.struct("VolumetricUniforms", {
  froxelDims: vec3u,
  screenWidth: f32,
  screenHeight: f32,
  nearPlane: f32,
  farPlane: f32,
  numLights: u32,
  density: f32,
  anisotropy: f32,
  scattering: vec3f,
  absorption: vec3f,
  _pad0: f32,
  _pad1: f32,
});

const CompositeUniforms: WgslStruct = wgsl.struct("CompositeUniforms", {
  invViewProj: mat4x4f,
  cameraPos: vec3f,
  _pad: f32,
});

const VOLUMETRIC_SCATTERING_SHADER = /* wgsl */ `
${VolumetricUniforms.wgsl}

struct LightData {
  position: vec4<f32>,
  color: vec4<f32>,
  direction: vec4<f32>,
  params: vec4<f32>,
};

struct FroxelEntry {
  offset: u32,
  count: u32,
};

@group(0) @binding(0) var<uniform> uniforms: VolumetricUniforms;
@group(0) @binding(1) var<storage> lightData: array<LightData>;
@group(0) @binding(2) var<storage> froxelGrid: array<FroxelEntry>;
@group(0) @binding(3) var<storage> froxelLightIndexList: array<u32>;
@group(0) @binding(4) var<storage, read_write> scatteringVolume: array<vec4<f32>>;

fn logDepth(near: f32, far: f32, slice: f32, numSlices: f32) -> f32 {
  return near * pow(far / near, slice / numSlices);
}

fn miePhase(cosTheta: f32, g: f32) -> f32 {
  let g2 = g * g;
  let denom = 1.0 + g2 - 2.0 * g * cosTheta;
  return (3.0 * (1.0 - g2)) / (8.0 * 3.14159265 * denom * sqrt(max(denom, 0.0001)));
}

@compute @workgroup_size(4, 4, 4)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = uniforms.froxelDims;
  if (gid.x >= dims.x || gid.y >= dims.y || gid.z >= dims.z) {
    return;
  }

  let froxelIdx = gid.x + gid.y * dims.x + gid.z * dims.x * dims.y;

  // Compute froxel view-space bounds
  let tileSizeX = 2.0 / f32(dims.x);
  let tileSizeY = 2.0 / f32(dims.y);

  let minNDC = vec2<f32>(f32(gid.x) * tileSizeX - 1.0, f32(gid.y) * tileSizeY - 1.0);
  let maxNDC = vec2<f32>((f32(gid.x) + 1u) * tileSizeX - 1.0, (f32(gid.y) + 1u) * tileSizeY - 1.0);

  let zNear = logDepth(uniforms.nearPlane, uniforms.farPlane, f32(gid.z), f32(dims.z));
  let zFar = logDepth(uniforms.nearPlane, uniforms.farPlane, f32(gid.z + 1u), f32(dims.z));

  // Froxel center in view space
  let centerNDC = (minNDC + maxNDC) * 0.5;
  let centerZ = (zNear + zFar) * 0.5;
  let centerView = vec3<f32>(centerNDC.x * centerZ, -centerNDC.y * centerZ, centerZ);

  let density = uniforms.density;
  let extinction = uniforms.scattering + uniforms.absorption;

  // Compute optical depth for this froxel
  let stepSize = (zFar - zNear);
  let opticalDepth = extinction * density * stepSize;
  let transmittance = exp(-opticalDepth);

  // Accumulate in-scattering from lights
  var inScattering = vec3<f32>(0.0);
  let entry = froxelGrid[froxelIdx];
  let lightCount = entry.count;
  let lightOffset = entry.offset;

  for (var i = 0u; i < lightCount; i = i + 1u) {
    let lightIdx = froxelLightIndexList[lightOffset + i];
    let light = lightData[lightIdx];
    let lightType = u32(light.direction.w);
    let lightRange = light.position.w;

    let toLight = light.position.xyz - centerView;
    let dist = length(toLight);
    if (dist > lightRange) { continue; }
    let L = toLight / max(dist, 0.001);

    let attenuation = 1.0 / (1.0 + 0.5 * dist * dist);
    let phase = miePhase(1.0, uniforms.anisotropy); // Simplified: use forward phase

    var lightContrib = light.color.rgb * light.color.w * attenuation * phase * density * stepSize;

    if (lightType == 1u) {
      // Spot light cone attenuation
      let spotCos = dot(-L, light.direction.xyz);
      let outerCos = light.params.y;
      let innerCos = light.params.x;
      if (spotCos < outerCos) { continue; }
      let spotAtten = smoothstep(outerCos, innerCos, spotCos);
      lightContrib = lightContrib * spotAtten;
    }

    inScattering = inScattering + lightContrib;
  }

  // Store scattering and transmittance
  scatteringVolume[froxelIdx] = vec4<f32>(inScattering, transmittance.x);
}
`;

const VOLUMETRIC_COMPOSITE_SHADER = /* wgsl */ `
${CompositeUniforms.wgsl}

@group(0) @binding(0) var<uniform> uniforms: CompositeUniforms;
@group(0) @binding(1) var colorTex: texture_2d<f32>;
@group(0) @binding(2) var depthTex: texture_depth_2d;
@group(0) @binding(3) var scatteringVolume: texture_3d<f32>;
@group(0) @binding(4) var texSampler: sampler;

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  let positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0),
  );
  let pos = positions[vi];
  var output: VertexOutput;
  output.clipPosition = vec4<f32>(pos, 0.0, 1.0);
  output.uv = pos * 0.5 + 0.5;
  return output;
}

fn reconstructWorldPos(uv: vec2<f32>, depth: f32) -> vec3<f32> {
  let ndc = vec3<f32>(uv * 2.0 - 1.0, depth);
  let worldPos = uniforms.invViewProj * vec4<f32>(ndc, 1.0);
  return worldPos.xyz / worldPos.w;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let dims = vec2<f32>(textureDimensions(colorTex, 0));
  let texel = vec2<i32>(input.uv * dims);
  let color = textureLoad(colorTex, texel, 0);
  let depth = textureLoad(depthTex, texel, 0);

  if (depth >= 1.0) {
    return color;
  }

  let worldPos = reconstructWorldPos(input.uv, depth);
  let viewDist = length(uniforms.cameraPos - worldPos);

  // Sample scattering volume at the appropriate froxel
  let volumeDims = vec3<f32>(textureDimensions(scatteringVolume, 0));
  let sampleUVW = vec3<f32>(input.uv, clamp(viewDist / 200.0, 0.0, 1.0));
  let scattering = textureSample(scatteringVolume, texSampler, sampleUVW);

  // Apply fog: color * transmittance + inScattering
  let transmittance = scattering.w;
  let result = color.rgb * transmittance + scattering.rgb;
  return vec4<f32>(result, color.a);
}
`;

export class VolumetricLightingPass extends RenderPass {
  name = "volumetric-lighting";
  passType = PassType.Custom;

  private device: GPUDevice | null;
  private froxelConfig: FroxelGridConfig;
  private fogConfig: VolumetricFogConfig;

  private scatteringTexture: GPUTexture | null = null;
  private scatteringView: GPUTextureView | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private froxelGridBuffer: GPUBuffer | null = null;
  private froxelLightIndexBuffer: GPUBuffer | null = null;
  private scatteringPipeline: GPUComputePipeline | null = null;
  private scatteringBindGroup: GPUBindGroup | null = null;

  colorHandle: TextureHandle | null = null;
  depthHandle: TextureHandle | null = null;
  outputHandle: TextureHandle | null = null;

  constructor(
    froxelConfig?: Partial<FroxelGridConfig>,
    fogConfig?: Partial<VolumetricFogConfig>,
    device?: GPUDevice | null,
  ) {
    super();
    this.froxelConfig = { ...DEFAULT_FROXEL_CONFIG, ...froxelConfig };
    this.fogConfig = { ...DEFAULT_VOLUMETRIC_FOG, ...fogConfig };
    this.device = device ?? null;
  }

  prepare(device: GPUDevice): void {
    this.device = device;

    this.scatteringTexture = device.createTexture({
      label: "volumetric-scattering",
      size: [this.froxelConfig.froxelX, this.froxelConfig.froxelY, this.froxelConfig.froxelZ],
      format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.scatteringView = this.scatteringTexture.createView();

    this.uniformBuffer = device.createBuffer({
      label: "volumetric-uniforms",
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.froxelGridBuffer = device.createBuffer({
      label: "froxel-grid",
      size: computeFroxelGridBufferSize(this.froxelConfig),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.froxelLightIndexBuffer = device.createBuffer({
      label: "froxel-light-index",
      size: computeFroxelLightIndexListSize(this.froxelConfig) * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const shader = createValidatedShaderModule(device, { code: VOLUMETRIC_SCATTERING_SHADER, label: "VolumetricLightingPass" });
    this.scatteringPipeline = device.createComputePipeline({
      label: "volumetric-scattering",
      layout: "auto",
      compute: { module: shader, entryPoint: "cs_main" },
    });
  }

  updateUniforms(screenWidth: number, screenHeight: number, numLights: number): void {
    const packed = packVolumetricUniforms(this.fogConfig, this.froxelConfig, screenWidth, screenHeight, numLights);
    if (this.device && this.uniformBuffer) {
      this.device.queue.writeBuffer(this.uniformBuffer, 0, packed as unknown as BufferSource);
    }
  }

  getScatteringView(): GPUTextureView | null {
    return this.scatteringView;
  }

  getFroxelGridBuffer(): GPUBuffer | null {
    return this.froxelGridBuffer;
  }

  getFroxelLightIndexBuffer(): GPUBuffer | null {
    return this.froxelLightIndexBuffer;
  }

  getConfig(): VolumetricFogConfig {
    return this.fogConfig;
  }

  getFroxelConfig(): FroxelGridConfig {
    return this.froxelConfig;
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.colorHandle) builder.read(this.colorHandle);
    if (this.depthHandle) builder.read(this.depthHandle);
    if (this.outputHandle) builder.colorAttachment({ handle: this.outputHandle, loadOp: "load", storeOp: "store" });
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.fogConfig.enabled) return;
    // Compute dispatch happens in render loop
  }

  destroy(): void {
    this.scatteringTexture?.destroy();
    this.uniformBuffer?.destroy();
    this.froxelGridBuffer?.destroy();
    this.froxelLightIndexBuffer?.destroy();
  }
}
