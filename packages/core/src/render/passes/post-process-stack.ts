// ============================================================================
// PostProcess Stack — chainable WebGPU postprocessing effects
// Implements: FXAA, Depth of Field, Sobel edge detection, Afterimage, Bloom, ASCII
// Based on Three.js examples:
//   webgpu_postprocessing_fxaa, webgpu_postprocessing_dof,
//   webgl_postprocessing_sobel, webgl_postprocessing_afterimage,
//   webgl_postprocessing (bloom), webgl_effects_ascii
// ============================================================================

export interface ViewportRect { x: number; y: number; w: number; h: number; }

export interface PostProcessStackOptions {
  depthFormat?: GPUTextureFormat;
}

// ── Shader source (loaded from .wgsl files) ─────────────────────────────────
import AFTERIMAGE_FS from "../shaders/post-process/afterimage.wgsl?raw";
import ASCII_FS from "../shaders/post-process/ascii.wgsl?raw";
import BLIT_FS from "../shaders/post-process/blit.wgsl?raw";
import BLOOM_BLUR_FS from "../shaders/post-process/bloom-blur.wgsl?raw";
import BLOOM_BRIGHT_FS from "../shaders/post-process/bloom-bright.wgsl?raw";
import BLOOM_COMPOSITE_FS from "../shaders/post-process/bloom-composite.wgsl?raw";
import DOF_FS from "../shaders/post-process/dof.wgsl?raw";
import VS from "../shaders/post-process/fullscreen-vs.wgsl?raw";
import FXAA_FS from "../shaders/post-process/fxaa.wgsl?raw";
import SOBEL_FS from "../shaders/post-process/sobel.wgsl?raw";

// ── PostProcessStack class ──────────────────────────────────────────────────

type EffectId = "fxaa" | "dof" | "sobel" | "afterimage" | "bloom" | "ascii";
const ALL_EFFECTS: EffectId[] = ["fxaa", "dof", "sobel", "afterimage", "bloom", "ascii"];
const CHAIN_ORDER: EffectId[] = ["dof", "bloom", "fxaa", "sobel", "afterimage", "ascii"];

export class PostProcessStack {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private depthFormat: GPUTextureFormat;

  private pipelines: Record<EffectId, GPURenderPipeline | null> = {
    fxaa: null, dof: null, sobel: null, afterimage: null, bloom: null, ascii: null,
  };
  private bloomBlurPipeline: GPURenderPipeline | null = null;
  private bloomCompositePipeline: GPURenderPipeline | null = null;
  private blitPipeline: GPURenderPipeline | null = null;

  private ccLayout: GPUBindGroupLayout | null = null;
  private cdLayout: GPUBindGroupLayout | null = null;

  private linearSampler: GPUSampler | null = null;
  private nearestSampler: GPUSampler | null = null;

  private uniformBuffers: Record<EffectId, GPUBuffer | null> = {
    fxaa: null, dof: null, sobel: null, afterimage: null, bloom: null, ascii: null,
  };
  private bloomBlurUniform: GPUBuffer | null = null;
  private bloomCompositeUniform: GPUBuffer | null = null;
  private blitUniform: GPUBuffer | null = null;

  private sceneColor: GPUTexture | null = null;
  private sceneDepth: GPUTexture | null = null;
  private texW = 0; private texH = 0;

  private pingPong: [GPUTexture | null, GPUTexture | null] = [null, null];

  private afterimageTex: GPUTexture | null = null;

  private bloomBright: GPUTexture | null = null;
  private bloomBlurH: GPUTexture | null = null;
  private bloomBlurV: GPUTexture | null = null;

  private dummyTex: GPUTexture | null = null;

  private glyphTex: GPUTexture | null = null;

  private enabled: Record<EffectId, boolean> = {
    fxaa: false, dof: false, sobel: false, afterimage: false, bloom: false, ascii: false,
  };
  private dofFocusDist = 0.5;
  private dofFocusRange = 0.3;
  private dofMaxBlur = 8.0;
  private afterimageDamp = 0.96;
  private bloomThreshold = 0.8;
  private bloomStrength = 1.0;
  private asciiCellSize = 8;
  private asciiUseColor = 1.0;

  constructor(device: GPUDevice, format: GPUTextureFormat, options?: PostProcessStackOptions) {
    this.device = device;
    this.format = format;
    this.depthFormat = options?.depthFormat ?? "depth32float";
  }

  init(): void {
    this.linearSampler = this.device.createSampler({
      magFilter: "linear", minFilter: "linear",
      addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
    });
    this.nearestSampler = this.device.createSampler({
      magFilter: "nearest", minFilter: "nearest",
      addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
    });

    this.ccLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });
    this.cdLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "non-filtering" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });

    this.dummyTex = this.device.createTexture({
      size: [1, 1], format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: this.dummyTex },
      new Uint8Array([0, 0, 0, 255]),
      { bytesPerRow: 4, rowsPerImage: 1 },
      [1, 1],
    );

    for (const id of ALL_EFFECTS) {
      this.uniformBuffers[id] = this.device.createBuffer({
        size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    this.bloomBlurUniform = this.device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bloomCompositeUniform = this.device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.blitUniform = this.device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    this.pipelines.fxaa = this.makePipeline(FXAA_FS, this.ccLayout!);
    this.pipelines.dof = this.makePipeline(DOF_FS, this.cdLayout!);
    this.pipelines.sobel = this.makePipeline(SOBEL_FS, this.ccLayout!);
    this.pipelines.afterimage = this.makePipeline(AFTERIMAGE_FS, this.ccLayout!);
    this.pipelines.bloom = this.makePipeline(BLOOM_BRIGHT_FS, this.ccLayout!);
    this.bloomBlurPipeline = this.makePipeline(BLOOM_BLUR_FS, this.ccLayout!);
    this.bloomCompositePipeline = this.makePipeline(BLOOM_COMPOSITE_FS, this.ccLayout!);
    this.pipelines.ascii = this.makePipeline(ASCII_FS, this.ccLayout!);
    this.blitPipeline = this.makePipeline(BLIT_FS, this.ccLayout!);

    this.createGlyphAtlas();
  }

  private makePipeline(fsCode: string, layout: GPUBindGroupLayout): GPURenderPipeline {
    const shader = this.device.createShaderModule({ code: VS + "\n" + fsCode });
    const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [layout] });
    return this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shader, entryPoint: "vs_main" },
      fragment: { module: shader, entryPoint: "fs_main", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list" },
    });
  }

  private createGlyphAtlas(): void {
    const chars = " .:-=+*#%@";
    const glyphW = 16, glyphH = 16;
    const cols = chars.length;
    const canvas = document.createElement("canvas");
    canvas.width = cols * glyphW;
    canvas.height = glyphH;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "white";
    ctx.font = `bold ${glyphH - 2}px monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = 0; i < chars.length; i++) {
      ctx.fillText(chars[i], i * glyphW + glyphW / 2, glyphH / 2);
    }
    this.glyphTex = this.device.createTexture({
      size: [canvas.width, canvas.height],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture(
      { source: canvas },
      { texture: this.glyphTex },
      [canvas.width, canvas.height],
    );
  }

  hasEnabledEffects(): boolean {
    return Object.values(this.enabled).some(v => v);
  }

  getEnabledEffects(): string[] {
    return CHAIN_ORDER.filter(id => this.enabled[id]).map(id => {
      const names: Record<EffectId, string> = {
        dof: "DOF", bloom: "Bloom", fxaa: "FXAA",
        sobel: "Sobel", afterimage: "Afterimage", ascii: "ASCII",
      };
      return names[id];
    });
  }

  setEnabled(id: EffectId, enabled: boolean): void {
    this.enabled[id] = enabled;
  }

  setDOFFocusDist(v: number): void { this.dofFocusDist = v; }
  setDOFFocusRange(v: number): void { this.dofFocusRange = v; }
  setDOFMaxBlur(v: number): void { this.dofMaxBlur = v; }
  setAfterimageDamp(v: number): void { this.afterimageDamp = v; }
  setBloomThreshold(v: number): void { this.bloomThreshold = v; }
  setBloomStrength(v: number): void { this.bloomStrength = v; }
  setASCIICellSize(v: number): void { this.asciiCellSize = Math.max(2, Math.floor(v)); }
  setASCIIUseColor(v: boolean): void { this.asciiUseColor = v ? 1.0 : 0.0; }

  ensureTargets(w: number, h: number): void {
    if (w === this.texW && h === this.texH && this.sceneColor) return;
    this.sceneColor?.destroy();
    this.sceneDepth?.destroy();
    this.pingPong[0]?.destroy();
    this.pingPong[1]?.destroy();
    this.afterimageTex?.destroy();
    this.bloomBright?.destroy();
    this.bloomBlurH?.destroy();
    this.bloomBlurV?.destroy();

    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
      | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;

    this.sceneColor = this.device.createTexture({ size: [w, h], format: this.format, usage });
    this.sceneDepth = this.device.createTexture({ size: [w, h], format: this.depthFormat, usage });

    this.pingPong[0] = this.device.createTexture({ size: [w, h], format: this.format, usage });
    this.pingPong[1] = this.device.createTexture({ size: [w, h], format: this.format, usage });
    this.afterimageTex = this.device.createTexture({ size: [w, h], format: this.format, usage });

    const hw = Math.max(1, Math.floor(w / 2));
    const hh = Math.max(1, Math.floor(h / 2));
    this.bloomBright = this.device.createTexture({ size: [hw, hh], format: this.format, usage });
    this.bloomBlurH = this.device.createTexture({ size: [hw, hh], format: this.format, usage });
    this.bloomBlurV = this.device.createTexture({ size: [hw, hh], format: this.format, usage });

    this.texW = w; this.texH = h;
  }

  getSceneColorView(): GPUTextureView {
    if (!this.sceneColor) throw new Error("PostProcess targets not created");
    return this.sceneColor.createView();
  }

  getSceneDepthView(): GPUTextureView {
    if (!this.sceneDepth) throw new Error("PostProcess targets not created");
    return this.sceneDepth.createView();
  }

  applyChain(
    encoder: GPUCommandEncoder,
    depthView: GPUTextureView | null,
    canvasView: GPUTextureView,
    w: number, h: number,
  ): void {
    const active = CHAIN_ORDER.filter(id => this.enabled[id]);
    if (active.length === 0) return;

    let inputView = this.sceneColor!.createView();
    let pingIdx = 0;

    for (let i = 0; i < active.length; i++) {
      const effect = active[i];
      const isLast = i === active.length - 1;

      if (effect === "afterimage") {
        const outTex = this.pingPong[pingIdx]!;
        const outView = outTex.createView();
        this.applyAfterimage(encoder, inputView, outView, w, h);
        encoder.copyTextureToTexture(
          { texture: outTex }, { texture: this.afterimageTex! }, [w, h],
        );
        if (isLast) {
          this.applyBlit(encoder, outView, canvasView, w, h);
        } else {
          inputView = outView;
          pingIdx = 1 - pingIdx;
        }
      } else if (effect === "bloom") {
        const outView = isLast ? canvasView : this.pingPong[pingIdx]!.createView();
        this.applyBloom(encoder, inputView, outView, w, h);
        if (!isLast) {
          inputView = this.pingPong[pingIdx]!.createView();
          pingIdx = 1 - pingIdx;
        }
      } else {
        const outView = isLast ? canvasView : this.pingPong[pingIdx]!.createView();
        this.applySimple(encoder, effect, inputView, outView, depthView, w, h);
        if (!isLast) {
          inputView = this.pingPong[pingIdx]!.createView();
          pingIdx = 1 - pingIdx;
        }
      }
    }
  }

  private writeUniform(buf: GPUBuffer, data: Float32Array): void {
    this.device.queue.writeBuffer(buf, 0, data as unknown as Float32Array<ArrayBuffer>);
  }

  private applySimple(
    encoder: GPUCommandEncoder,
    effect: EffectId,
    inputView: GPUTextureView,
    outputView: GPUTextureView,
    depthView: GPUTextureView | null,
    w: number, h: number,
  ): void {
    const pipeline = this.pipelines[effect]!;
    const buf = this.uniformBuffers[effect]!;
    const texelX = 1.0 / w, texelY = 1.0 / h;
    const useLinear = effect === "fxaa";

    const data = new Float32Array(8);
    data[0] = texelX; data[1] = texelY;
    if (effect === "dof") {
      data[2] = this.dofFocusDist; data[3] = this.dofFocusRange; data[4] = this.dofMaxBlur;
    } else if (effect === "ascii") {
      data[2] = this.asciiCellSize; data[3] = this.asciiUseColor; data[4] = w; data[5] = h;
    }
    this.writeUniform(buf, data);

    const layout = effect === "dof" ? this.cdLayout! : this.ccLayout!;
    const sampler = useLinear ? this.linearSampler! : this.nearestSampler!;

    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: inputView },
      { binding: 2, resource: sampler },
      { binding: 3, resource: { buffer: buf } },
    ];

    if (effect === "dof" && depthView) {
      entries.push({ binding: 1, resource: depthView });
    } else if (effect === "ascii") {
      entries.push({ binding: 1, resource: this.glyphTex!.createView() });
    } else {
      entries.push({ binding: 1, resource: this.dummyTex!.createView() });
    }

    const bg = this.device.createBindGroup({ layout, entries });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: outputView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear" as GPULoadOp,
        storeOp: "store" as GPUStoreOp,
      }],
    });
    pass.setViewport(0, 0, w, h, 0, 1);
    pass.setScissorRect(0, 0, w, h);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();
  }

  private applyBloom(
    encoder: GPUCommandEncoder,
    inputView: GPUTextureView,
    outputView: GPUTextureView,
    w: number, h: number,
  ): void {
    const hw = Math.max(1, Math.floor(w / 2));
    const hh = Math.max(1, Math.floor(h / 2));

    const brightData = new Float32Array(8);
    brightData[0] = 1.0 / w; brightData[1] = 1.0 / h; brightData[2] = this.bloomThreshold;
    this.writeUniform(this.uniformBuffers.bloom!, brightData);

    const brightBg = this.device.createBindGroup({
      layout: this.ccLayout!,
      entries: [
        { binding: 0, resource: inputView },
        { binding: 1, resource: this.dummyTex!.createView() },
        { binding: 2, resource: this.linearSampler! },
        { binding: 3, resource: { buffer: this.uniformBuffers.bloom! } },
      ],
    });
    const pass1 = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.bloomBright!.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear" as GPULoadOp, storeOp: "store" as GPUStoreOp,
      }],
    });
    pass1.setViewport(0, 0, hw, hh, 0, 1);
    pass1.setPipeline(this.pipelines.bloom!);
    pass1.setBindGroup(0, brightBg);
    pass1.draw(3);
    pass1.end();

    const blurHData = new Float32Array(8);
    blurHData[0] = 1.0 / hw; blurHData[1] = 1.0 / hh; blurHData[2] = 1.0; blurHData[3] = 0.0;
    this.writeUniform(this.bloomBlurUniform!, blurHData);

    const blurHBg = this.device.createBindGroup({
      layout: this.ccLayout!,
      entries: [
        { binding: 0, resource: this.bloomBright!.createView() },
        { binding: 1, resource: this.dummyTex!.createView() },
        { binding: 2, resource: this.linearSampler! },
        { binding: 3, resource: { buffer: this.bloomBlurUniform! } },
      ],
    });
    const pass2 = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.bloomBlurH!.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear" as GPULoadOp, storeOp: "store" as GPUStoreOp,
      }],
    });
    pass2.setViewport(0, 0, hw, hh, 0, 1);
    pass2.setPipeline(this.bloomBlurPipeline!);
    pass2.setBindGroup(0, blurHBg);
    pass2.draw(3);
    pass2.end();

    const blurVData = new Float32Array(8);
    blurVData[0] = 1.0 / hw; blurVData[1] = 1.0 / hh; blurVData[2] = 0.0; blurVData[3] = 1.0;
    this.writeUniform(this.bloomBlurUniform!, blurVData);

    const blurVBg = this.device.createBindGroup({
      layout: this.ccLayout!,
      entries: [
        { binding: 0, resource: this.bloomBlurH!.createView() },
        { binding: 1, resource: this.dummyTex!.createView() },
        { binding: 2, resource: this.linearSampler! },
        { binding: 3, resource: { buffer: this.bloomBlurUniform! } },
      ],
    });
    const pass3 = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.bloomBlurV!.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear" as GPULoadOp, storeOp: "store" as GPUStoreOp,
      }],
    });
    pass3.setViewport(0, 0, hw, hh, 0, 1);
    pass3.setPipeline(this.bloomBlurPipeline!);
    pass3.setBindGroup(0, blurVBg);
    pass3.draw(3);
    pass3.end();

    const compData = new Float32Array(8);
    compData[0] = 1.0 / w; compData[1] = 1.0 / h; compData[2] = this.bloomStrength;
    this.writeUniform(this.bloomCompositeUniform!, compData);

    const compBg = this.device.createBindGroup({
      layout: this.ccLayout!,
      entries: [
        { binding: 0, resource: inputView },
        { binding: 1, resource: this.bloomBlurV!.createView() },
        { binding: 2, resource: this.linearSampler! },
        { binding: 3, resource: { buffer: this.bloomCompositeUniform! } },
      ],
    });
    const pass4 = encoder.beginRenderPass({
      colorAttachments: [{
        view: outputView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear" as GPULoadOp, storeOp: "store" as GPUStoreOp,
      }],
    });
    pass4.setViewport(0, 0, w, h, 0, 1);
    pass4.setPipeline(this.bloomCompositePipeline!);
    pass4.setBindGroup(0, compBg);
    pass4.draw(3);
    pass4.end();
  }

  private applyAfterimage(
    encoder: GPUCommandEncoder,
    inputView: GPUTextureView,
    outputView: GPUTextureView,
    w: number, h: number,
  ): void {
    const data = new Float32Array(8);
    data[0] = 1.0 / w; data[1] = 1.0 / h; data[2] = this.afterimageDamp;
    this.writeUniform(this.uniformBuffers.afterimage!, data);

    const bg = this.device.createBindGroup({
      layout: this.ccLayout!,
      entries: [
        { binding: 0, resource: inputView },
        { binding: 1, resource: this.afterimageTex!.createView() },
        { binding: 2, resource: this.linearSampler! },
        { binding: 3, resource: { buffer: this.uniformBuffers.afterimage! } },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: outputView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear" as GPULoadOp, storeOp: "store" as GPUStoreOp,
      }],
    });
    pass.setViewport(0, 0, w, h, 0, 1);
    pass.setPipeline(this.pipelines.afterimage!);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();
  }

  private applyBlit(
    encoder: GPUCommandEncoder,
    inputView: GPUTextureView,
    outputView: GPUTextureView,
    w: number, h: number,
  ): void {
    const data = new Float32Array(8);
    data[0] = 1.0 / w; data[1] = 1.0 / h;
    this.writeUniform(this.blitUniform!, data);

    const bg = this.device.createBindGroup({
      layout: this.ccLayout!,
      entries: [
        { binding: 0, resource: inputView },
        { binding: 1, resource: this.dummyTex!.createView() },
        { binding: 2, resource: this.linearSampler! },
        { binding: 3, resource: { buffer: this.blitUniform! } },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: outputView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear" as GPULoadOp, storeOp: "store" as GPUStoreOp,
      }],
    });
    pass.setViewport(0, 0, w, h, 0, 1);
    pass.setPipeline(this.blitPipeline!);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();
  }

  destroy(): void {
    this.sceneColor?.destroy();
    this.sceneDepth?.destroy();
    this.pingPong[0]?.destroy();
    this.pingPong[1]?.destroy();
    this.afterimageTex?.destroy();
    this.bloomBright?.destroy();
    this.bloomBlurH?.destroy();
    this.bloomBlurV?.destroy();
    this.dummyTex?.destroy();
    this.glyphTex?.destroy();
    for (const id of ALL_EFFECTS) {
      this.uniformBuffers[id]?.destroy();
    }
    this.bloomBlurUniform?.destroy();
    this.bloomCompositeUniform?.destroy();
    this.blitUniform?.destroy();
  }
}
