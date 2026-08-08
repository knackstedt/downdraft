// ============================================================================
// Simplified WebGPU Renderer — minimal renderer for plugin testing
// Renders ground grid, water plane, colored agent cubes, and lighting
// ============================================================================


const GROUND_VS = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  _pad: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) color: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) color: vec3<f32>,
  @location(1) worldPos: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.clipPos = uniforms.viewProj * vec4<f32>(input.position, 1.0);
  output.color = input.color;
  output.worldPos = input.position;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let lightDir = normalize(vec3<f32>(0.5, 0.8, 0.3));
  let normal = vec3<f32>(0.0, 1.0, 0.0);
  let diff = max(dot(normal, lightDir), 0.0);
  let ambient = 0.3;
  let lighting = ambient + diff * 0.7;
  return vec4<f32>(input.color * lighting, 1.0);
}
`;

const CUBE_VS = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  _pad: f32,
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
  let zLen = Math.sqrt(z0 * z0 + z1 * z1 + z2 * z2);
  const zx = z0 / zLen, zy = z1 / zLen, zz = z2 / zLen;
  const x0 = up[1] * zz - up[2] * zy;
  const x1 = up[2] * zx - up[0] * zz;
  const x2 = up[0] * zy - up[1] * zx;
  let xLen = Math.sqrt(x0 * x0 + x1 * x1 + x2 * x2);
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
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1,
  ]);
}

function mat4Scale(sx: number, sy: number, sz: number): Float32Array {
  return new Float32Array([
    sx, 0, 0, 0,
    0, sy, 0, 0,
    0, 0, sz, 0,
    0, 0, 0, 1,
  ]);
}

export interface AgentVisual {
  position: [number, number, number];
  color: [number, number, number];
  size: number;
}

export class SimpleRenderer {
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private cubePipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private groundVertexBuffer: GPUBuffer | null = null;
  private groundVertexCount = 0;
  private cubeVertexBuffer: GPUBuffer | null = null;
  private cubeIndexBuffer: GPUBuffer | null = null;
  private cubeIndexCount = 0;
  private instanceBuffer: GPUBuffer | null = null;
  private maxInstances = 64;
  private instanceStride = 256; // WebGPU minimum uniform buffer offset alignment
  private depthTexture: GPUTexture | null = null;
  private frameGraph: FrameGraph;
  private graphColorHandle: any;
  private graphDepthHandle: any;

  constructor(device: GPUDevice, context: GPUCanvasContext, format: GPUTextureFormat) {
    this.device = device;
    this.context = context;
    this.format = format;
    this.frameGraph = new FrameGraph();
    this.graphColorHandle = this.frameGraph.importTextureView("color", null);
    this.graphDepthHandle = this.frameGraph.importTextureView("depth", null);
  }

  async init(): Promise<void> {
    // Configure context
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: "premultiplied",
    });

    // Create uniform buffer (viewProj + cameraPos)
    this.uniformBuffer = this.device.createBuffer({
      size: 80, // 64 (mat4) + 12 (vec3) + 4 (pad) = 80
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Ground grid vertices
    const groundVerts: number[] = [];
    const groundColors: number[] = [];
    const halfSize = 25;
    const gridSize = 50;
    const cellSize = (halfSize * 2) / gridSize;
    for (let z = 0; z < gridSize; z++) {
      for (let x = 0; x < gridSize; x++) {
        const wx = -halfSize + x * cellSize;
        const wz = -halfSize + z * cellSize;
        const isWater = wx > 5 || wz > 5;
        const r = isWater ? 0.05 : 0.15;
        const g = isWater ? 0.1 : 0.25;
        const b = isWater ? 0.2 : 0.1;
        // Two triangles per cell
        // Triangle 1
        groundVerts.push(wx, 0, wz, wx + cellSize, 0, wz, wx, 0, wz + cellSize);
        groundColors.push(r, g, b, r, g, b, r, g, b);
        // Triangle 2
        groundVerts.push(wx + cellSize, 0, wz, wx + cellSize, 0, wz + cellSize, wx, 0, wz + cellSize);
        groundColors.push(r, g, b, r, g, b, r, g, b);
      }
    }
    this.groundVertexCount = groundVerts.length / 3;

    const groundData = new Float32Array(groundVerts.length + groundColors.length);
    for (let i = 0; i < groundVerts.length / 3; i++) {
      groundData[i * 6] = groundVerts[i * 3];
      groundData[i * 6 + 1] = groundVerts[i * 3 + 1];
      groundData[i * 6 + 2] = groundVerts[i * 3 + 2];
      groundData[i * 6 + 3] = groundColors[i * 3];
      groundData[i * 6 + 4] = groundColors[i * 3 + 1];
      groundData[i * 6 + 5] = groundColors[i * 3 + 2];
    }

    this.groundVertexBuffer = this.device.createBuffer({
      size: groundData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.groundVertexBuffer, 0, groundData);

    // Cube geometry for agents
    const cubeVerts = [
      // Front
      -0.5, -0.5, 0.5, 0, 0, 1,
      0.5, -0.5, 0.5, 0, 0, 1,
      0.5, 0.5, 0.5, 0, 0, 1,
      -0.5, 0.5, 0.5, 0, 0, 1,
      // Back
      -0.5, -0.5, -0.5, 0, 0, -1,
      0.5, -0.5, -0.5, 0, 0, -1,
      0.5, 0.5, -0.5, 0, 0, -1,
      -0.5, 0.5, -0.5, 0, 0, -1,
      // Top
      -0.5, 0.5, -0.5, 0, 1, 0,
      0.5, 0.5, -0.5, 0, 1, 0,
      0.5, 0.5, 0.5, 0, 1, 0,
      -0.5, 0.5, 0.5, 0, 1, 0,
      // Bottom
      -0.5, -0.5, 0.5, 0, -1, 0,
      0.5, -0.5, 0.5, 0, -1, 0,
      0.5, -0.5, -0.5, 0, -1, 0,
      -0.5, -0.5, -0.5, 0, -1, 0,
      // Right
      0.5, -0.5, -0.5, 1, 0, 0,
      0.5, 0.5, -0.5, 1, 0, 0,
      0.5, 0.5, 0.5, 1, 0, 0,
      0.5, -0.5, 0.5, 1, 0, 0,
      // Left
      -0.5, -0.5, 0.5, -1, 0, 0,
      -0.5, 0.5, 0.5, -1, 0, 0,
      -0.5, 0.5, -0.5, -1, 0, 0,
      -0.5, -0.5, -0.5, -1, 0, 0,
    ];
    const cubeIndices = [
      0, 1, 2, 0, 2, 3,
      4, 6, 5, 4, 7, 6,
      8, 9, 10, 8, 10, 11,
      12, 14, 13, 12, 15, 14,
      16, 17, 18, 16, 18, 19,
      20, 22, 21, 20, 23, 22,
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

    // Instance buffer (model matrix + color per instance, padded to 256-byte alignment)
    this.instanceBuffer = this.device.createBuffer({
      size: this.maxInstances * this.instanceStride,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create ground pipeline
    const groundModule = this.device.createShaderModule({ code: GROUND_VS });
    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: groundModule,
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
        module: groundModule,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

    // Create cube pipeline
    const cubeModule = this.device.createShaderModule({ code: CUBE_VS });
    this.cubePipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: cubeModule,
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
        module: cubeModule,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });
  }

  render(agents: AgentVisual[], canvasWidth: number, canvasHeight: number): void {
    if (!this.pipeline || !this.cubePipeline) return;

    // Update depth texture if size changed
    if (!this.depthTexture || this.depthTexture.width !== canvasWidth || this.depthTexture.height !== canvasHeight) {
      this.depthTexture?.destroy();
      this.depthTexture = this.device.createTexture({
        size: [canvasWidth, canvasHeight],
        format: "depth24plus",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }

    // Compute view-projection
    const eye: [number, number, number] = [15, 20, 25];
    const target: [number, number, number] = [0, 0, 0];
    const up: [number, number, number] = [0, 1, 0];
    const proj = mat4Perspective(Math.PI / 4, canvasWidth / canvasHeight, 0.1, 100);
    const view = mat4LookAt(eye, target, up);
    const viewProj = mat4Multiply(proj, view);

    const uniformData = new Float32Array(20);
    uniformData.set(viewProj, 0);
    uniformData.set(eye, 16);
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, uniformData);

    // Update instance data (256-byte stride per instance)
    const instanceCount = Math.min(agents.length, this.maxInstances);
    const instanceData = new Float32Array(this.maxInstances * (this.instanceStride / 4));
    for (let i = 0; i < instanceCount; i++) {
      const agent = agents[i];
      const model = mat4Multiply(
        mat4Translate(agent.position[0], agent.position[1] + agent.size / 2, agent.position[2]),
        mat4Scale(agent.size, agent.size, agent.size),
      );
      const base = i * (this.instanceStride / 4);
      instanceData.set(model, base);
      instanceData[base + 16] = agent.color[0];
      instanceData[base + 17] = agent.color[1];
      instanceData[base + 18] = agent.color[2];
    }
    this.device.queue.writeBuffer(this.instanceBuffer!, 0, instanceData);

    // Render — drive through FrameGraph
    const encoder = this.device.createCommandEncoder();
    const colorView = this.context.getCurrentTexture().createView();
    const depthView = this.depthTexture!.createView();
    this.frameGraph.setImportedTextureView(this.graphColorHandle, colorView);
    this.frameGraph.setImportedTextureView(this.graphDepthHandle, depthView);
    this.frameGraph.clearPasses();
    this.frameGraph.addPass(new TesterScenePass(
      this.graphColorHandle,
      this.graphDepthHandle,
      (pass: GPURenderPassEncoder) => {
        // Draw ground
        pass.setPipeline(this.pipeline!);
        pass.setBindGroup(0, this.device.createBindGroup({
          layout: this.pipeline!.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: this.uniformBuffer! } }],
        }));
        pass.setVertexBuffer(0, this.groundVertexBuffer!);
        pass.draw(this.groundVertexCount);

        // Draw agent cubes
        pass.setPipeline(this.cubePipeline!);
        for (let i = 0; i < instanceCount; i++) {
          const dynamicOffset = i * this.instanceStride;
          pass.setBindGroup(0, this.device.createBindGroup({
            layout: this.cubePipeline!.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: this.uniformBuffer! } },
              { binding: 1, resource: { buffer: this.instanceBuffer!, offset: dynamicOffset, size: 80 } },
            ],
          }));
          pass.setVertexBuffer(0, this.cubeVertexBuffer!);
          pass.setIndexBuffer(this.cubeIndexBuffer!, "uint16");
          pass.drawIndexed(this.cubeIndexCount);
        }
      },
    ));
    this.frameGraph.compile(this.device, canvasWidth, canvasHeight);
    const ctx: RenderContext = {
      device: this.device,
      encoder,
      pass: null,
      camera: { position: [0,0,0], target: [0,0,-1], up: [0,1,0], fov: 60, near: 0.1, far: 1000, aspect: 1 },
      viewport: { x: 0, y: 0, w: canvasWidth, h: canvasHeight },
      viewportIdx: 0,
      viewportCount: 1,
      dt: 0,
      elapsedTime: 0,
      isFirstViewport: true,
      isLastViewport: true,
      width: canvasWidth,
      height: canvasHeight,
      viewProj: undefined as any,
      invViewProj: undefined as any,
      prevViewProj: undefined as any,
      cameraPos: [0, 0, 0],
      lightData: null as any,
      lightViewProj: undefined as any,
      mesh: null as any,
      modelMatrix: undefined as any,
      shadowsEnabled: false,
      bloomEnabled: false,
      shadowSampler: null,
      debugQueue: null,
      opaqueVertexBuffer: null,
      opaqueIndexBuffer: null,
      opaqueIndexCount: 0,
      opaqueIndexFormat: "uint32",
      getView: (h: any) => this.frameGraph.getTextureView(h),
      getTexture: (h: any) => this.frameGraph.getTexture(h),
      addDrawCalls: () => {},
      addTriangles: () => {},
    };
    this.frameGraph.execute(ctx);
    this.device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.depthTexture?.destroy();
    this.groundVertexBuffer?.destroy();
    this.cubeVertexBuffer?.destroy();
    this.cubeIndexBuffer?.destroy();
    this.instanceBuffer?.destroy();
    this.uniformBuffer?.destroy();
  }
}

// ─── FrameGraph integration ────────────────────────────────────────────────

/**
 * TesterScenePass — a single FrameGraph pass that owns the color+depth
 * attachments for the plugin-tester render loop and delegates ground + cube
 * sub-draws to a callback.
 */
class TesterScenePass extends RenderPass {
  name = "TesterScene";
  passType = PassType.Render;
  private colorHandle: any;
  private depthHandle: any;
  private drawFn: (pass: GPURenderPassEncoder) => void;

  constructor(
    colorHandle: any,
    depthHandle: any,
    drawFn: (pass: GPURenderPassEncoder) => void,
  ) {
    super();
    this.colorHandle = colorHandle;
    this.depthHandle = depthHandle;
    this.drawFn = drawFn;
  }

  setup(builder: FrameGraphBuilder): void {
    builder.colorAttachment({
      handle: this.colorHandle,
      loadOp: "clear",
      storeOp: "store",
      clearValue: { r: 0.04, g: 0.04, b: 0.07, a: 1 },
    });
    builder.depthAttachment({
      handle: this.depthHandle,
      depthLoadOp: "clear",
      depthStoreOp: "store",
      depthClearValue: 1.0,
    });
  }

  prepare(): void {}

  execute(ctx: RenderContext): void {
    if (!ctx.pass) return;
    const rawEncoder = ctx.pass.getRawPass() as GPURenderPassEncoder;
    this.drawFn(rawEncoder);
  }
}
