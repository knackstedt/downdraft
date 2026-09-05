// ============================================================================
// WebGPU Renderer — sandbox rendering engine
// Extends GameRenderer for device/surface init, runs a custom render loop
// for skybox, ground plane, and prop model rendering.
// ============================================================================

import {
  BindlessFrameBindings, BindlessMaterialManager, BindlessTextureRegistry,
  DEPTH_FORMAT, ENT, GameRenderer,
  InputBufferWriter, MSAA_SAMPLE_COUNT, SimBufferReader,
  calculateViewProjInto, type CameraState,
} from "@downdraft/core";
import { ModelRenderer } from "@downdraft/library-entities";
import { loadModel, type ModelData } from "@downdraft/library-models";
import { EntityType } from "@sandbox/shared/types";

// Simple skybox gradient shader (full-screen triangle at depth = far)
const SKY_SHADER = /* wgsl */ `
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0),
  );
  return vec4f(pos[vi], 0.999, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let t = clamp(pos.y / 1080.0, 0.0, 1.0);
  let top = vec3f(0.4, 0.6, 0.9);
  let bottom = vec3f(0.7, 0.85, 1.0);
  return vec4f(mix(bottom, top, t), 1.0);
}
`;

// Ground plane shader
const GROUND_SHADER = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4f,
  cameraPos: vec3f,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(1) @binding(0) var paintTex: texture_2d<f32>;
@group(1) @binding(1) var paintSampler: sampler;

@vertex
fn vs(@location(0) pos: vec3f) -> @builtin(position) vec4f {
  return u.viewProj * vec4f(pos, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let worldPos = pos.xyz;
  let gridSize = 4.0;
  let gx = abs(worldPos.x - floor(worldPos.x / gridSize) * gridSize);
  let gz = abs(worldPos.z - floor(worldPos.z / gridSize) * gridSize);
  let edge = min(gx, gz);
  let lineWidth = 0.05;
  let grid = smoothstep(0.0, lineWidth, edge);
  let groundColor = vec3f(0.5, 0.5, 0.55);
  let gridColor = vec3f(0.3, 0.3, 0.35);
  let baseColor = mix(gridColor, groundColor, grid);
  // Sample paint texture (512m ground → 512px texture, 1m = 1px)
  let paintUV = vec2f(worldPos.x / 512.0 + 0.5, worldPos.z / 512.0 + 0.5);
  let paint = textureSample(paintTex, paintSampler, paintUV);
  let color = mix(baseColor, paint.rgb, paint.a);
  let dist = length(worldPos.xz - u.cameraPos.xz);
  let fog = clamp(1.0 - dist / 500.0, 0.0, 1.0);
  return vec4f(color * fog + vec3f(0.5, 0.6, 0.7) * (1.0 - fog), 1.0);
}
`;

// Procedural cube shader with paint texture support.
const CUBE_SHADER = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4f,
  cameraPos: vec3f,
};
struct Instance {
  model: mat4x4f,
  color: vec4f,
  hasPaint: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<uniform> inst: Instance;
@group(1) @binding(0) var paintTex: texture_2d<f32>;
@group(1) @binding(1) var paintSampler: sampler;

@vertex
fn vs(@location(0) pos: vec3f, @location(1) uv: vec2f) -> VertexOut {
  var out: VertexOut;
  out.position = u.viewProj * inst.model * vec4f(pos, 1.0);
  out.uv = uv;
  return out;
}

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let baseColor = inst.color.rgb;
  if (inst.hasPaint == 1u) {
    let paint = textureSample(paintTex, paintSampler, uv);
    return vec4f(mix(baseColor, paint.rgb, paint.a), 1.0);
  }
  return vec4f(baseColor, 1.0);
}
`;

// Cube vertices: position(3) + uv(2) per vertex, 24 vertices (4 per face)
const CUBE_VERTICES = new Float32Array([
  // +X face
   0.5, -0.5, -0.5,  0.0, 0.0,
   0.5,  0.5, -0.5,  0.0, 1.0,
   0.5,  0.5,  0.5,  1.0, 1.0,
   0.5, -0.5,  0.5,  1.0, 0.0,
  // -X face
  -0.5, -0.5,  0.5,  0.0, 0.0,
  -0.5,  0.5,  0.5,  0.0, 1.0,
  -0.5,  0.5, -0.5,  1.0, 1.0,
  -0.5, -0.5, -0.5,  1.0, 0.0,
  // +Y face
  -0.5,  0.5, -0.5,  0.0, 0.0,
  -0.5,  0.5,  0.5,  0.0, 1.0,
   0.5,  0.5,  0.5,  1.0, 1.0,
   0.5,  0.5, -0.5,  1.0, 0.0,
  // -Y face
  -0.5, -0.5,  0.5,  0.0, 0.0,
  -0.5, -0.5, -0.5,  0.0, 1.0,
   0.5, -0.5, -0.5,  1.0, 1.0,
   0.5, -0.5,  0.5,  1.0, 0.0,
  // +Z face
  -0.5, -0.5,  0.5,  0.0, 0.0,
   0.5, -0.5,  0.5,  0.0, 1.0,
   0.5,  0.5,  0.5,  1.0, 1.0,
  -0.5,  0.5,  0.5,  1.0, 0.0,
  // -Z face
   0.5, -0.5, -0.5,  0.0, 0.0,
  -0.5, -0.5, -0.5,  0.0, 1.0,
  -0.5,  0.5, -0.5,  1.0, 1.0,
   0.5,  0.5, -0.5,  1.0, 0.0,
]);

const CUBE_INDICES = new Uint16Array([
  0, 1, 2,  0, 2, 3,    // +X
  4, 5, 6,  4, 6, 7,    // -X
  8, 9, 10, 8, 10, 11,  // +Y
  12, 13, 14, 12, 14, 15, // -Y
  16, 17, 18, 16, 18, 19, // +Z
  20, 21, 22, 20, 22, 23, // -Z
]);

const GROUND_SIZE = 512; // 512×512m ground plane

export class WebGPURenderer extends GameRenderer {
  private simReader: SimBufferReader | null = null;
  private inputWriter: InputBufferWriter | null = null;
  private modelRenderer: ModelRenderer | null = null;
  private bindlessRegistry: BindlessTextureRegistry | null = null;
  private bindlessMaterialManager: BindlessMaterialManager | null = null;
  private bindlessFrameBindings: BindlessFrameBindings | null = null;

  // Skybox pipeline
  private skyPipeline: GPURenderPipeline | null = null;
  // Ground plane pipeline + buffers
  private groundPipeline: GPURenderPipeline | null = null;
  private groundVertexBuffer: GPUBuffer | null = null;
  private groundUniformBuffer: GPUBuffer | null = null;
  private groundBindGroup: GPUBindGroup | null = null;
  private groundPaintTexture: GPUTexture | null = null;
  private groundPaintSampler: GPUSampler | null = null;
  private groundPaintBindGroup: GPUBindGroup | null = null;

  // Procedural cube pipeline (for builtin props without model files)
  private cubePipeline: GPURenderPipeline | null = null;
  private cubeVertexBuffer: GPUBuffer | null = null;
  private cubeIndexBuffer: GPUBuffer | null = null;
  private cubeIndexCount = CUBE_INDICES.length;
  private cubeUniformBuffer: GPUBuffer | null = null;
  private cubeInstanceBuffer: GPUBuffer | null = null;
  private cubeSampler: GPUSampler | null = null;
  private cubeDefaultTexture: GPUTexture | null = null;

  // Render loop
  private rafHandle = 0;
  private sandboxRunning = false;
  private sandboxLastTime = 0;
  private _elapsedTime = 0;
  private _deviceLost = false;

  // Camera state
  private camPos: [number, number, number] = [0, 5, 10];
  private camTarget: [number, number, number] = [0, 0, 0];
  private camUp: [number, number, number] = [0, 1, 0];
  private camFov = 60;
  private camNear = 0.1;
  private camFar = 2000;

  // Model loading: contentId → ModelData (cached)
  private modelCache = new Map<string, ModelData>();
  // nodeId → contentId mapping
  private nodeToContent = new Map<string, string>();
  private nextNodeId = 1;

  // Depth texture
  private depthTexture: GPUTexture | null = null;
  private depthTextureW = 0;
  private depthTextureH = 0;

  setSimReader(sab: SharedArrayBuffer): void {
    this.simReader = new SimBufferReader(sab);
  }

  setInputWriter(sab: SharedArrayBuffer): void {
    this.inputWriter = new InputBufferWriter(sab);
  }

  getModelRenderer(): ModelRenderer | null { return this.modelRenderer; }
  getBindlessRegistry(): BindlessTextureRegistry | null { return this.bindlessRegistry; }
  getBindlessMaterialManager(): BindlessMaterialManager | null { return this.bindlessMaterialManager; }
  getBindlessFrameBindings(): BindlessFrameBindings | null { return this.bindlessFrameBindings; }

  async init(): Promise<boolean> {
    const ok = await super.init();
    if (!ok) return false;

    try {
      const device = this.getDevice()!;
      const format = this.getFormat();

      device.lost.then(() => { this._deviceLost = true; });

      // Bindless material binding model
      this.bindlessRegistry = new BindlessTextureRegistry(device);
      this.bindlessMaterialManager = new BindlessMaterialManager(device);
      this.bindlessFrameBindings = new BindlessFrameBindings(
        device, this.bindlessRegistry, this.bindlessMaterialManager,
      );

      // Model renderer for props
      this.modelRenderer = new ModelRenderer(device, format);
      this.modelRenderer.setBindlessDeps({
        registry: this.bindlessRegistry,
        materialManager: this.bindlessMaterialManager,
        bindGroupLayout: this.bindlessFrameBindings.getBindGroupLayout(),
      });
      await this.modelRenderer.init();

      this.createSkyPipeline(device, format);
      this.createGroundPipeline(device, format);
      this.createCubePipeline(device, format);

      this.setViewportCount(1);
      this.sandboxRunning = true;
      this.sandboxLastTime = performance.now();
      this.rafHandle = requestAnimationFrame(this.frameLoop);
      return true;
    } catch (err) {
      console.error("[WebGPURenderer] Init failed:", err);
      return false;
    }
  }

  private createSkyPipeline(device: GPUDevice, format: GPUTextureFormat): void {
    const shader = device.createShaderModule({ label: "sky", code: SKY_SHADER });
    this.skyPipeline = device.createRenderPipeline({
      label: "sky",
      layout: "auto",
      vertex: { module: shader, entryPoint: "vs" },
      fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        format: DEPTH_FORMAT as GPUTextureFormat,
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
    });
  }

  private createGroundPipeline(device: GPUDevice, format: GPUTextureFormat): void {
    const h = GROUND_SIZE / 2;
    const vertices = new Float32Array([
      -h, 0, -h,  h, 0, -h,  h, 0,  h,
      -h, 0, -h,  h, 0,  h,  -h, 0,  h,
    ]);
    this.groundVertexBuffer = device.createBuffer({
      label: "ground-vertices",
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.groundVertexBuffer, 0, vertices);

    this.groundUniformBuffer = device.createBuffer({
      label: "ground-uniforms",
      size: 80, // mat4x4 (64) + vec3 (12) + padding (4)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const shader = device.createShaderModule({ label: "ground", code: GROUND_SHADER });
    this.groundPipeline = device.createRenderPipeline({
      label: "ground",
      layout: "auto",
      vertex: {
        module: shader, entryPoint: "vs",
        buffers: [{
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
        }],
      },
      fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        format: DEPTH_FORMAT as GPUTextureFormat,
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

    this.groundBindGroup = device.createBindGroup({
      label: "ground-bindgroup",
      layout: this.groundPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.groundUniformBuffer } }],
    });

    // Ground paint texture (512×512, updated by paint system)
    this.groundPaintTexture = device.createTexture({
      label: "ground-paint",
      size: [512, 512],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // Clear to transparent
    const clearData = new Uint8Array(512 * 512 * 4); // all zeros = transparent
    device.queue.writeTexture(
      { texture: this.groundPaintTexture },
      clearData,
      { bytesPerRow: 512 * 4 },
      { width: 512, height: 512 },
    );
    this.groundPaintSampler = device.createSampler({
      label: "ground-paint-sampler",
      magFilter: "linear",
      minFilter: "linear",
    });
    this.groundPaintBindGroup = device.createBindGroup({
      label: "ground-paint-bindgroup",
      layout: this.groundPipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: this.groundPaintTexture.createView() },
        { binding: 1, resource: this.groundPaintSampler },
      ],
    });
  }

  private createCubePipeline(device: GPUDevice, format: GPUTextureFormat): void {
    // Vertex buffer: position(3) + uv(2) = 20 bytes per vertex
    this.cubeVertexBuffer = device.createBuffer({
      label: "cube-vertices",
      size: CUBE_VERTICES.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.cubeVertexBuffer, 0, CUBE_VERTICES);

    // Index buffer
    this.cubeIndexBuffer = device.createBuffer({
      label: "cube-indices",
      size: CUBE_INDICES.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.cubeIndexBuffer, 0, CUBE_INDICES);

    // Uniform buffer: viewProj(64) + cameraPos(12) + pad(4) = 80 bytes
    this.cubeUniformBuffer = device.createBuffer({
      label: "cube-uniforms",
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Instance buffer: model(64) + color(16) + hasPaint(4) + pad(12) = 96 bytes
    this.cubeInstanceBuffer = device.createBuffer({
      label: "cube-instance",
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Default white texture (1×1) for props without paint
    this.cubeDefaultTexture = device.createTexture({
      label: "cube-default-tex",
      size: [1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const white = new Uint8Array([255, 255, 255, 255]);
    device.queue.writeTexture(
      { texture: this.cubeDefaultTexture },
      white,
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    );

    // Sampler
    this.cubeSampler = device.createSampler({
      label: "cube-sampler",
      magFilter: "linear",
      minFilter: "linear",
    });

    const shader = device.createShaderModule({ label: "cube", code: CUBE_SHADER });
    this.cubePipeline = device.createRenderPipeline({
      label: "cube",
      layout: "auto",
      vertex: {
        module: shader, entryPoint: "vs",
        buffers: [{
          arrayStride: 20,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x2" },
          ],
        }],
      },
      fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: {
        format: DEPTH_FORMAT as GPUTextureFormat,
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });
  }

  // ── Load a model and upload it to the ModelRenderer ──
  async loadPropModel(contentId: string, modelUri: string): Promise<string> {
    const nodeId = `prop-${this.nextNodeId++}`;
    if (this.modelCache.has(contentId)) {
      const model = this.modelCache.get(contentId)!;
      this.modelRenderer!.uploadModel(nodeId, model.meshes, model.materials);
      this.nodeToContent.set(nodeId, contentId);
      return nodeId;
    }
    try {
      const resp = await fetch(modelUri);
      const buffer = await resp.arrayBuffer();
      const filename = modelUri.split("/").pop() ?? "model.glb";
      const model = await loadModel(buffer, filename) as ModelData;
      this.modelCache.set(contentId, model);
      this.modelRenderer!.uploadModel(nodeId, model.meshes, model.materials);
      this.nodeToContent.set(nodeId, contentId);
      return nodeId;
    } catch (err) {
      console.error(`[WebGPURenderer] Failed to load model ${modelUri}:`, err);
      return "";
    }
  }

  // ── Camera control ──
  setCameraPosition(pos: [number, number, number]): void { this.camPos = pos; }
  setCameraTarget(target: [number, number, number]): void { this.camTarget = target; }
  getCameraPosition(): [number, number, number] { return this.camPos; }
  getCameraTarget(): [number, number, number] { return this.camTarget; }

  // ── Paint texture upload ──
  private paintTextures = new Map<number, GPUTexture>();
  uploadPaintTexture(entityId: number, data: Uint8ClampedArray, width: number, height: number): void {
    const device = this.getDevice();
    if (!device) return;
    if (!this.paintTextures.has(entityId)) {
      const tex = device.createTexture({
        label: `paint-${entityId}`,
        size: [width, height],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.paintTextures.set(entityId, tex);
    }
    const tex = this.paintTextures.get(entityId)!;
    device.queue.writeTexture(
      { texture: tex },
      new Uint8Array(data),
      { bytesPerRow: width * 4 },
      { width, height },
    );
  }

  uploadGroundPaintTexture(data: Uint8ClampedArray, width: number, height: number): void {
    const device = this.getDevice();
    if (!device || !this.groundPaintTexture) return;
    device.queue.writeTexture(
      { texture: this.groundPaintTexture },
      new Uint8Array(data),
      { bytesPerRow: width * 4 },
      { width, height },
    );
  }

  // ── Render loop ──
  private frameLoop = (): void => {
    if (!this.sandboxRunning || this._deviceLost) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.sandboxLastTime) / 1000);
    this.sandboxLastTime = now;
    this._elapsedTime += dt;

    try {
      this.drawFrame(dt);
    } catch (err) {
      console.error(`[WebGPURenderer] Frame error: ${(err as Error).message}`);
    }
    this.rafHandle = requestAnimationFrame(this.frameLoop);
  };

  private drawFrame(_dt: number): void {
    const device = this.getDevice();
    const context = this.getContext();
    if (!device || !context || !this.skyPipeline || !this.groundPipeline) return;

    const canvas = this.getCanvas();
    const colorView = context.getCurrentTexture().createView();
    const depthTexture = this.getOrCreateDepthTexture(canvas.width, canvas.height);
    const depthView = depthTexture.createView();

    // Camera view-projection
    const aspect = canvas.width / canvas.height;
    const cameraState: CameraState = {
      position: this.camPos,
      target: this.camTarget,
      up: this.camUp,
      fov: this.camFov,
      aspect,
      near: this.camNear,
      far: this.camFar,
    };
    const viewProj = new Float32Array(16);
    calculateViewProjInto(cameraState, viewProj);

    // Update ground uniforms
    const uniformData = new Float32Array(20);
    uniformData.set(viewProj, 0);
    uniformData[16] = this.camPos[0];
    uniformData[17] = this.camPos[1];
    uniformData[18] = this.camPos[2];
    device.queue.writeBuffer(this.groundUniformBuffer!, 0, uniformData);

    // Prepare bindless frame bindings
    if (this.bindlessFrameBindings) {
      this.bindlessFrameBindings.prepareFrame();
    }

    const encoder = device.createCommandEncoder();

    // Sky + ground + props render pass
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: colorView,
        clearValue: { r: 0.5, g: 0.7, b: 0.9, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });

    // Sky (full-screen triangle, depth = far)
    pass.setPipeline(this.skyPipeline);
    pass.draw(3);

    // Ground plane
    pass.setPipeline(this.groundPipeline);
    pass.setBindGroup(0, this.groundBindGroup!);
    if (this.groundPaintBindGroup) pass.setBindGroup(1, this.groundPaintBindGroup);
    pass.setVertexBuffer(0, this.groundVertexBuffer!);
    pass.draw(6);

    // Props — builtin (procedural cubes) + model-based
    if (this.simReader) {
      this.renderBuiltinProps(pass, viewProj);
      if (this.modelRenderer) this.renderProps(pass);
    }

    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  private renderProps(pass: GPURenderPassEncoder): void {
    if (!this.modelRenderer || !this.simReader) return;
    const count = this.simReader.getEntityCount();
    for (let i = 0; i < count; i++) {
      const slot = this.simReader.getEntitySlot(i);
      const type = slot.u32[ENT.TYPE];
      if (type !== EntityType.Prop && type !== EntityType.Mannequin) continue;
      const nodeIdRaw = slot.u32[ENT.ID];
      if (nodeIdRaw === 0) continue; // builtin prop (rendered as cube) or not yet uploaded
      const nodeId = `prop-${nodeIdRaw}`;
      if (!this.nodeToContent.has(nodeId)) continue;

      const px = slot.f32[ENT.POS_X];
      const py = slot.f32[ENT.POS_Y];
      const pz = slot.f32[ENT.POS_Z];
      const scale = slot.f32[ENT.SCALE];
      const rx = slot.f32[ENT.ROT_X];
      const ry = slot.f32[ENT.ROT_Y];
      const rz = slot.f32[ENT.ROT_Z];
      const rw = slot.f32[ENT.ROT_W];

      this.modelRenderer.render(
        pass,
        nodeId,
        [px, py, pz],
        [rx, ry, rz, rw],
        [scale, scale, scale],
      );
    }
  }

  // ── Render builtin props (cube/sphere) as procedural cubes with paint texture ──
  private renderBuiltinProps(pass: GPURenderPassEncoder, viewProj: Float32Array): void {
    if (!this.simReader || !this.cubePipeline || !this.cubeVertexBuffer || !this.cubeIndexBuffer) return;
    if (!this.cubeUniformBuffer || !this.cubeInstanceBuffer || !this.cubeSampler) return;
    const device = this.getDevice()!;
    const count = this.simReader.getEntityCount();
    if (count === 0) return;

    // Write shared uniforms (viewProj + cameraPos)
    const uniformData = new Float32Array(20);
    uniformData.set(viewProj, 0);
    uniformData[16] = this.camPos[0];
    uniformData[17] = this.camPos[1];
    uniformData[18] = this.camPos[2];
    device.queue.writeBuffer(this.cubeUniformBuffer, 0, uniformData);

    const bindGroup0 = device.createBindGroup({
      layout: this.cubePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cubeUniformBuffer } },
        { binding: 1, resource: { buffer: this.cubeInstanceBuffer } },
      ],
    });

    pass.setPipeline(this.cubePipeline);
    pass.setBindGroup(0, bindGroup0);
    pass.setVertexBuffer(0, this.cubeVertexBuffer);
    pass.setIndexBuffer(this.cubeIndexBuffer, "uint16");

    for (let i = 0; i < count; i++) {
      const slot = this.simReader.getEntitySlot(i);
      const type = slot.u32[ENT.TYPE];
      if (type !== EntityType.Prop && type !== EntityType.Mannequin && type !== EntityType.Projectile) continue;
      const nodeIdRaw = slot.u32[ENT.ID];
      if (nodeIdRaw !== 0) continue; // has a model — skip, rendered by renderProps

      const px = slot.f32[ENT.POS_X];
      const py = slot.f32[ENT.POS_Y];
      const pz = slot.f32[ENT.POS_Z];
      const scale = slot.f32[ENT.SCALE] || 1.0;
      const rx = slot.f32[ENT.ROT_X];
      const ry = slot.f32[ENT.ROT_Y];
      const rz = slot.f32[ENT.ROT_Z];
      const rw = slot.f32[ENT.ROT_W];

      // Build model matrix from TRS
      const model = this.composeModelMatrix(px, py, pz, rx, ry, rz, rw, scale);

      // Color: projectile = red, mannequin = gray, prop = blue-ish
      let color: [number, number, number, number];
      if (type === EntityType.Projectile) {
        color = [0.9, 0.2, 0.2, 1.0];
      } else if (type === EntityType.Mannequin) {
        color = [0.6, 0.6, 0.7, 1.0];
      } else {
        color = [0.5, 0.7, 0.9, 1.0];
      }

      // Check if we have a paint texture for this entity
      const entityId = i + 1; // entityId = slotIdx + 1
      const paintTex = this.paintTextures.get(entityId);
      const hasPaint = paintTex ? 1 : 0;

      // Write instance data: model(16) + color(4) + hasPaint(1) + pad(3) = 24 floats
      const instData = new Float32Array(24);
      instData.set(model, 0);
      instData[16] = color[0];
      instData[17] = color[1];
      instData[18] = color[2];
      instData[19] = color[3];
      instData[20] = hasPaint;
      device.queue.writeBuffer(this.cubeInstanceBuffer, 0, instData);

      // Bind group 1: paint texture or default
      const tex = paintTex ?? this.cubeDefaultTexture!;
      const bindGroup1 = device.createBindGroup({
        layout: this.cubePipeline.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: tex.createView() },
          { binding: 1, resource: this.cubeSampler },
        ],
      });
      pass.setBindGroup(1, bindGroup1);

      pass.drawIndexed(this.cubeIndexCount);
    }
  }

  // ── Compose a 4×4 model matrix from TRS ──
  private composeModelMatrix(
    tx: number, ty: number, tz: number,
    rx: number, ry: number, rz: number, rw: number,
    scale: number,
  ): Float32Array {
    const ql = Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw) || 1;
    const qx = rx / ql, qy = ry / ql, qz = rz / ql, qw = rw / ql;
    const r00 = 1 - 2 * (qy * qy + qz * qz);
    const r01 = 2 * (qx * qy - qz * qw);
    const r02 = 2 * (qx * qz + qy * qw);
    const r10 = 2 * (qx * qy + qz * qw);
    const r11 = 1 - 2 * (qx * qx + qz * qz);
    const r12 = 2 * (qy * qz - qx * qw);
    const r20 = 2 * (qx * qz - qy * qw);
    const r21 = 2 * (qy * qz + qx * qw);
    const r22 = 1 - 2 * (qx * qx + qy * qy);
    return new Float32Array([
      r00 * scale, r10 * scale, r20 * scale, 0,
      r01 * scale, r11 * scale, r21 * scale, 0,
      r02 * scale, r12 * scale, r22 * scale, 0,
      tx, ty, tz, 1,
    ]);
  }

  private getOrCreateDepthTexture(w: number, h: number): GPUTexture {
    if (this.depthTexture && this.depthTextureW === w && this.depthTextureH === h) {
      return this.depthTexture;
    }
    this.depthTexture?.destroy();
    this.depthTexture = this.getDevice()!.createTexture({
      label: "depth",
      size: [w, h],
      format: DEPTH_FORMAT as GPUTextureFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      sampleCount: MSAA_SAMPLE_COUNT,
    });
    this.depthTextureW = w;
    this.depthTextureH = h;
    return this.depthTexture;
  }

  stop(): void {
    this.sandboxRunning = false;
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
  }

  getElapsedTime(): number { return this._elapsedTime; }
}
