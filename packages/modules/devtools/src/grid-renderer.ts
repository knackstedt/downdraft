import { calculateViewProj, DEPTH_FORMAT, MSAA_SAMPLE_COUNT, type CameraState } from "@downdraft/core";

const GRID_WGSL = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  _pad: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
};

@vertex
fn vs_main(@location(0) position: vec3<f32>) -> VertexOutput {
  var output: VertexOutput;
  output.clipPos = uniforms.viewProj * vec4<f32>(position, 1.0);
  output.worldPos = position;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let dist = length(input.worldPos.xz);
  let fade = 1.0 - smoothstep(15.0, 45.0, dist);

  // 1m grid lines: distance to nearest integer on each axis.
  // abs(fract(x + 0.5) - 0.5) is 0 at integers, 0.5 at half-integers.
  let dx1 = abs(fract(input.worldPos.x + 0.5) - 0.5);
  let dz1 = abs(fract(input.worldPos.z + 0.5) - 0.5);
  let lineDist = min(dx1, dz1);
  let line = 1.0 - smoothstep(0.0, 0.03, lineDist);

  // 5m major lines: same pattern scaled by 1/5, remapped to world units.
  let dx5 = abs(fract(input.worldPos.x / 5.0 + 0.5) - 0.5) * 5.0;
  let dz5 = abs(fract(input.worldPos.z / 5.0 + 0.5) - 0.5) * 5.0;
  let majorDist = min(dx5, dz5);
  let majorLine = 1.0 - smoothstep(0.0, 0.03, majorDist);

  let minorColor = vec3<f32>(0.24, 0.24, 0.30);
  let majorColor = vec3<f32>(0.42, 0.42, 0.56);
  let color = mix(minorColor, majorColor, majorLine);
  let intensity = max(line, majorLine);
  return vec4<f32>(color * intensity * fade, fade * 0.85);
}
`;

export class GridRenderer {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private vertexCount = 0;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  init() {
    // Grid vertices — lines from -50 to +50 at 1-meter spacing.
    // Wide enough for large true-scale models; the shader fades out the
    // distant lines so the visible area stays focused on the model.
    const verts: number[] = [];
    const range = 50;
    const step = 1;
    for (let i = -range; i <= range; i += step) {
      // X-axis lines
      verts.push(-range, 0, i, range, 0, i);
      // Z-axis lines
      verts.push(i, 0, -range, i, 0, range);
    }
    this.vertexCount = verts.length / 3;

    this.vertexBuffer = this.device.createBuffer({
      size: verts.length * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.vertexBuffer, 0, new Float32Array(verts));

    this.uniformBuffer = this.device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const shaderModule = this.device.createShaderModule({ code: GRID_WGSL });
    const bindGroupLayout = this.device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      }],
    });

    this.bindGroup = this.device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
        }],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
          },
        }],
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

  render(passEncoder: GPURenderPassEncoder, camera: CameraState) {
    if (!this.pipeline || !this.bindGroup || !this.uniformBuffer || !this.vertexBuffer) return;

    const viewProj = calculateViewProj(camera);
    const uniforms = new Float32Array(16 + 4);
    for (let i = 0; i < 16; i++) uniforms[i] = viewProj[i];
    uniforms[16] = camera.position[0];
    uniforms[17] = camera.position[1];
    uniforms[18] = camera.position[2];

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this.bindGroup);
    passEncoder.setVertexBuffer(0, this.vertexBuffer);
    passEncoder.draw(this.vertexCount);
  }

  destroy() {
    this.vertexBuffer?.destroy();
    this.uniformBuffer?.destroy();
  }
}
