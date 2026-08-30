import { calculateViewProj, DEPTH_FORMAT, MSAA_SAMPLE_COUNT, type CameraState } from "@downdraft/core";

const RULER_WGSL = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4<f32>,
  _pad0: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) tickFlag: f32,
};

@vertex
fn vs_main(@location(0) position: vec3<f32>, @location(1) tickFlag: f32) -> VertexOutput {
  var output: VertexOutput;
  output.clipPos = uniforms.viewProj * vec4<f32>(position, 1.0);
  output.worldPos = position;
  output.tickFlag = tickFlag;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  // Major ticks (every meter) are bright; the main line is dimmer.
  let isTick = input.tickFlag > 0.5;
  let color = select(
    vec3<f32>(0.3, 0.6, 1.0),   // main line — soft blue
    vec3<f32>(0.5, 0.8, 1.0),   // tick marks — brighter blue
    isTick,
  );
  let alpha = select(0.5, 0.9, isTick);
  return vec4<f32>(color, alpha);
}
`;

/**
 * Renders a vertical measuring ruler at world origin (x=0, z=0) from y=0
 * up to `maxHeight` meters, with tick marks at every meter.
 *
 * The DOM overlay labels are handled by the caller via `projectHeightMarkers()`,
 * which projects the 3D tick positions to 2D screen coordinates using the
 * current camera view-projection matrix.
 */
export class HeightRulerRenderer {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private vertexCount = 0;
  private maxHeight = 3; // meters

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  init() {
    this.rebuildVertices(this.maxHeight);

    this.uniformBuffer = this.device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const shaderModule = this.device.createShaderModule({ code: RULER_WGSL });
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
          arrayStride: 16, // pos(3 floats) + tickFlag(1 float)
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32" },
          ],
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

  private rebuildVertices(maxHeight: number) {
    // Vertical line at (0, 0, 0) from y=0 to y=maxHeight, plus tick marks
    // at every meter. Each tick is a short horizontal line on the X axis.
    const verts: number[] = [];
    const tickSize = 0.15; // 15cm tick marks

    // Main vertical line (tickFlag = 0)
    verts.push(0, 0, 0, 0, 0, maxHeight, 0, 0);

    // Tick marks at every meter (tickFlag = 1)
    for (let h = 0; h <= maxHeight; h++) {
      verts.push(-tickSize, h, 0, 1, tickSize, h, 0, 1);
    }

    this.vertexCount = verts.length / 4;

    if (this.vertexBuffer) this.vertexBuffer.destroy();
    this.vertexBuffer = this.device.createBuffer({
      size: verts.length * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.vertexBuffer, 0, new Float32Array(verts));
  }

  /** Update the ruler height (e.g. to match the loaded model's height). */
  setMaxHeight(meters: number) {
    const rounded = Math.max(1, Math.ceil(meters));
    if (rounded !== this.maxHeight) {
      this.maxHeight = rounded;
      if (this.pipeline) this.rebuildVertices(rounded);
    }
  }

  render(passEncoder: GPURenderPassEncoder, camera: CameraState) {
    if (!this.pipeline || !this.bindGroup || !this.uniformBuffer || !this.vertexBuffer) return;

    const viewProj = calculateViewProj(camera);
    const uniforms = new Float32Array(20);
    for (let i = 0; i < 16; i++) uniforms[i] = viewProj[i];

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this.bindGroup);
    passEncoder.setVertexBuffer(0, this.vertexBuffer);
    passEncoder.draw(this.vertexCount);
  }

  /**
   * Project the height marker positions (every meter on the ruler) to 2D
   * screen coordinates. Returns an array of { height, x, y, visible } for
   * each meter tick, where x/y are in CSS pixels relative to the canvas.
   */
  projectHeightMarkers(
    camera: CameraState,
    canvasWidth: number,
    canvasHeight: number,
  ): Array<{ height: number; x: number; y: number; visible: boolean }> {
    const viewProj = calculateViewProj(camera);
    const results: Array<{ height: number; x: number; y: number; visible: boolean }> = [];

    for (let h = 0; h <= this.maxHeight; h++) {
      // World position of the tick mark tip (right side, x=+tickSize)
      const wx = 0.15;
      const wy = h;
      const wz = 0;

      // Multiply by view-projection matrix (column-major)
      const clipX = viewProj[0] * wx + viewProj[4] * wy + viewProj[8] * wz + viewProj[12];
      const clipY = viewProj[1] * wx + viewProj[5] * wy + viewProj[9] * wz + viewProj[13];
      const clipZ = viewProj[2] * wx + viewProj[6] * wy + viewProj[10] * wz + viewProj[14];
      const clipW = viewProj[3] * wx + viewProj[7] * wy + viewProj[11] * wz + viewProj[15];

      if (clipW <= 0) {
        results.push({ height: h, x: 0, y: 0, visible: false });
        continue;
      }

      const ndcX = clipX / clipW;
      const ndcY = clipY / clipW;
      const ndcZ = clipZ / clipW;

      // NDC to screen pixels (Y is flipped: NDC -1 = bottom, +1 = top)
      const screenX = (ndcX + 1) / 2 * canvasWidth;
      const screenY = (1 - ndcY) / 2 * canvasHeight;
      const visible = ndcZ >= -1 && ndcZ <= 1;

      results.push({ height: h, x: screenX, y: screenY, visible });
    }

    return results;
  }

  destroy() {
    this.vertexBuffer?.destroy();
    this.uniformBuffer?.destroy();
  }
}
