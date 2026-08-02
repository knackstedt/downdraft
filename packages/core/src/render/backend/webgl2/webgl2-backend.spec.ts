import { describe, it, expect, vi, beforeEach } from "bun:test";
import { WebGL2Backend } from "./webgl2-backend.ts";
import { WebGL2Buffer } from "./webgl2-resources.ts";
import { WebGL2CommandEncoder, WebGL2CommandBuffer } from "./webgl2-encoders.ts";
import type { BackendBindGroupLayout, BackendPipelineLayout, BackendBindGroup } from "../types.ts";

// ─── Mock WebGL2 Context ───────────────────────────────────────────────────

function createMockGL(): WebGL2RenderingContext {
  const constants: Record<string, number> = {
    TEXTURE_2D: 0x0DE1,
    TEXTURE_3D: 0x806F,
    TEXTURE_2D_ARRAY: 0x8C1A,
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    UNIFORM_BUFFER: 0x8A11,
    COPY_READ_BUFFER: 0x8F36,
    COPY_WRITE_BUFFER: 0x8F37,
    PIXEL_UNPACK_BUFFER: 0x88EC,
    PIXEL_PACK_BUFFER: 0x88EB,
    VERTEX_SHADER: 0x8B31,
    FRAGMENT_SHADER: 0x8B30,
    COMPILE_STATUS: 0x8B81,
    LINK_STATUS: 0x8B82,
    TEXTURE0: 0x84C0,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    TEXTURE_WRAP_R: 0x8072,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_MIN_LOD: 0x813A,
    TEXTURE_MAX_LOD: 0x813B,
    TEXTURE_COMPARE_MODE: 0x884C,
    TEXTURE_COMPARE_FUNC: 0x884D,
    COMPARE_REF_TO_TEXTURE: 0x884E,
    CLAMP_TO_EDGE: 0x812F,
    REPEAT: 0x2901,
    MIRRORED_REPEAT: 0x8370,
    NEAREST: 0x2600,
    LINEAR: 0x2601,
    NEAREST_MIPMAP_NEAREST: 0x2700,
    LINEAR_MIPMAP_LINEAR: 0x2703,
    FLOAT: 0x1406,
    UNSIGNED_BYTE: 0x1401,
    UNSIGNED_SHORT: 0x1403,
    UNSIGNED_INT: 0x1405,
    INT: 0x1404,
    SHORT: 0x1402,
    BYTE: 0x1400,
    HALF_FLOAT: 0x140B,
    RGBA: 0x1908,
    RGB: 0x1907,
    RG: 0x8227,
    RED: 0x1903,
    RGBA8: 0x8058,
    R8: 0x8229,
    RG8: 0x822B,
    DEPTH_COMPONENT: 0x1902,
    DEPTH_ATTACHMENT: 0x8D00,
    DEPTH_STENCIL_ATTACHMENT: 0x821A,
    COLOR_ATTACHMENT0: 0x8CE0,
    COLOR_ATTACHMENT1: 0x8CE1,
    COLOR_ATTACHMENT2: 0x8CE2,
    COLOR_ATTACHMENT3: 0x8CE3,
    FRAMEBUFFER: 0x8D40,
    READ_FRAMEBUFFER: 0x8CA8,
    DRAW_FRAMEBUFFER: 0x8CA9,
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_BUFFER_BIT: 0x100,
    NEAREST_MIPMAP_LINEAR: 0x2702,
    TEXTURE_MAX_ANISOTROPY_EXT: 0x84FE,
    FUNC_ADD: 0x8006,
    FUNC_SUBTRACT: 0x800A,
    FUNC_REVERSE_SUBTRACT: 0x800B,
    MIN: 0x8007,
    MAX: 0x8008,
    ZERO: 0,
    ONE: 1,
    SRC_COLOR: 0x0300,
    ONE_MINUS_SRC_COLOR: 0x0301,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    DST_COLOR: 0x0306,
    ONE_MINUS_DST_COLOR: 0x0307,
    DST_ALPHA: 0x0304,
    ONE_MINUS_DST_ALPHA: 0x0305,
    SRC_ALPHA_SATURATE: 0x0308,
    CONSTANT_COLOR: 0x8001,
    ONE_MINUS_CONSTANT_COLOR: 0x8002,
    BLEND: 0x0BE2,
    CULL_FACE: 0x0B44,
    DEPTH_TEST: 0x0B71,
    STENCIL_TEST: 0x0B90,
    FRONT: 0x0404,
    BACK: 0x0405,
    FRONT_AND_BACK: 0x0408,
    CCW: 0x0901,
    CW: 0x0900,
    NEVER: 0x0200,
    LESS: 0x0201,
    LEQUAL: 0x0203,
    GREATER: 0x0204,
    GEQUAL: 0x0206,
    EQUAL: 0x0202,
    NOTEQUAL: 0x0205,
    ALWAYS: 0x0207,
    KEEP: 0x1E00,
    REPLACE: 0x1E01,
    INVERT: 0x150A,
    INCR: 0x1E02,
    DECR: 0x1E03,
    INCR_WRAP: 0x8507,
    DECR_WRAP: 0x8508,
    POINTS: 0x0000,
    LINES: 0x0001,
    LINE_STRIP: 0x0003,
    TRIANGLES: 0x0004,
    TRIANGLE_STRIP: 0x0005,
    UNPACK_FLIP_Y_WEBGL: 0x9240,
    DEPTH: 0x8840,
    STENCIL: 0x8841,
    UNIFORM_BUFFER_BINDING: 0x8A28,
    TEXTURE_BINDING_2D: 0x8069,
    TEXTURE_BINDING_3D: 0x806A,
  };

  let idCounter = 1;
  const makeId = () => idCounter++;

  const gl: Record<string, unknown> = {
    ...constants,
    createBuffer: vi.fn(() => ({})),
    deleteBuffer: vi.fn(),
    createTexture: vi.fn(() => ({})),
    deleteTexture: vi.fn(),
    createSampler: vi.fn(() => ({})),
    deleteSampler: vi.fn(),
    createShader: vi.fn(() => ({})),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({})),
    deleteProgram: vi.fn(),
    createFramebuffer: vi.fn(() => ({})),
    deleteFramebuffer: vi.fn(),
    bindBuffer: vi.fn(),
    bindTexture: vi.fn(),
    bindSampler: vi.fn(),
    bindFramebuffer: vi.fn(),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => ""),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => ""),
    useProgram: vi.fn(),
    texImage2D: vi.fn(),
    texImage3D: vi.fn(),
    texSubImage2D: vi.fn(),
    texSubImage3D: vi.fn(),
    texParameteri: vi.fn(),
    generateMipmap: vi.fn(),
    samplerParameteri: vi.fn(),
    samplerParameterf: vi.fn(),
    bufferData: vi.fn(),
    bufferSubData: vi.fn(),
    copyBufferSubData: vi.fn(),
    viewport: vi.fn(),
    depthRange: vi.fn(),
    scissor: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    cullFace: vi.fn(),
    frontFace: vi.fn(),
    depthFunc: vi.fn(),
    depthMask: vi.fn(),
    stencilMaskSeparate: vi.fn(),
    stencilFuncSeparate: vi.fn(),
    stencilOpSeparate: vi.fn(),
    blendEquationSeparate: vi.fn(),
    blendFuncSeparate: vi.fn(),
    colorMask: vi.fn(),
    activeTexture: vi.fn(),
    pixelStorei: vi.fn(),
    drawArrays: vi.fn(),
    drawElements: vi.fn(),
    drawArraysInstanced: vi.fn(),
    drawElementsInstanced: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    vertexAttribDivisor: vi.fn(),
    bindBufferBase: vi.fn(),
    framebufferTexture2D: vi.fn(),
    framebufferTextureLayer: vi.fn(),
    clearBufferfv: vi.fn(),
    clearBufferiv: vi.fn(),
    blitFramebuffer: vi.fn(),
    getExtension: vi.fn(() => null),
    getParameter: vi.fn(() => 4096),
    compressedTexSubImage2D: vi.fn(),
    UNPACK_FLIP_Y_WEBGL: 0x9240,
  };

  return gl as unknown as WebGL2RenderingContext;
}

function createMockCanvas(gl: WebGL2RenderingContext): HTMLCanvasElement {
  const canvas = {
    width: 800,
    height: 600,
    getContext: vi.fn(() => gl),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return canvas as unknown as HTMLCanvasElement;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("WebGL2Backend", () => {
  let gl: WebGL2RenderingContext;
  let canvas: HTMLCanvasElement;
  let backend: WebGL2Backend;

  beforeEach(() => {
    gl = createMockGL();
    canvas = createMockCanvas(gl);
    backend = new WebGL2Backend();
  });

  it("has type 'webgl2'", () => {
    expect(backend.type).toBe("webgl2");
  });

  it("init() returns false without canvas", async () => {
    const result = await backend.init();
    expect(result).toBe(false);
  });

  it("init() returns true with canvas and WebGL2 context", async () => {
    const result = await backend.init({ canvas });
    expect(result).toBe(true);
  });

  it("init() returns false when getContext returns null", async () => {
    const nullCanvas = {
      width: 800,
      height: 600,
      getContext: vi.fn(() => null),
      addEventListener: vi.fn(),
    } as unknown as HTMLCanvasElement;
    const result = await backend.init({ canvas: nullCanvas });
    expect(result).toBe(false);
  });

  it("capabilities getter throws before init", () => {
    expect(() => backend.capabilities).toThrow("not initialized");
  });

  it("capabilities getter returns BackendCapabilities after init", async () => {
    await backend.init({ canvas });
    const caps = backend.capabilities;
    expect(caps.backend).toBe("webgl2");
    expect(caps.computeShaders).toBe(false);
    expect(typeof caps.maxTextureSize).toBe("number");
  });

  it("queue getter throws before init", () => {
    expect(() => backend.queue).toThrow("not initialized");
  });

  it("queue getter returns queue after init", async () => {
    await backend.init({ canvas });
    expect(backend.queue).toBeDefined();
    expect(typeof backend.queue.submit).toBe("function");
  });

  it("getSurfaceFormat() returns default rgba8unorm", () => {
    expect(backend.getSurfaceFormat()).toBe("rgba8unorm");
  });

  it("configureSurface sets surface config", async () => {
    await backend.init({ canvas });
    backend.configureSurface(canvas, { format: "rgba8unorm", width: 1024, height: 768 });
    expect(backend.getSurfaceFormat()).toBe("rgba8unorm");
  });

  it("configureSurface converts bgra8unorm to rgba8unorm", async () => {
    await backend.init({ canvas });
    backend.configureSurface(canvas, { format: "bgra8unorm" });
    expect(backend.getSurfaceFormat()).toBe("rgba8unorm");
  });

  it("configureSurface is a no-op without init", async () => {
    // Should not throw, just log error
    expect(() => backend.configureSurface(canvas, {})).not.toThrow();
  });

  it("getCurrentSurfaceTexture returns null before configureSurface", async () => {
    await backend.init({ canvas });
    expect(backend.getCurrentSurfaceTexture()).toBeNull();
  });

  it("getCurrentSurfaceTexture returns texture after configureSurface", async () => {
    await backend.init({ canvas });
    backend.configureSurface(canvas, { width: 800, height: 600 });
    const tex = backend.getCurrentSurfaceTexture();
    expect(tex).not.toBeNull();
    expect(tex!.width).toBe(800);
    expect(tex!.height).toBe(600);
  });

  it("reconfigureSurface updates dimensions", async () => {
    await backend.init({ canvas });
    backend.configureSurface(canvas, { width: 800, height: 600 });
    backend.reconfigureSurface(1920, 1080);
    const tex = backend.getCurrentSurfaceTexture();
    expect(tex!.width).toBe(1920);
    expect(tex!.height).toBe(1080);
  });

  it("createBuffer throws before init", () => {
    expect(() => backend.createBuffer({ size: 256, usage: 64 })).toThrow("not initialized");
  });

  it("createBuffer returns WebGL2Buffer after init", async () => {
    await backend.init({ canvas });
    const buf = backend.createBuffer({ size: 256, usage: 64 });
    expect(buf).toBeInstanceOf(WebGL2Buffer);
    expect(buf.size).toBe(256);
    expect(buf.usage).toBe(64);
  });

  it("createTexture throws before init", () => {
    expect(() => backend.createTexture({ size: [64, 64], format: "rgba8unorm", usage: 16 })).toThrow("not initialized");
  });

  it("createTexture returns texture after init", async () => {
    await backend.init({ canvas });
    const tex = backend.createTexture({ size: [64, 64], format: "rgba8unorm", usage: 16 });
    expect(tex.width).toBe(64);
    expect(tex.height).toBe(64);
    expect(tex.format).toBe("rgba8unorm");
  });

  it("createSampler throws before init", () => {
    expect(() => backend.createSampler({})).toThrow("not initialized");
  });

  it("createSampler returns sampler after init", async () => {
    await backend.init({ canvas });
    const sampler = backend.createSampler({ magFilter: "linear", minFilter: "linear" });
    expect(sampler).toBeDefined();
  });

  it("createShaderModule throws before init", () => {
    expect(() => backend.createShaderModule({ wgsl: "fn main() {}" }, "wgsl")).toThrow("not initialized");
  });

  it("createBindGroupLayout returns layout", async () => {
    await backend.init({ canvas });
    const layout = backend.createBindGroupLayout({ entries: [] });
    expect(layout).toBeDefined();
  });

  it("createPipelineLayout returns layout", async () => {
    await backend.init({ canvas });
    const bgl = backend.createBindGroupLayout({ entries: [] });
    const pl = backend.createPipelineLayout({ bindGroupLayouts: [bgl] });
    expect(pl).toBeDefined();
  });

  it("createBindGroup returns bind group", async () => {
    await backend.init({ canvas });
    const bgl = backend.createBindGroupLayout({ entries: [] });
    const bg = backend.createBindGroup({ layout: bgl, entries: [] });
    expect(bg).toBeDefined();
  });

  it("createCommandEncoder throws before init", () => {
    expect(() => backend.createCommandEncoder()).toThrow("not initialized");
  });

  it("createCommandEncoder returns encoder after init", async () => {
    await backend.init({ canvas });
    const encoder = backend.createCommandEncoder();
    expect(encoder).toBeInstanceOf(WebGL2CommandEncoder);
  });

  it("createTextureView returns view from texture", async () => {
    await backend.init({ canvas });
    const tex = backend.createTexture({ size: [64, 64], format: "rgba8unorm", usage: 16 });
    const view = backend.createTextureView(tex);
    expect(view).toBeDefined();
  });

  it("destroy() clears state without throwing", async () => {
    await backend.init({ canvas });
    expect(() => backend.destroy()).not.toThrow();
    expect(backend.getNativeDevice()).toBeNull();
  });

  it("destroy() works without init", () => {
    expect(() => backend.destroy()).not.toThrow();
  });

  it("onDeviceLost() does not throw", () => {
    expect(() => backend.onDeviceLost(() => {})).not.toThrow();
  });

  it("getNativeDevice() returns null before init", () => {
    expect(backend.getNativeDevice()).toBeNull();
  });

  it("getNativeDevice() returns GL context after init", async () => {
    await backend.init({ canvas });
    expect(backend.getNativeDevice()).toBe(gl);
  });
});

// ─── Command Encoder Tests ─────────────────────────────────────────────────

describe("WebGL2CommandEncoder", () => {
  it("records and finishes commands", () => {
    const encoder = new WebGL2CommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [],
    });
    pass.setViewport(0, 0, 800, 600, 0, 1);
    pass.draw(6);
    pass.end();
    const cmdBuffer = encoder.finish();
    expect(cmdBuffer).toBeInstanceOf(WebGL2CommandBuffer);
    expect((cmdBuffer as WebGL2CommandBuffer).commands.length).toBeGreaterThan(0);
  });

  it("copyBufferToBuffer records command", () => {
    const encoder = new WebGL2CommandEncoder();
    const src = { glBuffer: {}, target: 0x8892, size: 256, usage: 8, label: undefined, destroyed: false, destroy: vi.fn(), destroyWithGL: vi.fn(), getNative: vi.fn() } as unknown as import("../types.ts").BackendBuffer;
    const dst = { glBuffer: {}, target: 0x8892, size: 256, usage: 8, label: undefined, destroyed: false, destroy: vi.fn(), destroyWithGL: vi.fn(), getNative: vi.fn() } as unknown as import("../types.ts").BackendBuffer;
    encoder.copyBufferToBuffer(src, 0, dst, 0, 256);
    const cmdBuffer = encoder.finish();
    expect((cmdBuffer as WebGL2CommandBuffer).commands.length).toBe(1);
  });
});
