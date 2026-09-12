// ============================================================================
// Cube Renderer — minimal WebGPU instanced cube renderer for agents
//
// Draws colored cubes at given positions. Used by navmesh tests to render
// moving agents. Extracted from the plugin-tester's SimpleRenderer.
// ============================================================================


import { createValidatedShaderModule } from "@downdraft/core";
const CUBE_VS = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4<f32>,
};
struct InstanceData {
  model: mat4x4<f32>,
  color: vec3<f32>,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<uniform> instance: InstanceData;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) color: vec3<f32>,
  @location(1) normal: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = instance.model * vec4<f32>(input.position, 1.0);
  output.clipPos = uniforms.viewProj * worldPos;
  output.color = instance.color;
  output.normal = input.normal;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let lightDir = normalize(vec3<f32>(0.5, 0.8, 0.3));
  let diff = max(dot(normalize(input.normal), lightDir), 0.0);
  let ambient = 0.3;
  let lighting = ambient + diff * 0.7;
  return vec4<f32>(input.color * lighting, 1.0);
}
`;

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

function mat4Translate(x: number, y: number, z: number): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

function mat4Scale(sx: number, sy: number, sz: number): Float32Array {
  return new Float32Array([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1]);
}

export interface CubeInstance {
  position: [number, number, number];
  color: [number, number, number];
  size: number;
  /** Optional non-uniform scale (overrides `size` if provided). */
  scale?: [number, number, number];
}

export interface CameraConfig {
  eye: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
  near: number;
  far: number;
  aspect: number;
}

export class CubeRenderer {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private cubeVertexBuffer: GPUBuffer | null = null;
  private cubeIndexBuffer: GPUBuffer | null = null;
  private cubeIndexCount = 0;
  private instanceBuffer: GPUBuffer | null = null;
  private maxInstances = 128;
  private instanceStride = 256; // WebGPU minimum uniform buffer offset alignment

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  init(): void {
    this.uniformBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Cube geometry.
    const cubeVerts = [
      -0.5, -0.5, 0.5, 0, 0, 1,  0.5, -0.5, 0.5, 0, 0, 1,  0.5, 0.5, 0.5, 0, 0, 1,  -0.5, 0.5, 0.5, 0, 0, 1,
      -0.5, -0.5, -0.5, 0, 0, -1,  0.5, -0.5, -0.5, 0, 0, -1,  0.5, 0.5, -0.5, 0, 0, -1,  -0.5, 0.5, -0.5, 0, 0, -1,
      -0.5, 0.5, -0.5, 0, 1, 0,  0.5, 0.5, -0.5, 0, 1, 0,  0.5, 0.5, 0.5, 0, 1, 0,  -0.5, 0.5, 0.5, 0, 1, 0,
      -0.5, -0.5, 0.5, 0, -1, 0,  0.5, -0.5, 0.5, 0, -1, 0,  0.5, -0.5, -0.5, 0, -1, 0,  -0.5, -0.5, -0.5, 0, -1, 0,
      0.5, -0.5, -0.5, 1, 0, 0,  0.5, 0.5, -0.5, 1, 0, 0,  0.5, 0.5, 0.5, 1, 0, 0,  0.5, -0.5, 0.5, 1, 0, 0,
      -0.5, -0.5, 0.5, -1, 0, 0,  -0.5, 0.5, 0.5, -1, 0, 0,  -0.5, 0.5, -0.5, -1, 0, 0,  -0.5, -0.5, -0.5, -1, 0, 0,
    ];
    const cubeIndices = [
      0, 1, 2, 0, 2, 3,  4, 6, 5, 4, 7, 6,  8, 9, 10, 8, 10, 11,
      12, 14, 13, 12, 15, 14,  16, 17, 18, 16, 18, 19,  20, 22, 21, 20, 23, 22,
    ];
    this.cubeIndexCount = cubeIndices.length;

    const cubeData = new Float32Array(cubeVerts);
    this.cubeVertexBuffer = this.device.createBuffer({
      size: cubeData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.cubeVertexBuffer, 0, cubeData);

    const indexData = new Uint16Array(cubeIndices);
    this.cubeIndexBuffer = this.device.createBuffer({
      size: indexData.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.cubeIndexBuffer, 0, indexData);

    this.instanceBuffer = this.device.createBuffer({
      size: this.maxInstances * this.instanceStride,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const shaderModule = createValidatedShaderModule(this.device, { code: CUBE_VS, label: "CubeRenderer" });
    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
          ],
        }],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });
  }

  drawCubes(pass: GPURenderPassEncoder, instances: CubeInstance[], camera: CameraConfig): void {
    if (!this.pipeline || instances.length === 0) return;

    const proj = mat4Perspective(camera.fov, camera.aspect, camera.near, camera.far);
    const view = mat4LookAt(camera.eye, camera.target, camera.up);
    const viewProj = mat4Multiply(proj, view);
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, viewProj as unknown as GPUAllowSharedBufferSource);

    const instanceCount = Math.min(instances.length, this.maxInstances);
    const instanceData = new Float32Array(this.maxInstances * (this.instanceStride / 4));
    for (let i = 0; i < instanceCount; i++) {
      const inst = instances[i];
      const sx = inst.scale?.[0] ?? inst.size;
      const sy = inst.scale?.[1] ?? inst.size;
      const sz = inst.scale?.[2] ?? inst.size;
      const model = mat4Multiply(
        mat4Translate(inst.position[0], inst.position[1] + sy / 2, inst.position[2]),
        mat4Scale(sx, sy, sz),
      );
      const base = i * (this.instanceStride / 4);
      instanceData.set(model, base);
      instanceData[base + 16] = inst.color[0];
      instanceData[base + 17] = inst.color[1];
      instanceData[base + 18] = inst.color[2];
    }
    this.device.queue.writeBuffer(this.instanceBuffer!, 0, instanceData);

    pass.setPipeline(this.pipeline);
    for (let i = 0; i < instanceCount; i++) {
      const dynamicOffset = i * this.instanceStride;
      pass.setBindGroup(0, this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer! } },
          { binding: 1, resource: { buffer: this.instanceBuffer!, offset: dynamicOffset, size: 80 } },
        ],
      }));
      pass.setVertexBuffer(0, this.cubeVertexBuffer!);
      pass.setIndexBuffer(this.cubeIndexBuffer!, "uint16");
      pass.drawIndexed(this.cubeIndexCount);
    }
  }

  dispose(): void {
    this.cubeVertexBuffer?.destroy();
    this.cubeIndexBuffer?.destroy();
    this.instanceBuffer?.destroy();
    this.uniformBuffer?.destroy();
    try { this.pipeline?.destroy?.(); } catch { /* noop */ }
    this.cubeVertexBuffer = null;
    this.cubeIndexBuffer = null;
    this.instanceBuffer = null;
    this.uniformBuffer = null;
    this.pipeline = null;
  }
}
