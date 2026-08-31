import type { StructView, WgslStruct } from "@downdraft/shader-graph";
import { f32, mat4x4f, vec2f, vec3f, wgsl } from "@downdraft/shader-graph";
import { GpuSplatSorter } from "./gpu-sort";
import type { GaussianSplatData } from "./parser";
import { packShCoeffs, SH_COEFFS_TOTAL, SH_EVAL_WGSL } from "./sh-eval";
import type { SortResult } from "./sorter";
import { TileRasterPipeline, type TileRasterPipelineOptions } from "./tile-raster";

export interface GaussianSplatRendererConfig {
  /** Max splat count for GPU sort buffer pre-allocation. Default: 1_000_000. */
  maxSplats?: number;
  /** Below this count, use CPU sort. Default: 8192. */
  sortThreshold?: number;
  /** Sort every N frames (1 = every frame). Default: 1. */
  sortFrequency?: number;
  /** Max SH degree to evaluate (0 = DC only, 1-3 = view-dependent). Default: 0. */
  shDegree?: 0 | 1 | 2 | 3;
  /** Use tile-based rasterization instead of instanced quads. Default: false. */
  tileRaster?: boolean;
  /** Tile raster options (only used when tileRaster is true). */
  tileRasterOptions?: TileRasterPipelineOptions;
}

const CameraUniforms: WgslStruct = wgsl.struct("CameraUniforms", {
  viewProj: mat4x4f,
  cameraPos: vec3f,
  _pad: f32,
  resolution: vec2f,
  _pad2: vec2f,
});

const GAUSSIAN_SPLAT_SHADER = `
${CameraUniforms.wgsl}
${SH_EVAL_WGSL}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var splatData: array<vec4<f32>>;

struct VertexInput {
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) viewDir: vec3<f32>,
  @location(3) @interpolate(flat, either) splatIdx: u32,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let splatIdx = input.instanceIndex;
  let corner = input.vertexIndex;

  let pos = vec3<f32>(
    splatData[splatIdx * 3].x,
    splatData[splatIdx * 3].y,
    splatData[splatIdx * 3].z,
  );
  let scale = vec3<f32>(
    splatData[splatIdx * 3 + 1].x,
    splatData[splatIdx * 3 + 1].y,
    splatData[splatIdx * 3 + 1].z,
  );
  let color = vec4<f32>(
    splatData[splatIdx * 3 + 2].x,
    splatData[splatIdx * 3 + 2].y,
    splatData[splatIdx * 3 + 2].z,
    splatData[splatIdx * 3 + 2].w,
  );

  let offsets = array<vec2<f32>, 4>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(1.0, -1.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(-1.0, 1.0),
  );

  let cornerOffset = offsets[corner] * scale.xy;
  let clipPos = camera.viewProj * vec4<f32>(pos, 1.0);
  output.clipPosition = vec4<f32>(
    clipPos.x + cornerOffset.x * clipPos.w * 0.01,
    clipPos.y + cornerOffset.y * clipPos.w * 0.01,
    clipPos.z,
    clipPos.w,
  );
  output.color = color;
  output.uv = offsets[corner];
  output.viewDir = normalize(camera.cameraPos - pos);
  output.splatIdx = splatIdx;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let dist = dot(input.uv, input.uv);
  if (dist > 1.0) {
    discard;
  }
  let alpha = exp(-dist * 2.0);
  let shContrib = evalSH(input.splatIdx, input.viewDir);
  return vec4<f32>(input.color.rgb + shContrib, input.color.a * alpha);
}
`;

export class GaussianSplatRenderer {
  private device: GPUDevice | null;
  private surfaceFormat: GPUTextureFormat;
  private config: Required<GaussianSplatRendererConfig>;
  private shaderModule: GPUShaderModule | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  private _cameraView: StructView | null = null;
  private _cameraBuf: Float32Array | null = null;
  private splatBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private splatData: GaussianSplatData | null = null;
  private sortResult: SortResult | null = null;
  private sorter: GpuSplatSorter | null = null;
  private frameCount = 0;
  private _lastDrawBuffer: GPUBuffer | null = null;
  private shBuffer: GPUBuffer | null = null;
  private shParamsBuffer: GPUBuffer | null = null;
  private shParamsData: Uint32Array | null = null;
  private shEnabled = false;
  private tileRaster: TileRasterPipeline | null = null;
  private tileRasterBindGroup: GPUBindGroup | null = null;
  private _lastTileDrawBuffer: GPUBuffer | null = null;

  constructor(
    device: GPUDevice | null,
    surfaceFormat: GPUTextureFormat,
    config: GaussianSplatRendererConfig = {},
  ) {
    this.device = device;
    this.surfaceFormat = surfaceFormat;
    this.config = {
      maxSplats: config.maxSplats ?? 1_000_000,
      sortThreshold: config.sortThreshold ?? 8192,
      sortFrequency: config.sortFrequency ?? 1,
      shDegree: config.shDegree ?? 0,
      tileRaster: config.tileRaster ?? false,
      tileRasterOptions: config.tileRasterOptions ?? {},
    } as Required<GaussianSplatRendererConfig>;
  }

  prepare(device: GPUDevice): void {
    if (!this.device) this.device = device;
    if (!this.shaderModule && this.device) {
      this.shaderModule = this.device.createShaderModule({ code: GAUSSIAN_SPLAT_SHADER });
    }
    if (!this.cameraBuffer && this.device) {
      this.cameraBuffer = this.device.createBuffer({
        size: 96,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this._cameraBuf = new Float32Array(CameraUniforms.floatCount);
      this._cameraView = CameraUniforms.view(this._cameraBuf);
    }
    if (!this.sorter && this.device) {
      this.sorter = new GpuSplatSorter(this.device, {
        maxSplats: this.config.maxSplats,
        threshold: this.config.sortThreshold,
      });
      this.sorter.prepare(this.device);
    }
    if (!this.shParamsBuffer && this.device) {
      this.shParamsData = new Uint32Array(4);
      this.shParamsBuffer = this.device.createBuffer({
        label: "splat-sh-params",
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    if (!this.tileRaster && this.config.tileRaster && this.device) {
      this.tileRaster = new TileRasterPipeline(this.device, this.config.tileRasterOptions);
      this.tileRaster.prepare(this.device);
    }
  }

  setData(data: GaussianSplatData): void {
    this.splatData = data;
    if (!this.device || !data) return;

    // Pack SoA arrays into the shader's vec4-strided layout:
    //   [pos.xyz, _] [scale.xyz, _] [color.rgb, color.a] per splat (12 floats).
    // color.a already includes the opacity sigmoid (folded in by the parser).
    const count = data.count;
    const splatArray = new Float32Array(count * 12);
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const i4 = i * 4;
      const o = i * 12;
      splatArray[o] = data.position[i3];
      splatArray[o + 1] = data.position[i3 + 1];
      splatArray[o + 2] = data.position[i3 + 2];
      splatArray[o + 3] = 0;
      splatArray[o + 4] = data.scale[i3];
      splatArray[o + 5] = data.scale[i3 + 1];
      splatArray[o + 6] = data.scale[i3 + 2];
      splatArray[o + 7] = 0;
      splatArray[o + 8] = data.color[i4];
      splatArray[o + 9] = data.color[i4 + 1];
      splatArray[o + 10] = data.color[i4 + 2];
      splatArray[o + 11] = data.color[i4 + 3];
    }

    if (this.splatBuffer) this.splatBuffer.destroy();
    this.splatBuffer = this.device.createBuffer({
      size: splatArray.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.splatBuffer, 0, splatArray.buffer);

    // Pack + upload SH coefficients (degrees 1..shDegree)
    this.uploadShCoeffs(data);
    // Reset bind group cache — the splat buffer changed
    this._lastDrawBuffer = null;
  }

  private uploadShCoeffs(data: GaussianSplatData): void {
    const device = this.device!;
    const maxDegree = this.config.shDegree;
    const coeffs = packShCoeffs(data, maxDegree);
    this.shEnabled = coeffs.length > 0;

    if (this.shBuffer) {
      this.shBuffer.destroy();
      this.shBuffer = null;
    }

    if (this.shEnabled) {
      this.shBuffer = device.createBuffer({
        label: "splat-sh-coeffs",
        size: coeffs.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(this.shBuffer, 0, coeffs.buffer as unknown as GPUAllowSharedBufferSource);
      const coeffsPerSplat = SH_COEFFS_TOTAL[maxDegree];
      this.shParamsData![0] = maxDegree;
      this.shParamsData![1] = coeffsPerSplat;
      this.shParamsData![2] = 0;
      this.shParamsData![3] = 0;
      device.queue.writeBuffer(this.shParamsBuffer!, 0, this.shParamsData! as unknown as GPUAllowSharedBufferSource);
    } else {
      // shDegree = 0 → evalSH returns vec3(0); still upload zeroed params
      this.shParamsData![0] = 0;
      this.shParamsData![1] = 0;
      this.shParamsData![2] = 0;
      this.shParamsData![3] = 0;
      device.queue.writeBuffer(this.shParamsBuffer!, 0, this.shParamsData! as unknown as GPUAllowSharedBufferSource);
    }
  }

  updateSort(sortResult: SortResult): void {
    this.sortResult = sortResult;
  }

  private ensurePipeline(): void {
    if (this.pipeline || !this.device || !this.shaderModule || !this.cameraBuffer) return;
    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.shaderModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: this.shaderModule,
        entryPoint: "fs_main",
        targets: [{
          format: this.surfaceFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-strip" },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: false,
        depthCompare: "less",
      },
    });
  }

  render(
    passEncoder: GPURenderPassEncoder,
    viewProj: number[],
    cameraPos: [number, number, number],
    resolution: [number, number],
  ): void {
    if (!this.device || !this.splatData || !this.cameraBuffer || !this.splatBuffer) return;
    const count = this.splatData.count;

    // Write camera uniforms (used by instanced-quad path)
    const camView = this._cameraView!;
    camView.set("viewProj", viewProj);
    camView.set("cameraPos", cameraPos);
    camView.set("_pad", 0);
    camView.set("resolution", resolution);
    camView.set("_pad2", [0, 0]);
    this.device.queue.writeBuffer(this.cameraBuffer, 0, this._cameraBuf! as unknown as GPUAllowSharedBufferSource);

    // Sort + compact: determine which buffer to draw from.
    // On sort frames, run the GPU/CPU sort and compact into a sorted buffer.
    // On non-sort frames (sortFrequency > 1), reuse the last compacted buffer.
    let drawBuffer = this.splatBuffer;
    const shouldSort = this.frameCount % this.config.sortFrequency === 0;
    if (shouldSort && this.sorter && count > 0) {
      const compacted = this.sorter.sortAndCompact(cameraPos, this.splatBuffer, this.splatData, count);
      if (compacted) drawBuffer = compacted;
    }

    if (this.config.tileRaster && this.tileRaster) {
      this.renderTileRaster(passEncoder, drawBuffer, count, viewProj, resolution);
    } else {
      this.renderInstancedQuads(passEncoder, drawBuffer, count);
    }
    this.frameCount++;
  }

  private renderInstancedQuads(
    passEncoder: GPURenderPassEncoder,
    drawBuffer: GPUBuffer,
    count: number,
  ): void {
    this.ensurePipeline();
    if (!this.pipeline || !this.splatBuffer || !this.device) return;

    // (Re)create bind group if the draw buffer changed
    if (drawBuffer !== this._lastDrawBuffer) {
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: this.cameraBuffer! } },
        { binding: 1, resource: { buffer: drawBuffer } },
      ];
      // SH bindings (binding 2 = coeffs, binding 3 = params).
      // The shader always declares these bindings; when SH is disabled,
      // bind a 16-byte placeholder buffer (shParams has shDegree=0 → evalSH returns 0).
      if (this.shBuffer && this.shEnabled) {
        entries.push({ binding: 2, resource: { buffer: this.shBuffer } });
        entries.push({ binding: 3, resource: { buffer: this.shParamsBuffer! } });
      } else {
        // Bind shParamsBuffer for both slots — it has shDegree=0 so evalSH is a no-op.
        // The coeffs binding still needs a valid storage buffer; reuse shParamsBuffer.
        entries.push({ binding: 2, resource: { buffer: this.shParamsBuffer! } });
        entries.push({ binding: 3, resource: { buffer: this.shParamsBuffer! } });
      }
      this.bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries,
      });
      this._lastDrawBuffer = drawBuffer;
    }

    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this.bindGroup!);
    passEncoder.draw(4, count);
  }

  private renderTileRaster(
    passEncoder: GPURenderPassEncoder,
    drawBuffer: GPUBuffer,
    count: number,
    viewProj: number[],
    resolution: [number, number],
  ): void {
    if (!this.tileRaster || count === 0) return;
    const [width, height] = resolution;

    // Bin splats into tiles (compute pass)
    const { tileCounts, tileIndices } = this.tileRaster.binSplats(
      drawBuffer,
      count,
      viewProj,
      width,
      height,
    );

    // Write raster uniforms
    this.tileRaster.writeRasterUniforms(width, height);

    // (Re)create bind group if the draw buffer changed
    if (drawBuffer !== this._lastTileDrawBuffer) {
      this.tileRasterBindGroup = this.tileRaster.createRasterBindGroup(drawBuffer, tileCounts, tileIndices);
      this._lastTileDrawBuffer = drawBuffer;
    }

    const pipeline = this.tileRaster.getRasterPipeline();
    if (!pipeline || !this.tileRasterBindGroup) return;

    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, this.tileRasterBindGroup);
    passEncoder.draw(3); // Full-screen triangle
  }

  destroy(): void {
    this.cameraBuffer?.destroy();
    this.splatBuffer?.destroy();
    this.pipeline?.destroy();
    this.shaderModule?.destroy();
    this.sorter?.destroy();
    this.shBuffer?.destroy();
    this.shParamsBuffer?.destroy();
    this.tileRaster?.destroy();
    // GPUBindGroup has no destroy() — just null it.
    this.cameraBuffer = null;
    this._cameraView = null;
    this._cameraBuf = null;
    this.splatBuffer = null;
    this.pipeline = null;
    this.shaderModule = null;
    this.bindGroup = null;
    this.sorter = null;
    this._lastDrawBuffer = null;
    this.shBuffer = null;
    this.shParamsBuffer = null;
    this.shParamsData = null;
    this.tileRaster = null;
    this.tileRasterBindGroup = null;
    this._lastTileDrawBuffer = null;
  }
}
