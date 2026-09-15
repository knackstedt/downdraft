import { createValidatedShaderModule } from "@downdraft/core";
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
import type { StructView, WgslStruct } from "@downdraft/shader-graph";
import { f32, vec2f, vec3f, vec4f, wgsl } from "@downdraft/shader-graph";

// ─── Uniform struct (must match StickmanUniforms in STICKMAN_WGSL) ──────────
const StickmanUniformsStruct: WgslStruct = wgsl.struct("StickmanUniforms", {
  transform: vec4f,
  screenSize: vec2f,
  lineWidth: f32,
  color: vec3f,
});

const UNIFORM_SIZE = StickmanUniformsStruct.size;
const UNIFORM_FLOATS = StickmanUniformsStruct.floatCount;

export class StickmanPass {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private lightView: GPUTextureView | null = null;
  private volumetricView: GPUTextureView | null = null;
  private dummyTexture: GPUTexture | null = null;
  private dummyView: GPUTextureView | null = null;

  // Preallocated uniform buffer (avoid per-frame allocation)
  private _uniformBuf: Float32Array<ArrayBuffer> | null = null;
  private _uniformView: StructView | null = null;

  // Reused each frame to avoid allocation.
  private skeleton: Float32Array;
  private geom: ThickLineGeometry;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
    this.skeleton = new Float32Array(0);
    this.geom = { vertices: new Float32Array(0), indices: new Uint16Array(0), vertexCount: 0, indexCount: 0 };
  }

  init(): void {
    this.uniformBuffer = this.device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._uniformBuf = new Float32Array(UNIFORM_FLOATS);
    this._uniformView = StickmanUniformsStruct.view(this._uniformBuf);

    // 1x1 dummy white texture for the light/volumetric bindings (before the
    // real views are set each frame). Lighting becomes identity (white).
    this.dummyTexture = this.device.createTexture({
      size: [1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.dummyView = this.dummyTexture.createView();
    this.device.queue.writeTexture(
      { texture: this.dummyTexture },
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

    const shader = createValidatedShaderModule(this.device, { code: STICKMAN_WGSL, label: "StickmanPass" });

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

    this.createBindGroup();
  }

  private createBindGroup(): void {
    if (!this.bindGroupLayout || !this.uniformBuffer || !this.dummyView) return;
    const lView = this.lightView ?? this.dummyView;
    const vView = this.volumetricView ?? this.dummyView;
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: lView },
        { binding: 2, resource: vView },
      ],
    });
  }

  /** Set the light accumulation texture view (called each frame by the renderer). */
  setLightTexture(view: GPUTextureView | null): void {
    if (this.lightView === view) return;
    this.lightView = view;
    this.createBindGroup();
  }

  /** Set the volumetric light texture view (called each frame by the renderer). */
  setVolumetricTexture(view: GPUTextureView | null): void {
    if (this.volumetricView === view) return;
    this.volumetricView = view;
    this.createBindGroup();
  }

  update(
    px: number, py: number, facing: number, animFrame: number,
    camX: number, camY: number, zoom: number,
    canvasW: number, canvasH: number,
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

    // --- Uniforms: transform (cell coords -> NDC) + screenSize + lineWidth + color ---
    const scaleX = (zoom * 2) / canvasW;
    const scaleY = (-zoom * 2) / canvasH;
    const offsetX = -camX * scaleX;
    const offsetY = -camY * scaleY;

    const hp = Math.max(0, Math.min(1, health / 100));
    let r: number, g: number, b: number;
    if (hp > 0.5) {
      // yellow -> green
      const t = (hp - 0.5) * 2;
      r = 1.0 - t;
      g = 0.85 + (1.0 - 0.85) * t;
      b = 0.2 * t;
    } else {
      // red -> yellow
      const t = hp * 2;
      r = 1.0;
      g = 0.85 * t;
      b = 0.0;
    }

    const view = this._uniformView!;
    view.set("transform", [scaleX, scaleY, offsetX, offsetY]);
    view.set("screenSize", [canvasW, canvasH]);
    view.set("lineWidth", DEFAULT_LINE_WIDTH);
    view.set("color", [r, g, b]);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this._uniformBuf!);
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
    this.dummyTexture?.destroy();
    this._uniformBuf = null;
    this._uniformView = null;
  }
}
