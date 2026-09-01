// ============================================================================
// Line Renderer — minimal WebGPU line-list renderer for debug visualization
//
// Draws a list of line segments (start + end positions with per-vertex color)
// using `line-list` topology. Used by navmesh tests to draw polygon outlines,
// portal edges, and agent path lines.
// ============================================================================

const LINE_VS = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) color: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.clipPos = uniforms.viewProj * vec4<f32>(input.position, 1.0);
  output.color = input.color;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  return input.color;
}
`;

export interface DebugLine {
  start: [number, number, number];
  end: [number, number, number];
  color: [number, number, number, number];
}

function mat4Perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1.0 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function mat4LookAt(eye: [number, number, number], target: [number, number, number], up: [number, number, number]): Float32Array {
  const z0 = eye[0] - target[0], z1 = eye[1] - target[1], z2 = eye[2] - target[2];
  const zLen = Math.sqrt(z0 * z0 + z1 * z1 + z2 * z2);
  const zx = z0 / zLen, zy = z1 / zLen, zz = z2 / zLen;
  const x0 = up[1] * zz - up[2] * zy;
  const x1 = up[2] * zx - up[0] * zz;
  const x2 = up[0] * zy - up[1] * zx;
  const xLen = Math.sqrt(x0 * x0 + x1 * x1 + x2 * x2);
  const xx = x0 / xLen, xy = x1 / xLen, xz = x2 / xLen;
  const y0 = zy * xz - zz * xy;
  const y1 = zz * xx - zx * xz;
  const y2 = zx * xy - zy * xx;
  return new Float32Array([
    xx, y0, zx, 0,
    xy, y1, zy, 0,
    xz, y2, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}

function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + j] * b[i * 4 + k];
      }
      out[i * 4 + j] = sum;
    }
  }
  return out;
}

export class LineRenderer {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private maxVertices = 65536;
  private depthTexture: GPUTexture | null = null;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  init(): void {
    this.uniformBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.vertexBuffer = this.device.createBuffer({
      size: this.maxVertices * 28, // vec3 position + vec4 color = 28 bytes
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    const shaderModule = this.device.createShaderModule({ code: LINE_VS });
    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 28,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x4" },
          ],
        }],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.format, blend: {
          alpha: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
          color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
        } }],
      },
      primitive: { topology: "line-list" },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
    });
  }

  /**
   * Draws a list of debug lines. Each line = 2 vertices (start + end).
   * Call inside a render pass (passEncoder is the active GPURenderPassEncoder).
   */
  drawLines(
    pass: GPURenderPassEncoder,
    lines: DebugLine[],
    camera: { eye: [number, number, number]; target: [number, number, number]; up: [number, number, number]; fov: number; near: number; far: number; aspect: number },
  ): void {
    if (lines.length === 0 || !this.pipeline || !this.vertexBuffer || !this.uniformBuffer) return;

    // Update uniforms (view-projection).
    const proj = mat4Perspective(camera.fov, camera.aspect, camera.near, camera.far);
    const view = mat4LookAt(camera.eye, camera.target, camera.up);
    const viewProj = mat4Multiply(proj, view);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, viewProj as unknown as GPUAllowSharedBufferSource);

    // Build vertex data: 2 vertices per line.
    const vertexCount = Math.min(lines.length * 2, this.maxVertices);
    const data = new Float32Array(vertexCount * 7); // 7 floats per vertex
    for (let i = 0; i < lines.length && i * 2 < this.maxVertices; i++) {
      const line = lines[i];
      const base = i * 14; // 2 vertices * 7 floats
      // Start vertex
      data[base + 0] = line.start[0];
      data[base + 1] = line.start[1];
      data[base + 2] = line.start[2];
      data[base + 3] = line.color[0];
      data[base + 4] = line.color[1];
      data[base + 5] = line.color[2];
      data[base + 6] = line.color[3];
      // End vertex
      data[base + 7] = line.end[0];
      data[base + 8] = line.end[1];
      data[base + 9] = line.end[2];
      data[base + 10] = line.color[0];
      data[base + 11] = line.color[1];
      data[base + 12] = line.color[2];
      data[base + 13] = line.color[3];
    }
    this.device.queue.writeBuffer(this.vertexBuffer, 0, data.subarray(0, vertexCount * 7));

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    }));
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.draw(vertexCount);
  }

  ensureDepthTexture(width: number, height: number): GPUTextureView {
    if (this.depthTexture && this.depthTexture.width === width && this.depthTexture.height === height) {
      return this.depthTexture.createView();
    }
    this.depthTexture?.destroy();
    this.depthTexture = this.device.createTexture({
      size: [width, height],
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    return this.depthTexture.createView();
  }

  dispose(): void {
    this.depthTexture?.destroy();
    this.vertexBuffer?.destroy();
    this.uniformBuffer?.destroy();
    try { this.pipeline?.destroy?.(); } catch { /* noop */ }
    this.depthTexture = null;
    this.vertexBuffer = null;
    this.uniformBuffer = null;
    this.pipeline = null;
  }
}
