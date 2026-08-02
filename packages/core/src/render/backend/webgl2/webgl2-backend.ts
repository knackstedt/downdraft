// ============================================================================
// WebGL2Backend — full WebGL2 implementation of the RenderBackend interface.
// Provides a fallback for environments without WebGPU support.
// ============================================================================

import { createLogger } from "../../../util/logger.ts";
import type { BackendCapabilities } from "../capabilities.ts";
import { createWebGL2Capabilities } from "../capabilities.ts";
import { getFormatInfo, getWebGL2FormatMapping, isDepthFormat } from "../format-mapping.ts";
import type { RenderBackend, SurfaceConfiguration } from "../render-backend.ts";
import { getShaderSource, transpileShader } from "../shader-registry.ts";
import type { ShaderLanguage, ShaderSource } from "../shader-source.ts";
import type {
    BackendBindGroup,
    BackendBindGroupLayout,
    BackendBuffer,
    BackendCommandEncoder,
    BackendPipelineLayout,
    BackendQueue,
    BackendRenderPipeline,
    BackendSampler,
    BackendShaderModule,
    BackendTexture,
    BackendTextureView,
    BindGroupDescriptor,
    BindGroupLayoutDescriptor,
    BlendState,
    BufferDescriptor,
    CompareFunction,
    CullMode,
    FrontFace,
    PipelineLayoutDescriptor,
    PrimitiveTopology,
    RenderPipelineDescriptor,
    SamplerDescriptor,
    StencilOperation,
    TextureDescriptor,
    TextureFormat,
    TextureViewDescriptor
} from "../types.ts";
import { WebGL2CommandEncoder } from "./webgl2-encoders.ts";
import { WebGL2Queue } from "./webgl2-queue.ts";
import {
    WebGL2BindGroup,
    WebGL2BindGroupLayout,
    WebGL2Buffer,
    WebGL2PipelineLayout,
    WebGL2RenderPipeline,
    WebGL2Sampler,
    WebGL2ShaderModule,
    WebGL2Texture,
    type WebGL2PipelineInfo
} from "./webgl2-resources.ts";

const log = createLogger();

export interface WebGL2BackendInitOptions {
  /** Canvas to use for the context. If not provided, uses the one passed to configureSurface. */
  canvas?: HTMLCanvasElement | OffscreenCanvas;
  /** Additional context attributes passed to getContext. */
  contextAttributes?: WebGLContextAttributes;
}

export class WebGL2Backend implements RenderBackend {
  readonly type = "webgl2" as const;

  private gl: WebGL2RenderingContext | null = null;
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private _capabilities: BackendCapabilities | null = null;
  private _queue: WebGL2Queue | null = null;
  private _surfaceFormat: TextureFormat = "rgba8unorm";
  private _surfaceConfig: SurfaceConfiguration | null = null;
  private _surfaceTexture: WebGL2Texture | null = null;
  private _contextLostHandlers: Array<(info: { reason: string; message: string }) => void> = [];
  private _trackedResources: { buffers: WebGL2Buffer[]; textures: WebGL2Texture[]; samplers: WebGL2Sampler[]; shaders: WebGL2ShaderModule[]; pipelines: WebGL2RenderPipeline[] } = {
    buffers: [], textures: [], samplers: [], shaders: [], pipelines: [],
  };

  get capabilities(): BackendCapabilities {
    if (!this._capabilities) {
      throw new Error("WebGL2Backend not initialized — call init() first");
    }
    return this._capabilities;
  }

  get queue(): BackendQueue {
    if (!this._queue) {
      throw new Error("WebGL2Backend not initialized — call init() first");
    }
    return this._queue;
  }

  async init(options: WebGL2BackendInitOptions = {}): Promise<boolean> {
    const canvas = options.canvas ?? this.canvas;
    if (!canvas) {
      log.error("DownDraft", "WebGL2Backend.init: no canvas provided");
      return false;
    }

    const attrs: WebGLContextAttributes = {
      antialias: true,
      alpha: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
      ...options.contextAttributes,
    };

    const gl = (canvas as HTMLCanvasElement).getContext("webgl2", attrs) as WebGL2RenderingContext | null;
    if (!gl) {
      log.error("DownDraft", "WebGL2Backend.init: failed to get WebGL2 context");
      return false;
    }

    this.gl = gl;
    this.canvas = canvas;
    this._capabilities = createWebGL2Capabilities(gl);
    this._queue = new WebGL2Queue(gl);

    // Handle context loss
    const canvasEl = canvas as HTMLCanvasElement;
    if (canvasEl.addEventListener) {
      canvasEl.addEventListener("webglcontextlost", (e: Event) => {
        e.preventDefault();
        for (const handler of this._contextLostHandlers) {
          handler({ reason: "context-lost", message: "WebGL2 context was lost" });
        }
      });
    }

    log.info("DownDraft", "WebGL2Backend initialized successfully");
    return true;
  }

  // ─── Surface ─────────────────────────────────────────────────────────────

  configureSurface(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    config: Partial<SurfaceConfiguration> = {},
  ): void {
    if (!this.gl) {
      log.error("DownDraft", "Cannot configure surface — WebGL2 not initialized");
      return;
    }

    this.canvas = canvas;
    const format = (config.format ?? "rgba8unorm") as TextureFormat;
    this._surfaceFormat = format === "bgra8unorm" ? "rgba8unorm" : format;

    const sc: SurfaceConfiguration = {
      format: this._surfaceFormat,
      width: config.width ?? (canvas as HTMLCanvasElement).width ?? 800,
      height: config.height ?? (canvas as HTMLCanvasElement).height ?? 600,
      usage: config.usage ?? 16, // RENDER_ATTACHMENT
      alphaMode: config.alphaMode ?? "opaque",
      viewFormats: config.viewFormats ?? [],
    };
    this._surfaceConfig = sc;
  }

  getCurrentSurfaceTexture(): BackendTexture | null {
    if (!this.gl || !this.canvas || !this._surfaceConfig) {
      return null;
    }
    // In WebGL2, the canvas itself is the surface texture.
    // We return a wrapper that represents the default framebuffer.
    if (!this._surfaceTexture) {
      const gl = this.gl;
      this._surfaceTexture = new WebGL2Texture(
        gl,
        null as unknown as WebGLTexture, // null texture = default framebuffer
        this._surfaceConfig.width,
        this._surfaceConfig.height,
        1,
        this._surfaceFormat,
        16,
        1,
        1,
        "surface",
        false,
        "2d",
      );
    }
    return this._surfaceTexture;
  }

  getSurfaceFormat(): TextureFormat {
    return this._surfaceFormat;
  }

  reconfigureSurface(width: number, height: number): void {
    if (!this._surfaceConfig) return;
    this._surfaceConfig = { ...this._surfaceConfig, width, height };
    this._surfaceTexture = null; // Force re-creation on next getCurrentSurfaceTexture
  }

  // ─── Resource Creation ────────────────────────────────────────────────────

  createBuffer(descriptor: BufferDescriptor): BackendBuffer {
    if (!this.gl) throw new Error("WebGL2Backend not initialized");
    const buf = new WebGL2Buffer(this.gl, descriptor.size, descriptor.usage, descriptor.label);
    this._trackedResources.buffers.push(buf);
    return buf;
  }

  createTexture(descriptor: TextureDescriptor): BackendTexture {
    if (!this.gl) throw new Error("WebGL2Backend not initialized");
    const gl = this.gl;

    // Normalize size
    let width: number, height: number, depth: number;
    if (typeof descriptor.size === "number") {
      width = descriptor.size; height = 1; depth = 1;
    } else if (descriptor.size.length === 2) {
      [width, height] = descriptor.size; depth = 1;
    } else {
      [width, height, depth] = descriptor.size;
    }

    const format = descriptor.format;
    const mapping = getWebGL2FormatMapping(format);
    if (!mapping) {
      throw new Error(`WebGL2Backend: unsupported texture format "${format}"`);
    }

    const isDepth = isDepthFormat(format);
    const dimension = descriptor.dimension ?? "2d";
    const sampleCount = descriptor.sampleCount ?? 1;
    const mipLevelCount = descriptor.mipLevelCount ?? 1;

    const glTex = gl.createTexture();
    if (!glTex) throw new Error("WebGL2Backend: failed to create WebGL texture");

    const target = dimension === "3d" ? gl.TEXTURE_3D
      : depth > 1 ? gl.TEXTURE_2D_ARRAY
      : gl.TEXTURE_2D;

    gl.bindTexture(target, glTex);

    // Allocate storage
    if (getFormatInfo(format).compressed) {
      // Compressed textures need storage allocated via compressedTexImage2D
      // For now, just set parameters
      gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    } else {
      const w = Math.max(1, width);
      const h = Math.max(1, height);
      if (dimension === "3d" || depth > 1) {
        gl.texImage3D(
          target, 0, mapping.internalFormat,
          w, h, depth, 0,
          mapping.format, mapping.type, null,
        );
      } else {
        gl.texImage2D(
          target, 0, mapping.internalFormat,
          w, h, 0,
          mapping.format, mapping.type, null,
        );
      }
    }

    // Generate mipmaps if requested
    if (mipLevelCount > 1) {
      gl.generateMipmap(target);
    }

    const tex = new WebGL2Texture(
      gl, glTex, width, height, depth,
      format, descriptor.usage, sampleCount, mipLevelCount,
      descriptor.label, isDepth, dimension,
    );
    this._trackedResources.textures.push(tex);
    return tex;
  }

  createSampler(descriptor: SamplerDescriptor): BackendSampler {
    if (!this.gl) throw new Error("WebGL2Backend not initialized");
    const gl = this.gl;
    const glSampler = gl.createSampler();
    if (!glSampler) throw new Error("WebGL2Backend: failed to create WebGL sampler");

    const uMode = this.mapAddressMode(descriptor.addressModeU ?? "clamp-to-edge");
    const vMode = this.mapAddressMode(descriptor.addressModeV ?? "clamp-to-edge");
    const wMode = this.mapAddressMode(descriptor.addressModeW ?? "clamp-to-edge");
    const magFilter = descriptor.magFilter === "linear" ? gl.LINEAR : gl.NEAREST;
    const minFilter = descriptor.minFilter === "linear" ? gl.LINEAR : gl.NEAREST;
    const mipmapFilter = descriptor.mipmapFilter === "linear" ? gl.LINEAR_MIPMAP_LINEAR
      : descriptor.mipmapFilter === "nearest" ? gl.NEAREST_MIPMAP_NEAREST
      : gl.NEAREST;

    gl.samplerParameteri(glSampler, gl.TEXTURE_WRAP_S, uMode);
    gl.samplerParameteri(glSampler, gl.TEXTURE_WRAP_T, vMode);
    gl.samplerParameteri(glSampler, gl.TEXTURE_WRAP_R, wMode);
    gl.samplerParameteri(glSampler, gl.TEXTURE_MIN_FILTER, minFilter === gl.LINEAR ? mipmapFilter : gl.NEAREST_MIPMAP_NEAREST);
    gl.samplerParameteri(glSampler, gl.TEXTURE_MAG_FILTER, magFilter);

    if (descriptor.lodMinClamp !== undefined) {
      gl.samplerParameterf(glSampler, gl.TEXTURE_MIN_LOD, descriptor.lodMinClamp);
    }
    if (descriptor.lodMaxClamp !== undefined) {
      gl.samplerParameterf(glSampler, gl.TEXTURE_MAX_LOD, descriptor.lodMaxClamp);
    }

    if (descriptor.compare) {
      gl.samplerParameteri(glSampler, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
      gl.samplerParameteri(glSampler, gl.TEXTURE_COMPARE_FUNC, this.mapCompareFunc(descriptor.compare));
    }

    if (descriptor.maxAnisotropy && descriptor.maxAnisotropy > 1) {
      const ext = gl.getExtension("EXT_texture_filter_anisotropic");
      if (ext) {
        gl.samplerParameterf(glSampler, ext.TEXTURE_MAX_ANISOTROPY_EXT, descriptor.maxAnisotropy);
      }
    }

    const sampler = new WebGL2Sampler(gl, glSampler, descriptor.label);
    this._trackedResources.samplers.push(sampler);
    return sampler;
  }

  createShaderModule(source: ShaderSource, language: ShaderLanguage): BackendShaderModule {
    if (!this.gl) throw new Error("WebGL2Backend not initialized");
    const gl = this.gl;

    let vertexSrc: string | null = null;
    let fragmentSrc: string | null = null;

    if (language === "wgsl") {
      // Transpile WGSL to GLSL
      if (!source.wgsl) throw new Error("WebGL2Backend: WGSL shader source is empty");
      const name = source.label;
      // Check if we have hand-written GLSL in the registry
      const registered = name ? getShaderSource(name) : null;
      if (registered?.glslVertex && registered?.glslFragment) {
        vertexSrc = registered.glslVertex;
        fragmentSrc = registered.glslFragment;
      } else {
        const result = transpileShader(source.wgsl, name);
        vertexSrc = result.vertexShader;
        fragmentSrc = result.fragmentShader;
        if (result.errors.length > 0) {
          log.error("DownDraft", `Shader transpilation errors: ${result.errors.join(", ")}`);
        }
        if (result.warnings.length > 0) {
          log.warn("DownDraft", `Shader transpilation warnings: ${result.warnings.join(", ")}`);
        }
      }
    } else if (language === "glsl" || language === "glsl-vert") {
      vertexSrc = source.glslVertex ?? null;
      if (language === "glsl") fragmentSrc = source.glslFragment ?? null;
    } else if (language === "glsl-frag") {
      fragmentSrc = source.glslFragment ?? null;
    }

    if (!vertexSrc) throw new Error("WebGL2Backend: no vertex shader source available");

    // Compile vertex shader
    const vs = this.compileShader(vertexSrc, "vertex");
    let fs: WebGLShader | null = null;

    if (fragmentSrc) {
      fs = this.compileShader(fragmentSrc, "fragment");
    }

    // Return a combined shader module (vertex + fragment pair)
    // We store both in a wrapper — the pipeline creation links them into a program
    const module = new WebGL2ShaderModule(vs, source.label, "vertex");
    if (fs) {
      // Store fragment shader as a second module on the wrapper
      // We'll use a composite approach: the pipeline creation receives both modules
      // For the interface, we return the vertex module and store fragment separately
      (module as unknown as { _fragmentShader: WebGLShader })._fragmentShader = fs;
    }
    this._trackedResources.shaders.push(module);
    return module;
  }

  createBindGroupLayout(descriptor: BindGroupLayoutDescriptor): BackendBindGroupLayout {
    const layout = new WebGL2BindGroupLayout(
      { entries: descriptor.entries },
      descriptor.label,
    );
    return layout;
  }

  createPipelineLayout(descriptor: PipelineLayoutDescriptor): BackendPipelineLayout {
    const layouts = descriptor.bindGroupLayouts as WebGL2BindGroupLayout[];
    return new WebGL2PipelineLayout(layouts, descriptor.label);
  }

  createBindGroup(descriptor: BindGroupDescriptor): BackendBindGroup {
    const layout = descriptor.layout as WebGL2BindGroupLayout;
    return new WebGL2BindGroup(
      { entries: descriptor.entries, layout },
      descriptor.label,
    );
  }

  createRenderPipeline(descriptor: RenderPipelineDescriptor): BackendRenderPipeline {
    if (!this.gl) throw new Error("WebGL2Backend not initialized");
    const gl = this.gl;

    const vsModule = descriptor.vertex.module as WebGL2ShaderModule;
    const fsModule = descriptor.fragment?.module as WebGL2ShaderModule | undefined;

    const vs = vsModule.glShader;
    const fs = fsModule
      ? (fsModule as unknown as { _fragmentShader?: WebGLShader })._fragmentShader ?? fsModule.glShader
      : null;

    if (!vs) throw new Error("WebGL2Backend: vertex shader not compiled");

    // Link program
    const program = gl.createProgram();
    if (!program) throw new Error("WebGL2Backend: failed to create WebGL program");

    gl.attachShader(program, vs);
    if (fs) {
      gl.attachShader(program, fs);
    }
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`WebGL2Backend: program link failed: ${info}`);
    }

    // Map pipeline state
    const topology = this.mapTopology(descriptor.primitive?.topology ?? "triangle-list");
    const cullMode = this.mapCullMode(descriptor.primitive?.cullMode ?? "none");
    const frontFace = this.mapFrontFace(descriptor.primitive?.frontFace ?? "ccw");

    // Depth/stencil
    const ds = descriptor.depthStencil;
    const depthTest = !!ds;
    const depthWrite = ds?.depthWriteEnabled ?? false;
    const depthFunc = this.mapCompareFunc(ds?.depthCompare ?? "always");
    const stencilTest = !!(ds?.stencilFront || ds?.stencilBack);
    const stencilFront = {
      failOp: this.mapStencilOp(ds?.stencilFront?.failOp ?? "keep"),
      depthFailOp: this.mapStencilOp(ds?.stencilFront?.depthFailOp ?? "keep"),
      passOp: this.mapStencilOp(ds?.stencilFront?.passOp ?? "keep"),
      compare: this.mapCompareFunc(ds?.stencilFront?.compare ?? "always"),
    };
    const stencilBack = {
      failOp: this.mapStencilOp(ds?.stencilBack?.failOp ?? "keep"),
      depthFailOp: this.mapStencilOp(ds?.stencilBack?.depthFailOp ?? "keep"),
      passOp: this.mapStencilOp(ds?.stencilBack?.passOp ?? "keep"),
      compare: this.mapCompareFunc(ds?.stencilBack?.compare ?? "always"),
    };
    const stencilReadMask = ds?.stencilReadMask ?? 0xFFFFFFFF;
    const stencilWriteMask = ds?.stencilWriteMask ?? 0xFFFFFFFF;

    // Blend
    const colorAttachments = descriptor.fragment?.targets ?? [];
    const firstBlend = colorAttachments[0]?.blend;
    const blendEnabled = !!firstBlend;
    const blendState: BlendState | null = firstBlend ?? null;
    const colorWriteMask = colorAttachments[0]?.writeMask ?? 15;

    const info: WebGL2PipelineInfo = {
      program,
      vertexBuffers: descriptor.vertex.buffers ?? [],
      topology,
      cullMode,
      frontFace,
      depthTest,
      depthWrite,
      depthFunc,
      stencilTest,
      stencilFront,
      stencilBack,
      stencilReadMask,
      stencilWriteMask,
      colorAttachments,
      blendEnabled,
      blendState,
      colorWriteMask,
    };

    const pipeline = new WebGL2RenderPipeline(gl, program, info, descriptor.label);
    this._trackedResources.pipelines.push(pipeline);
    return pipeline;
  }

  createCommandEncoder(_label?: string): BackendCommandEncoder {
    if (!this.gl) throw new Error("WebGL2Backend not initialized");
    return new WebGL2CommandEncoder();
  }

  createTextureView(texture: BackendTexture, descriptor?: TextureViewDescriptor): BackendTextureView {
    return texture.createView(descriptor);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  destroy(): void {
    if (!this.gl) {
      this._capabilities = null;
      this._queue = null;
      return;
    }
    const gl = this.gl;

    // Delete tracked resources
    for (const buf of this._trackedResources.buffers) buf.destroyWithGL(gl);
    for (const tex of this._trackedResources.textures) tex.destroy();
    for (const samp of this._trackedResources.samplers) samp.destroy(gl);
    for (const sh of this._trackedResources.shaders) sh.destroy(gl);
    for (const p of this._trackedResources.pipelines) p.destroy(gl);

    this._trackedResources = { buffers: [], textures: [], samplers: [], shaders: [], pipelines: [] };

    this.gl = null;
    this.canvas = null;
    this._capabilities = null;
    this._queue = null;
    this._surfaceTexture = null;
    this._surfaceConfig = null;
  }

  onDeviceLost(handler: (info: { reason: string; message: string }) => void): void {
    this._contextLostHandlers.push(handler);
  }

  getNativeDevice(): unknown {
    return this.gl;
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  private compileShader(source: string, stage: "vertex" | "fragment"): WebGLShader {
    const gl = this.gl!;
    const shader = gl.createShader(stage === "vertex" ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER);
    if (!shader) throw new Error(`WebGL2Backend: failed to create ${stage} shader`);

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`WebGL2Backend: ${stage} shader compile failed: ${info}`);
    }

    return shader;
  }

  private mapAddressMode(mode: "clamp-to-edge" | "repeat" | "mirror-repeat"): number {
    const gl = this.gl!;
    switch (mode) {
      case "clamp-to-edge": return gl.CLAMP_TO_EDGE;
      case "repeat": return gl.REPEAT;
      case "mirror-repeat": return gl.MIRRORED_REPEAT;
      default: return gl.CLAMP_TO_EDGE;
    }
  }

  private mapCompareFunc(func: CompareFunction): number {
    const gl = this.gl!;
    switch (func) {
      case "never": return gl.NEVER;
      case "less": return gl.LESS;
      case "less-equal": return gl.LEQUAL;
      case "greater": return gl.GREATER;
      case "greater-equal": return gl.GEQUAL;
      case "equal": return gl.EQUAL;
      case "not-equal": return gl.NOTEQUAL;
      case "always": return gl.ALWAYS;
      default: return gl.ALWAYS;
    }
  }

  private mapStencilOp(op: StencilOperation): number {
    const gl = this.gl!;
    switch (op) {
      case "keep": return gl.KEEP;
      case "zero": return gl.ZERO;
      case "replace": return gl.REPLACE;
      case "invert": return gl.INVERT;
      case "increment-clamp": return gl.INCR;
      case "decrement-clamp": return gl.DECR;
      case "increment-wrap": return gl.INCR_WRAP;
      case "decrement-wrap": return gl.DECR_WRAP;
      default: return gl.KEEP;
    }
  }

  private mapTopology(topology: PrimitiveTopology): number {
    const gl = this.gl!;
    switch (topology) {
      case "point-list": return gl.POINTS;
      case "line-list": return gl.LINES;
      case "line-strip": return gl.LINE_STRIP;
      case "triangle-list": return gl.TRIANGLES;
      case "triangle-strip": return gl.TRIANGLE_STRIP;
      default: return gl.TRIANGLES;
    }
  }

  private mapCullMode(mode: CullMode): number {
    const gl = this.gl!;
    switch (mode) {
      case "none": return gl.NONE;
      case "front": return gl.FRONT;
      case "back": return gl.BACK;
      default: return gl.NONE;
    }
  }

  private mapFrontFace(face: FrontFace): number {
    const gl = this.gl!;
    switch (face) {
      case "ccw": return gl.CCW;
      case "cw": return gl.CW;
      default: return gl.CCW;
    }
  }
}
