import {
    buildThickLineIndices,
    buildThickLineVertices,
    computeSkeleton,
    DEFAULT_LINE_WIDTH,
    STICKMAN_INDEX_COUNT,
    STICKMAN_VERTEX_COUNT,
    STICKMAN_VERTEX_STRIDE,
    STICKMAN_WGSL,
    type ThickLineGeometry,
} from "@downdraft/library-stickman";

// Uniform layout (must match StickmanUniforms in STICKMAN_WGSL):
//   transform: vec4  (scaleX, scaleY, offsetX, offsetY)
//   screenSize: vec2 + lineWidth: f32 + pad: f32   -> 16 bytes
//   color: vec3 + pad: f32                          -> 16 bytes
// Total = 48 bytes = 12 float32s.
const UNIFORM_SIZE = 48;
const UNIFORM_FLOATS = 12;

export class StickmanPass {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private dummyLight: GPUTexture | null = null;
  private dummyLightView: GPUTextureView | null = null;
  gridW: number;
  gridH: number;

  // Reused each frame to avoid allocation.
  private skeleton: Float32Array;
  private geom: ThickLineGeometry;

  constructor(device: GPUDevice, format: GPUTextureFormat, gridW: number, gridH: number) {
    this.device = device;
    this.format = format;
    this.gridW = gridW;
    this.gridH = gridH;
    this.skeleton = new Float32Array(0);
    this.geom = { vertices: new Float32Array(0), indices: new Uint16Array(0), vertexCount: 0, indexCount: 0 };
  }

  init(): void {
    this.uniformBuffer = this.device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // 1x1 dummy white textures for the light + volumetric bindings.
    // falling-sand has no light-accum pass, so lighting is identity (white).
    this.dummyLight = this.device.createTexture({
      size: [1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.dummyLightView = this.dummyLight.createView();
    this.device.queue.writeTexture(
      { texture: this.dummyLight },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4, rowsPerImage: 1 },
      [1, 1],
    );

    // Static-size vertex buffer (rewritten each frame) + static index buffer.
    this.vertexBuffer = this.device.createBuffer({
      size: STICKMAN_VERTEX_COUNT * STICKMAN_VERTEX_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    const indices = buildThickLineIndices();
    this.indexBuffer = this.device.createBuffer({
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.indexBuffer, 0, indices as unknown as BufferSource);

    const shader = this.device.createShaderModule({ code: STICKMAN_WGSL });

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shader,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: STICKMAN_VERTEX_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },  // endpointA
            { shaderLocation: 1, offset: 12, format: "float32x3" }, // endpointB
            { shaderLocation: 2, offset: 24, format: "float32x2" }, // cornerVec
          ],
        }],
      },
      fragment: { module: shader, entryPoint: "fs_main", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list" },
    });

    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.dummyLightView },
        { binding: 2, resource: this.dummyLightView },
      ],
    });
  }

  resize(gridW: number, gridH: number): void {
    this.gridW = gridW;
    this.gridH = gridH;
  }

  update(
    px: number, py: number, facing: number, animFrame: number,
    health: number, onGround: boolean, vx: number, _vy: number,
  ): void {
    if (!this.vertexBuffer || !this.uniformBuffer) return;

    // --- Skeleton -> thick-line vertices ---
    this.skeleton = computeSkeleton(
      { cx: px, topY: py, facing, animFrame, vx, onGround },
      this.skeleton,
    );
    this.geom = buildThickLineVertices(this.skeleton, this.geom);
    this.device.queue.writeBuffer(this.vertexBuffer, 0, this.geom.vertices as unknown as BufferSource);

    // --- Uniforms: transform (grid cell coords -> NDC) + screenSize + lineWidth + color ---
    // gridToClip: nx = gx/gridW*2 - 1, ny = gy/gridH*2 - 1 (then flip Y for screen).
    const scaleX = 2 / this.gridW;
    const scaleY = -2 / this.gridH;
    const offsetX = -1;
    const offsetY = 1;

    const hp = Math.max(0, Math.min(1, health / 100));
    let r: number, g: number, b: number;
    if (hp > 0.5) {
      const t = (hp - 0.5) * 2;
      r = 1.0 - t;
      g = 0.85 + (1.0 - 0.85) * t;
      b = 0.2 * t;
    } else {
      const t = hp * 2;
      r = 1.0;
      g = 0.85 * t;
      b = 0.0;
    }

    const data = new Float32Array(UNIFORM_FLOATS);
    data[0] = scaleX;
    data[1] = scaleY;
    data[2] = offsetX;
    data[3] = offsetY;
    data[4] = this.gridW;
    data[5] = this.gridH;
    data[6] = DEFAULT_LINE_WIDTH;
    data[7] = 0; // pad
    data[8] = r;
    data[9] = g;
    data[10] = b;
    data[11] = 0; // pad
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
  }

  render(pass: GPURenderPassEncoder): void {
    if (!this.pipeline || !this.bindGroup || !this.vertexBuffer || !this.indexBuffer) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, "uint16");
    pass.drawIndexed(STICKMAN_INDEX_COUNT);
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.dummyLight?.destroy();
  }
}
