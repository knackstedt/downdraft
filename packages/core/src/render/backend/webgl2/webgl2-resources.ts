// ============================================================================
// WebGL2 Resource Wrappers — thin wrappers around native WebGL2 objects
// that implement the backend-agnostic interfaces.
// ============================================================================

import type {
    BackendBindGroup,
    BackendBindGroupLayout,
    BackendBuffer,
    BackendPipelineLayout,
    BackendRenderPipeline,
    BackendSampler,
    BackendShaderModule,
    BackendTexture,
    BackendTextureView,
    BindGroupEntry,
    BindGroupLayoutEntry,
    BlendState,
    BufferUsageFlags,
    ColorTargetState,
    TextureFormat,
    TextureUsageFlags,
    TextureViewDescriptor,
    VertexBufferLayout
} from "../types.ts";

// ─── Buffer ────────────────────────────────────────────────────────────────

export class WebGL2Buffer implements BackendBuffer {
  private _glBuffer: WebGLBuffer | null;
  private _target: number; // GL_ARRAY_BUFFER, GL_ELEMENT_ARRAY_BUFFER, GL_UNIFORM_BUFFER, etc.
  private _destroyed = false;

  constructor(
    gl: WebGL2RenderingContext,
    public readonly size: number,
    public readonly usage: BufferUsageFlags,
    public readonly label: string | undefined,
  ) {
    this._glBuffer = gl.createBuffer();
    // Determine target from usage flags
    if (usage & 16) this._target = gl.ELEMENT_ARRAY_BUFFER; // INDEX
    else if (usage & 64) this._target = gl.UNIFORM_BUFFER; // UNIFORM
    else if (usage & 128) this._target = 0x90C4; // GL_SHADER_STORAGE_BUFFER
    else this._target = gl.ARRAY_BUFFER; // VERTEX or default
  }

  get glBuffer(): WebGLBuffer | null {
    return this._glBuffer;
  }

  get target(): number {
    return this._target;
  }

  get destroyed(): boolean {
    return this._destroyed;
  }

  destroy(): void {
    if (this._glBuffer) {
      // Need GL context — caller is responsible for deleting via backend
      // We just mark as destroyed; actual deletion happens in backend.destroy()
      this._destroyed = true;
    }
  }

  destroyWithGL(gl: WebGL2RenderingContext): void {
    if (this._glBuffer) {
      gl.deleteBuffer(this._glBuffer);
      this._glBuffer = null;
    }
    this._destroyed = true;
  }

  getNative(): unknown {
    return this._glBuffer;
  }
}

// ─── Texture ───────────────────────────────────────────────────────────────

export class WebGL2Texture implements BackendTexture {
  private _glTexture: WebGLTexture | null;
  private _destroyed = false;
  private _gl: WebGL2RenderingContext;

  constructor(
    gl: WebGL2RenderingContext,
    private _texture: WebGLTexture,
    public readonly width: number,
    public readonly height: number,
    public readonly depthOrArrayLayers: number,
    public readonly format: TextureFormat,
    public readonly usage: TextureUsageFlags,
    public readonly sampleCount: number,
    public readonly mipLevelCount: number,
    public readonly label: string | undefined,
    public readonly isDepth: boolean,
    public readonly dimension: "1d" | "2d" | "3d",
  ) {
    this._glTexture = _texture;
    this._gl = gl;
  }

  get glTexture(): WebGLTexture | null {
    return this._glTexture;
  }

  get textureTarget(): number {
    if (this.dimension === "3d") return this._gl.TEXTURE_3D;
    if (this.depthOrArrayLayers > 1) return this._gl.TEXTURE_2D_ARRAY;
    return this._gl.TEXTURE_2D;
  }

  createView(descriptor?: TextureViewDescriptor): BackendTextureView {
    return new WebGL2TextureView(this, descriptor?.label, descriptor);
  }

  destroy(): void {
    if (this._glTexture) {
      this._gl.deleteTexture(this._glTexture);
      this._glTexture = null;
    }
    this._destroyed = true;
  }

  getNative(): unknown {
    return this._glTexture;
  }

  get destroyed(): boolean {
    return this._destroyed;
  }
}

// ─── Texture View ──────────────────────────────────────────────────────────

export class WebGL2TextureView implements BackendTextureView {
  constructor(
    private _texture: WebGL2Texture,
    public readonly label: string | undefined,
    private _descriptor?: TextureViewDescriptor,
  ) {}

  get texture(): WebGL2Texture {
    return this._texture;
  }

  get descriptor(): TextureViewDescriptor | undefined {
    return this._descriptor;
  }

  getNative(): unknown {
    return this._texture.glTexture;
  }
}

// ─── Sampler ───────────────────────────────────────────────────────────────

export class WebGL2Sampler implements BackendSampler {
  private _glSampler: WebGLSampler | null;

  constructor(
    gl: WebGL2RenderingContext,
    private _sampler: WebGLSampler,
    public readonly label: string | undefined,
  ) {
    this._glSampler = _sampler;
  }

  get glSampler(): WebGLSampler | null {
    return this._glSampler;
  }

  destroy(gl: WebGL2RenderingContext): void {
    if (this._glSampler) {
      gl.deleteSampler(this._glSampler);
      this._glSampler = null;
    }
  }

  getNative(): unknown {
    return this._glSampler;
  }
}

// ─── Shader Module ─────────────────────────────────────────────────────────

export class WebGL2ShaderModule implements BackendShaderModule {
  private _glShader: WebGLShader | null;
  private _destroyed = false;

  constructor(
    private _shader: WebGLShader,
    public readonly label: string | undefined,
    public readonly stage: "vertex" | "fragment",
  ) {
    this._glShader = _shader;
  }

  get glShader(): WebGLShader | null {
    return this._glShader;
  }

  destroy(gl: WebGL2RenderingContext): void {
    if (this._glShader) {
      gl.deleteShader(this._glShader);
      this._glShader = null;
    }
    this._destroyed = true;
  }

  getNative(): unknown {
    return this._glShader;
  }
}

// ─── Bind Group Layout ─────────────────────────────────────────────────────

export interface WebGL2BindGroupLayoutInfo {
  entries: BindGroupLayoutEntry[];
}

export class WebGL2BindGroupLayout implements BackendBindGroupLayout {
  constructor(
    public readonly info: WebGL2BindGroupLayoutInfo,
    public readonly label: string | undefined,
  ) {}

  getNative(): unknown {
    return this;
  }
}

// ─── Pipeline Layout ───────────────────────────────────────────────────────

export class WebGL2PipelineLayout implements BackendPipelineLayout {
  constructor(
    public readonly bindGroupLayouts: WebGL2BindGroupLayout[],
    public readonly label: string | undefined,
  ) {}

  getNative(): unknown {
    return this;
  }
}

// ─── Bind Group ────────────────────────────────────────────────────────────

export interface WebGL2BindGroupInfo {
  entries: BindGroupEntry[];
  layout: WebGL2BindGroupLayout;
}

export class WebGL2BindGroup implements BackendBindGroup {
  constructor(
    public readonly info: WebGL2BindGroupInfo,
    public readonly label: string | undefined,
  ) {}

  getNative(): unknown {
    return this;
  }
}

// ─── Render Pipeline ───────────────────────────────────────────────────────

export interface WebGL2PipelineInfo {
  program: WebGLProgram;
  vertexBuffers: VertexBufferLayout[];
  topology: number;
  cullMode: number;
  frontFace: number;
  depthTest: boolean;
  depthWrite: boolean;
  depthFunc: number;
  stencilTest: boolean;
  stencilFront: { failOp: number; depthFailOp: number; passOp: number; compare: number };
  stencilBack: { failOp: number; depthFailOp: number; passOp: number; compare: number };
  stencilReadMask: number;
  stencilWriteMask: number;
  colorAttachments: ColorTargetState[];
  blendEnabled: boolean;
  blendState: BlendState | null;
  colorWriteMask: number;
}

export class WebGL2RenderPipeline implements BackendRenderPipeline {
  private _glProgram: WebGLProgram | null;

  constructor(
    gl: WebGL2RenderingContext,
    private _program: WebGLProgram,
    public readonly info: WebGL2PipelineInfo,
    public readonly label: string | undefined,
  ) {
    this._glProgram = _program;
  }

  get glProgram(): WebGLProgram | null {
    return this._glProgram;
  }

  destroy(gl: WebGL2RenderingContext): void {
    if (this._glProgram) {
      gl.deleteProgram(this._glProgram);
      this._glProgram = null;
    }
  }

  getNative(): unknown {
    return this._glProgram;
  }
}
