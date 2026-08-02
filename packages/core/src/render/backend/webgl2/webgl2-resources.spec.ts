import { describe, it, expect, vi, beforeEach } from "bun:test";
import {
  WebGL2Buffer,
  WebGL2Texture,
  WebGL2TextureView,
  WebGL2Sampler,
  WebGL2ShaderModule,
  WebGL2BindGroupLayout,
  WebGL2PipelineLayout,
  WebGL2BindGroup,
  WebGL2RenderPipeline,
} from "./webgl2-resources.ts";
import type { BindGroupLayoutEntry, BindGroupEntry, VertexBufferLayout, ColorTargetState, BlendState } from "../types.ts";

// ─── Mock GL ───────────────────────────────────────────────────────────────

function createMockGL() {
  const constants: Record<string, number> = {
    TEXTURE_2D: 0x0DE1, TEXTURE_3D: 0x806F, TEXTURE_2D_ARRAY: 0x8C1A,
    ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, UNIFORM_BUFFER: 0x8A11,
    VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30,
    RGBA: 0x1908, RGBA8: 0x8058, FLOAT: 0x1406, UNSIGNED_BYTE: 0x1401,
    TEXTURE_WRAP_S: 0x2802, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
    CLAMP_TO_EDGE: 0x812F, REPEAT: 0x2901, LINEAR: 0x2601, NEAREST: 0x2600,
    DEPTH_ATTACHMENT: 0x8D00, FRAMEBUFFER: 0x8D40,
  };
  let id = 1;
  const gl: Record<string, unknown> = {
    ...constants,
    createBuffer: vi.fn(() => ({ id: id++ })),
    deleteBuffer: vi.fn(),
    createTexture: vi.fn(() => ({ id: id++ })),
    deleteTexture: vi.fn(),
    createSampler: vi.fn(() => ({ id: id++ })),
    deleteSampler: vi.fn(),
    createShader: vi.fn(() => ({ id: id++ })),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({ id: id++ })),
    deleteProgram: vi.fn(),
    bindBuffer: vi.fn(), bindTexture: vi.fn(), texImage2D: vi.fn(), texImage3D: vi.fn(),
    texParameteri: vi.fn(), generateMipmap: vi.fn(),
    samplerParameteri: vi.fn(), samplerParameterf: vi.fn(),
    getExtension: vi.fn(() => null),
    useProgram: vi.fn(), linkProgram: vi.fn(), attachShader: vi.fn(),
    getProgramParameter: vi.fn(() => true), getProgramInfoLog: vi.fn(() => ""),
    enable: vi.fn(), disable: vi.fn(), cullFace: vi.fn(), frontFace: vi.fn(),
    depthFunc: vi.fn(), depthMask: vi.fn(), colorMask: vi.fn(),
    blendEquationSeparate: vi.fn(), blendFuncSeparate: vi.fn(),
    stencilMaskSeparate: vi.fn(), stencilFuncSeparate: vi.fn(), stencilOpSeparate: vi.fn(),
    NONE: 0, FRONT: 0x0404, BACK: 0x0405, CCW: 0x0901, CW: 0x0900,
    FUNC_ADD: 0x8006, ZERO: 0, ONE: 1,
  };
  return gl as unknown as WebGL2RenderingContext;
}

// ─── WebGL2Buffer ──────────────────────────────────────────────────────────

describe("WebGL2Buffer", () => {
  let gl: WebGL2RenderingContext;

  beforeEach(() => { gl = createMockGL(); });

  it("constructs with correct properties", () => {
    const buf = new WebGL2Buffer(gl, 256, 64, "test-buf");
    expect(buf.size).toBe(256);
    expect(buf.usage).toBe(64);
    expect(buf.label).toBe("test-buf");
    expect(buf.destroyed).toBe(false);
  });

  it("targets UNIFORM_BUFFER for uniform usage", () => {
    const buf = new WebGL2Buffer(gl, 256, 64);
    expect(buf.target).toBe(gl.UNIFORM_BUFFER);
  });

  it("targets ELEMENT_ARRAY_BUFFER for index usage", () => {
    const buf = new WebGL2Buffer(gl, 256, 16);
    expect(buf.target).toBe(gl.ELEMENT_ARRAY_BUFFER);
  });

  it("targets ARRAY_BUFFER for vertex usage", () => {
    const buf = new WebGL2Buffer(gl, 256, 32);
    expect(buf.target).toBe(gl.ARRAY_BUFFER);
  });

  it("targets ARRAY_BUFFER by default", () => {
    const buf = new WebGL2Buffer(gl, 256, 0);
    expect(buf.target).toBe(gl.ARRAY_BUFFER);
  });

  it("targets SHADER_STORAGE_BUFFER (0x90C4) for storage usage", () => {
    const buf = new WebGL2Buffer(gl, 256, 128);
    expect(buf.target).toBe(0x90C4);
  });

  it("destroy() marks as destroyed but does not delete GL buffer", () => {
    const buf = new WebGL2Buffer(gl, 256, 64);
    buf.destroy();
    expect(buf.destroyed).toBe(true);
    expect(gl.deleteBuffer).not.toHaveBeenCalled();
  });

  it("destroyWithGL() deletes the GL buffer", () => {
    const buf = new WebGL2Buffer(gl, 256, 64);
    buf.destroyWithGL(gl);
    expect(buf.destroyed).toBe(true);
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(1);
    expect(buf.glBuffer).toBeNull();
  });

  it("getNative() returns the GL buffer object", () => {
    const buf = new WebGL2Buffer(gl, 256, 64);
    expect(buf.getNative()).toBeDefined();
  });
});

// ─── WebGL2Texture ─────────────────────────────────────────────────────────

describe("WebGL2Texture", () => {
  let gl: WebGL2RenderingContext;

  beforeEach(() => { gl = createMockGL(); });

  it("constructs with correct properties", () => {
    const tex = new WebGL2Texture(gl, {} as WebGLTexture, 64, 64, 1, "rgba8unorm", 16, 1, 1, "test-tex", false, "2d");
    expect(tex.width).toBe(64);
    expect(tex.height).toBe(64);
    expect(tex.depthOrArrayLayers).toBe(1);
    expect(tex.format).toBe("rgba8unorm");
    expect(tex.usage).toBe(16);
    expect(tex.sampleCount).toBe(1);
    expect(tex.mipLevelCount).toBe(1);
    expect(tex.label).toBe("test-tex");
    expect(tex.isDepth).toBe(false);
    expect(tex.dimension).toBe("2d");
  });

  it("textureTarget returns TEXTURE_2D for 2D single-layer", () => {
    const tex = new WebGL2Texture(gl, {} as WebGLTexture, 64, 64, 1, "rgba8unorm", 16, 1, 1, undefined, false, "2d");
    expect(tex.textureTarget).toBe(gl.TEXTURE_2D);
  });

  it("textureTarget returns TEXTURE_2D_ARRAY for multi-layer", () => {
    const tex = new WebGL2Texture(gl, {} as WebGLTexture, 64, 64, 4, "rgba8unorm", 16, 1, 1, undefined, false, "2d");
    expect(tex.textureTarget).toBe(gl.TEXTURE_2D_ARRAY);
  });

  it("textureTarget returns TEXTURE_3D for 3D dimension", () => {
    const tex = new WebGL2Texture(gl, {} as WebGLTexture, 64, 64, 4, "rgba8unorm", 16, 1, 1, undefined, false, "3d");
    expect(tex.textureTarget).toBe(gl.TEXTURE_3D);
  });

  it("createView() returns a WebGL2TextureView", () => {
    const tex = new WebGL2Texture(gl, {} as WebGLTexture, 64, 64, 1, "rgba8unorm", 16, 1, 1, undefined, false, "2d");
    const view = tex.createView({ label: "view1" });
    expect(view).toBeInstanceOf(WebGL2TextureView);
    expect(view.label).toBe("view1");
  });

  it("destroy() deletes the GL texture", () => {
    const tex = new WebGL2Texture(gl, {} as WebGLTexture, 64, 64, 1, "rgba8unorm", 16, 1, 1, undefined, false, "2d");
    tex.destroy();
    expect(gl.deleteTexture).toHaveBeenCalledTimes(1);
    expect(tex.glTexture).toBeNull();
    expect(tex.destroyed).toBe(true);
  });

  it("getNative() returns the GL texture object", () => {
    const tex = new WebGL2Texture(gl, {} as WebGLTexture, 64, 64, 1, "rgba8unorm", 16, 1, 1, undefined, false, "2d");
    expect(tex.getNative()).toBeDefined();
  });
});

// ─── WebGL2TextureView ─────────────────────────────────────────────────────

describe("WebGL2TextureView", () => {
  let gl: WebGL2RenderingContext;

  beforeEach(() => { gl = createMockGL(); });

  it("constructs with texture reference and label", () => {
    const tex = new WebGL2Texture(gl, {} as WebGLTexture, 64, 64, 1, "rgba8unorm", 16, 1, 1, "tex", false, "2d");
    const view = new WebGL2TextureView(tex, "my-view", { format: "rgba8unorm" });
    expect(view.label).toBe("my-view");
    expect(view.texture).toBe(tex);
    expect(view.descriptor?.format).toBe("rgba8unorm");
  });

  it("getNative() returns the underlying texture's GL object", () => {
    const tex = new WebGL2Texture(gl, {} as WebGLTexture, 64, 64, 1, "rgba8unorm", 16, 1, 1, undefined, false, "2d");
    const view = new WebGL2TextureView(tex, undefined);
    expect(view.getNative()).toBe(tex.glTexture);
  });
});

// ─── WebGL2Sampler ─────────────────────────────────────────────────────────

describe("WebGL2Sampler", () => {
  let gl: WebGL2RenderingContext;

  beforeEach(() => { gl = createMockGL(); });

  it("constructs with label", () => {
    const sampler = new WebGL2Sampler(gl, {} as WebGLSampler, "my-sampler");
    expect(sampler.label).toBe("my-sampler");
    expect(sampler.glSampler).toBeDefined();
  });

  it("destroy() deletes the GL sampler", () => {
    const sampler = new WebGL2Sampler(gl, {} as WebGLSampler, undefined);
    sampler.destroy(gl);
    expect(gl.deleteSampler).toHaveBeenCalledTimes(1);
    expect(sampler.glSampler).toBeNull();
  });

  it("getNative() returns the GL sampler", () => {
    const sampler = new WebGL2Sampler(gl, {} as WebGLSampler, undefined);
    expect(sampler.getNative()).toBeDefined();
  });
});

// ─── WebGL2ShaderModule ────────────────────────────────────────────────────

describe("WebGL2ShaderModule", () => {
  let gl: WebGL2RenderingContext;

  beforeEach(() => { gl = createMockGL(); });

  it("constructs with label and stage", () => {
    const mod = new WebGL2ShaderModule({} as WebGLShader, "my-shader", "vertex");
    expect(mod.label).toBe("my-shader");
    expect(mod.stage).toBe("vertex");
  });

  it("destroy() deletes the GL shader", () => {
    const mod = new WebGL2ShaderModule({} as WebGLShader, undefined, "fragment");
    mod.destroy(gl);
    expect(gl.deleteShader).toHaveBeenCalledTimes(1);
    expect(mod.glShader).toBeNull();
  });

  it("getNative() returns the GL shader", () => {
    const mod = new WebGL2ShaderModule({} as WebGLShader, undefined, "vertex");
    expect(mod.getNative()).toBeDefined();
  });
});

// ─── WebGL2BindGroupLayout ─────────────────────────────────────────────────

describe("WebGL2BindGroupLayout", () => {
  it("constructs with entries and label", () => {
    const entries: BindGroupLayoutEntry[] = [
      { binding: 0, visibility: 1, buffer: { type: "uniform" } },
    ];
    const layout = new WebGL2BindGroupLayout({ entries }, "bgl");
    expect(layout.label).toBe("bgl");
    expect(layout.info.entries).toBe(entries);
  });

  it("getNative() returns self", () => {
    const layout = new WebGL2BindGroupLayout({ entries: [] }, undefined);
    expect(layout.getNative()).toBe(layout);
  });
});

// ─── WebGL2PipelineLayout ──────────────────────────────────────────────────

describe("WebGL2PipelineLayout", () => {
  it("constructs with bind group layouts and label", () => {
    const bgl1 = new WebGL2BindGroupLayout({ entries: [] }, "bgl1");
    const bgl2 = new WebGL2BindGroupLayout({ entries: [] }, "bgl2");
    const pl = new WebGL2PipelineLayout([bgl1, bgl2], "pl");
    expect(pl.label).toBe("pl");
    expect(pl.bindGroupLayouts).toHaveLength(2);
    expect(pl.bindGroupLayouts[0]).toBe(bgl1);
    expect(pl.bindGroupLayouts[1]).toBe(bgl2);
  });

  it("getNative() returns self", () => {
    const pl = new WebGL2PipelineLayout([], undefined);
    expect(pl.getNative()).toBe(pl);
  });
});

// ─── WebGL2BindGroup ───────────────────────────────────────────────────────

describe("WebGL2BindGroup", () => {
  it("constructs with entries, layout, and label", () => {
    const bgl = new WebGL2BindGroupLayout({ entries: [] }, "bgl");
    const entries: BindGroupEntry[] = [];
    const bg = new WebGL2BindGroup({ entries, layout: bgl }, "bg");
    expect(bg.label).toBe("bg");
    expect(bg.info.entries).toBe(entries);
    expect(bg.info.layout).toBe(bgl);
  });

  it("getNative() returns self", () => {
    const bgl = new WebGL2BindGroupLayout({ entries: [] }, undefined);
    const bg = new WebGL2BindGroup({ entries: [], layout: bgl }, undefined);
    expect(bg.getNative()).toBe(bg);
  });
});

// ─── WebGL2RenderPipeline ──────────────────────────────────────────────────

describe("WebGL2RenderPipeline", () => {
  let gl: WebGL2RenderingContext;

  beforeEach(() => { gl = createMockGL(); });

  it("constructs with program, info, and label", () => {
    const info = {
      program: {} as WebGLProgram,
      vertexBuffers: [] as VertexBufferLayout[],
      topology: gl.TRIANGLES,
      cullMode: gl.NONE,
      frontFace: gl.CCW,
      depthTest: false,
      depthWrite: false,
      depthFunc: gl.ALWAYS,
      stencilTest: false,
      stencilFront: { failOp: gl.KEEP, depthFailOp: gl.KEEP, passOp: gl.KEEP, compare: gl.ALWAYS },
      stencilBack: { failOp: gl.KEEP, depthFailOp: gl.KEEP, passOp: gl.KEEP, compare: gl.ALWAYS },
      stencilReadMask: 0xFFFFFFFF,
      stencilWriteMask: 0xFFFFFFFF,
      colorAttachments: [] as ColorTargetState[],
      blendEnabled: false,
      blendState: null as BlendState | null,
      colorWriteMask: 15,
    };
    const pipeline = new WebGL2RenderPipeline(gl, {} as WebGLProgram, info, "pipeline");
    expect(pipeline.label).toBe("pipeline");
    expect(pipeline.info).toBe(info);
  });

  it("destroy() deletes the GL program", () => {
    const info = {
      program: {} as WebGLProgram,
      vertexBuffers: [], topology: 0, cullMode: 0, frontFace: 0,
      depthTest: false, depthWrite: false, depthFunc: 0,
      stencilTest: false,
      stencilFront: { failOp: 0, depthFailOp: 0, passOp: 0, compare: 0 },
      stencilBack: { failOp: 0, depthFailOp: 0, passOp: 0, compare: 0 },
      stencilReadMask: 0, stencilWriteMask: 0,
      colorAttachments: [], blendEnabled: false, blendState: null, colorWriteMask: 15,
    };
    const pipeline = new WebGL2RenderPipeline(gl, {} as WebGLProgram, info, undefined);
    pipeline.destroy(gl);
    expect(gl.deleteProgram).toHaveBeenCalledTimes(1);
    expect(pipeline.glProgram).toBeNull();
  });

  it("getNative() returns the GL program", () => {
    const info = {
      program: {} as WebGLProgram,
      vertexBuffers: [], topology: 0, cullMode: 0, frontFace: 0,
      depthTest: false, depthWrite: false, depthFunc: 0,
      stencilTest: false,
      stencilFront: { failOp: 0, depthFailOp: 0, passOp: 0, compare: 0 },
      stencilBack: { failOp: 0, depthFailOp: 0, passOp: 0, compare: 0 },
      stencilReadMask: 0, stencilWriteMask: 0,
      colorAttachments: [], blendEnabled: false, blendState: null, colorWriteMask: 15,
    };
    const pipeline = new WebGL2RenderPipeline(gl, {} as WebGLProgram, info, undefined);
    expect(pipeline.getNative()).toBeDefined();
  });
});
