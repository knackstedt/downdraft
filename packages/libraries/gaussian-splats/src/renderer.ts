import type { StructView, WgslStruct } from "@downdraft/shader-graph";
import { f32, mat4x4f, vec2f, vec3f, wgsl } from "@downdraft/shader-graph";
import type { GaussianSplatData } from "./parser";
import type { SortResult } from "./sorter";

const CameraUniforms: WgslStruct = wgsl.struct("CameraUniforms", {
  viewProj: mat4x4f,
  cameraPos: vec3f,
  _pad: f32,
  resolution: vec2f,
  _pad2: vec2f,
});

const GAUSSIAN_SPLAT_SHADER = `
${CameraUniforms.wgsl}

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
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let dist = dot(input.uv, input.uv);
  if (dist > 1.0) {
    discard;
  }
  let alpha = exp(-dist * 2.0);
  return vec4<f32>(input.color.rgb, input.color.a * alpha);
}
`;

export class GaussianSplatRenderer {
  private device: GPUDevice | null;
  private surfaceFormat: GPUTextureFormat;
  private shaderModule: GPUShaderModule | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  private _cameraView: StructView | null = null;
  private _cameraBuf: Float32Array | null = null;
  private splatBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private splatData: GaussianSplatData | null = null;
  private sortResult: SortResult | null = null;

  constructor(device: GPUDevice | null, surfaceFormat: GPUTextureFormat) {
    this.device = device;
    this.surfaceFormat = surfaceFormat;
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
  }

  setData(data: GaussianSplatData): void {
    this.splatData = data;
    if (!this.device || !data) return;

    const splatArray = new Float32Array(data.count * 12);
    for (let i = 0; i < data.count; i++) {
      const s = data.splats[i];
      splatArray[i * 12] = s.position[0];
      splatArray[i * 12 + 1] = s.position[1];
      splatArray[i * 12 + 2] = s.position[2];
      splatArray[i * 12 + 3] = 0;
      splatArray[i * 12 + 4] = s.scale[0];
      splatArray[i * 12 + 5] = s.scale[1];
      splatArray[i * 12 + 6] = s.scale[2];
      splatArray[i * 12 + 7] = 0;
      splatArray[i * 12 + 8] = s.color[0];
      splatArray[i * 12 + 9] = s.color[1];
      splatArray[i * 12 + 10] = s.color[2];
      splatArray[i * 12 + 11] = s.color[3] * s.opacity;
    }

    if (this.splatBuffer) this.splatBuffer.destroy();
    this.splatBuffer = this.device.createBuffer({
      size: splatArray.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.splatBuffer, 0, splatArray.buffer);
  }

  updateSort(sortResult: SortResult): void {
    this.sortResult = sortResult;
  }

  private ensurePipeline(): void {
    if (this.pipeline || !this.device || !this.shaderModule || !this.cameraBuffer || !this.splatBuffer) return;
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
    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: this.splatBuffer } },
      ],
    });
  }

  render(
    passEncoder: GPURenderPassEncoder,
    viewProj: number[],
    cameraPos: [number, number, number],
    resolution: [number, number],
  ): void {
    if (!this.device || !this.splatData || !this.cameraBuffer) return;
    this.ensurePipeline();
    if (!this.pipeline || !this.bindGroup) return;

    const camView = this._cameraView!;
    camView.set("viewProj", viewProj);
    camView.set("cameraPos", cameraPos);
    camView.set("_pad", 0);
    camView.set("resolution", resolution);
    camView.set("_pad2", [0, 0]);
    this.device.queue.writeBuffer(this.cameraBuffer, 0, this._cameraBuf! as unknown as GPUAllowSharedBufferSource);

    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this.bindGroup);
    passEncoder.draw(4, this.splatData.count);
  }

  destroy(): void {
    this.cameraBuffer?.destroy();
    this.splatBuffer?.destroy();
    this.pipeline?.destroy();
    this.shaderModule?.destroy();
    // GPUBindGroup has no destroy() — just null it.
    this.cameraBuffer = null;
    this._cameraView = null;
    this._cameraBuf = null;
    this.splatBuffer = null;
    this.pipeline = null;
    this.shaderModule = null;
    this.bindGroup = null;
  }
}
