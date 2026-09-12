// ============================================================================
// MRT Cube Renderer — cube grid renderer with optional normals/velocity/mask
//
// Renders a rotating 3D cube grid with support for multiple render targets:
// - Color (always)
// - Depth (always)
// - Normals (optional — for SSAO, SSR, Edges)
// - Velocity (optional — for TAA, Motion Blur)
// - Mask (optional — for Outline, Highlight, Glow; pre-selected cubes)
//
// The renderer detects which targets are available by checking which views
// the PostProcessStack provides.
// ============================================================================


import { createValidatedShaderModule } from "@downdraft/core";
export interface CameraConfig {
  eye: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
  near: number;
  far: number;
  aspect: number;
}

export interface CubeInstance {
  position: [number, number, number];
  color: [number, number, number];
  size: number;
  selected?: boolean;
}

export function mat4Perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1.0 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

export function mat4LookAt(eye: [number, number, number], target: [number, number, number], up: [number, number, number]): Float32Array {
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

// Column-major matrix multiply: result = A * B
export function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
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

function mat4Translation(x: number, y: number, z: number): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

function mat4Scale(s: number): Float32Array {
  return new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]);
}

// WGSL shader with MRT support — conditionally outputs normals and mask
const MRT_VS = /* wgsl */ `
struct FrameUniforms {
  viewProj: mat4x4<f32>,
  prevViewProj: mat4x4<f32>,
};
struct InstanceData {
  model: mat4x4<f32>,
  color: vec3<f32>,
  selected: f32,
};
@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(0) @binding(1) var<uniform> instance: InstanceData;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
};
struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) color: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) velocity: vec2<f32>,
  @location(3) mask: f32,
};
@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = instance.model * vec4<f32>(input.position, 1.0);
  output.clipPos = frame.viewProj * worldPos;
  output.color = instance.color;
  output.normal = (instance.model * vec4<f32>(input.normal, 0.0)).xyz;
  let prevClip = frame.prevViewProj * worldPos;
  let curNdc = output.clipPos.xy / output.clipPos.w;
  let prevNdc = prevClip.xy / prevClip.w;
  output.velocity = (curNdc - prevNdc) * 0.5;
  output.mask = instance.selected;
  return output;
}
`;

const MRT_FS = /* wgsl */ `
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let lightDir = normalize(vec3<f32>(0.5, 0.8, 0.3));
  let diff = max(dot(normalize(input.normal), lightDir), 0.0);
  let ambient = 0.3;
  let lighting = ambient + diff * 0.7;
  let baseColor = input.color * lighting;
  // Brighten selected cubes so they're visually distinct
  let selected = input.mask > 0.5;
  let finalColor = select(baseColor, baseColor * 1.5 + vec3<f32>(0.1, 0.05, 0.0), selected);
  return vec4<f32>(finalColor, 1.0);
}
@fragment
fn fs_normal(input: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(normalize(input.normal) * 0.5 + 0.5, 1.0);
}
@fragment
fn fs_velocity(input: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(input.velocity, 0.0, 1.0);
}
@fragment
fn fs_mask(input: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(input.mask, 0.0, 0.0, 1.0);
}
`;

// Cube geometry (24 vertices: 4 per face × 6 faces)
const CUBE_POSITIONS = new Float32Array([
  -0.5,-0.5, 0.5,  0.5,-0.5, 0.5,  0.5, 0.5, 0.5, -0.5, 0.5, 0.5, // front
   0.5,-0.5,-0.5, -0.5,-0.5,-0.5, -0.5, 0.5,-0.5,  0.5, 0.5,-0.5, // back
  -0.5, 0.5, 0.5,  0.5, 0.5, 0.5,  0.5, 0.5,-0.5, -0.5, 0.5,-0.5, // top
  -0.5,-0.5,-0.5,  0.5,-0.5,-0.5,  0.5,-0.5, 0.5, -0.5,-0.5, 0.5, // bottom
   0.5,-0.5, 0.5,  0.5,-0.5,-0.5,  0.5, 0.5,-0.5,  0.5, 0.5, 0.5, // right
  -0.5,-0.5,-0.5, -0.5,-0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5,-0.5, // left
]);
const CUBE_NORMALS = new Float32Array([
  0,0,1, 0,0,1, 0,0,1, 0,0,1,
  0,0,-1, 0,0,-1, 0,0,-1, 0,0,-1,
  0,1,0, 0,1,0, 0,1,0, 0,1,0,
  0,-1,0, 0,-1,0, 0,-1,0, 0,-1,0,
  1,0,0, 1,0,0, 1,0,0, 1,0,0,
  -1,0,0, -1,0,0, -1,0,0, -1,0,0,
]);
const CUBE_INDICES = new Uint16Array([
  0,1,2, 0,2,3,    4,5,6, 4,6,7,
  8,9,10, 8,10,11, 12,13,14, 12,14,15,
  16,17,18, 16,18,19, 20,21,22, 20,22,23,
]);

export class MrtCubeRenderer {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private sceneColorPipeline: GPURenderPipeline | null = null;
  private normalPipeline: GPURenderPipeline | null = null;
  private velocityPipeline: GPURenderPipeline | null = null;
  private maskPipeline: GPURenderPipeline | null = null;
  private vertexBuffer!: GPUBuffer;
  private normalBuffer!: GPUBuffer;
  private indexBuffer!: GPUBuffer;
  private frameUniformBuffer!: GPUBuffer;
  private instanceUniformBuffer!: GPUBuffer;
  private bindGroupLayout!: GPUBindGroupLayout;
  private instanceBindGroup!: GPUBindGroup;
  private prevViewProj = new Float32Array(16);

  // Uniform buffer alignment for dynamic offsets (256 bytes on all WebGPU implementations)
  private static readonly INSTANCE_STRIDE = 256;
  private static readonly MAX_CUBES = 128;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  init(): void {
    const shader = createValidatedShaderModule(this.device, { code: MRT_VS + "\n" + MRT_FS, label: "MrtCubeRenderer" });

    this.vertexBuffer = this.device.createBuffer({
      size: CUBE_POSITIONS.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.vertexBuffer, 0, CUBE_POSITIONS);

    this.normalBuffer = this.device.createBuffer({
      size: CUBE_NORMALS.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.normalBuffer, 0, CUBE_NORMALS);

    this.indexBuffer = this.device.createBuffer({
      size: CUBE_INDICES.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.indexBuffer, 0, CUBE_INDICES);

    this.frameUniformBuffer = this.device.createBuffer({
      size: 256, // 2 mat4x4, padded to 256 for alignment
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Instance buffer: 256 bytes per cube (dynamic uniform offset alignment)
    this.instanceUniformBuffer = this.device.createBuffer({
      size: MrtCubeRenderer.INSTANCE_STRIDE * MrtCubeRenderer.MAX_CUBES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform", hasDynamicOffset: true } },
      ],
    });

    // One bind group for all cubes — dynamic offset selects which instance
    this.instanceBindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameUniformBuffer } },
        { binding: 1, resource: { buffer: this.instanceUniformBuffer, size: 80 } },
      ],
    });

    const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });
    const vertexLayout: GPUVertexBufferLayout[] = [
      { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
      { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" }] },
    ];

    const depthState: GPUDepthStencilState = {
      format: "depth32float",
      depthWriteEnabled: true,
      depthCompare: "less",
    };
    const depthStateReadOnly: GPUDepthStencilState = {
      format: "depth32float",
      depthWriteEnabled: false,
      depthCompare: "less",
    };

    this.pipeline = this.device.createRenderPipeline({
      layout,
      vertex: { module: shader, entryPoint: "vs_main", buffers: vertexLayout },
      fragment: { module: shader, entryPoint: "fs_main", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: depthState,
    });
    // HDR pipeline for rendering into the PostProcessStack's rgba16float scene color target
    this.sceneColorPipeline = this.device.createRenderPipeline({
      layout,
      vertex: { module: shader, entryPoint: "vs_main", buffers: vertexLayout },
      fragment: { module: shader, entryPoint: "fs_main", targets: [{ format: "rgba16float" }] },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: depthState,
    });
    this.normalPipeline = this.device.createRenderPipeline({
      layout,
      vertex: { module: shader, entryPoint: "vs_main", buffers: vertexLayout },
      fragment: { module: shader, entryPoint: "fs_normal", targets: [{ format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: depthStateReadOnly,
    });
    this.velocityPipeline = this.device.createRenderPipeline({
      layout,
      vertex: { module: shader, entryPoint: "vs_main", buffers: vertexLayout },
      fragment: { module: shader, entryPoint: "fs_velocity", targets: [{ format: "rg16float" }] },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: depthStateReadOnly,
    });
    this.maskPipeline = this.device.createRenderPipeline({
      layout,
      vertex: { module: shader, entryPoint: "vs_main", buffers: vertexLayout },
      fragment: { module: shader, entryPoint: "fs_mask", targets: [{ format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: depthStateReadOnly,
    });
  }

  drawCubes(
    pass: GPURenderPassEncoder,
    cubes: CubeInstance[],
    camera: CameraConfig,
    prevCamera: CameraConfig | null,
  ): void {
    const proj = mat4Perspective(camera.fov, camera.aspect, camera.near, camera.far);
    const view = mat4LookAt(camera.eye, camera.target, camera.up);
    const viewProj = mat4Multiply(proj, view);

    const prevProj = prevCamera
      ? mat4Perspective(prevCamera.fov, prevCamera.aspect, prevCamera.near, prevCamera.far)
      : proj;
    const prevView = prevCamera
      ? mat4LookAt(prevCamera.eye, prevCamera.target, prevCamera.up)
      : view;
    const prevViewProj = mat4Multiply(prevProj, prevView);

    // Write frame uniforms (viewProj + prevViewProj)
    const frameData = new Float32Array(32);
    frameData.set(viewProj, 0);
    frameData.set(prevViewProj, 16);
    this.device.queue.writeBuffer(this.frameUniformBuffer, 0, frameData);

    // Write ALL instance data to the buffer BEFORE encoding any draw calls.
    // Each instance occupies 256 bytes (dynamic uniform buffer alignment).
    const stride = MrtCubeRenderer.INSTANCE_STRIDE;
    const allInstanceData = new Float32Array(stride * cubes.length / 4);
    for (let i = 0; i < cubes.length; i++) {
      const cube = cubes[i];
      const model = mat4Multiply(
        mat4Translation(cube.position[0], cube.position[1] + cube.size / 2, cube.position[2]),
        mat4Scale(cube.size),
      );
      const base = i * stride / 4;
      allInstanceData.set(model, base);
      allInstanceData[base + 16] = cube.color[0];
      allInstanceData[base + 17] = cube.color[1];
      allInstanceData[base + 18] = cube.color[2];
      allInstanceData[base + 19] = cube.selected ? 1.0 : 0.0;
    }
    this.device.queue.writeBuffer(this.instanceUniformBuffer, 0, allInstanceData);

    // Set vertex/index buffers once
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setVertexBuffer(1, this.normalBuffer);
    pass.setIndexBuffer(this.indexBuffer, "uint16");

    // Draw each cube with a dynamic offset into the instance buffer
    for (let i = 0; i < cubes.length; i++) {
      pass.setBindGroup(0, this.instanceBindGroup, [i * stride]);
      pass.drawIndexed(36);
    }
  }

  get colorPipeline(): GPURenderPipeline { return this.pipeline!; }
  get sceneColorPipeline_(): GPURenderPipeline { return this.sceneColorPipeline!; }
  get normalPipeline_(): GPURenderPipeline { return this.normalPipeline!; }
  get velocityPipeline_(): GPURenderPipeline { return this.velocityPipeline!; }
  get maskPipeline_(): GPURenderPipeline { return this.maskPipeline!; }

  dispose(): void {
    this.vertexBuffer?.destroy();
    this.normalBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.frameUniformBuffer?.destroy();
    this.instanceUniformBuffer?.destroy();
    // GPURenderPipeline.destroy() may not be available in all browsers
    try { this.pipeline?.destroy?.(); } catch { /* noop */ }
    try { this.sceneColorPipeline?.destroy?.(); } catch { /* noop */ }
    try { this.normalPipeline?.destroy?.(); } catch { /* noop */ }
    try { this.velocityPipeline?.destroy?.(); } catch { /* noop */ }
    try { this.maskPipeline?.destroy?.(); } catch { /* noop */ }
  }
}

// ── Cube grid builders ──

export function buildCubeGrid(): CubeInstance[] {
  const cubes: CubeInstance[] = [];
  const colors: [number, number, number][] = [
    [1, 0.3, 0.3], [0.3, 1, 0.3], [0.3, 0.5, 1], [1, 1, 0.3], [1, 0.3, 1], [0.3, 1, 1],
  ];
  for (let x = 0; x < 5; x++) {
    for (let z = 0; z < 5; z++) {
      const colorIdx = (x + z) % colors.length;
      const height = 1 + ((x + z * 3) % 4);
      cubes.push({
        position: [(x - 2) * 4, 0, (z - 2) * 4],
        color: colors[colorIdx],
        size: height,
      });
    }
  }
  return cubes;
}

export function buildCubeGridWithSelection(): CubeInstance[] {
  const cubes = buildCubeGrid();
  // Mark every 3rd cube as selected for outline/highlight/glow tests
  for (let i = 0; i < cubes.length; i += 3) {
    cubes[i].selected = true;
  }
  return cubes;
}
