import { beforeEach, describe, expect, it, vi } from "bun:test";
import { WebGL2CommandBuffer, type Command } from "./webgl2-encoders.ts";
import { WebGL2Queue } from "./webgl2-queue.ts";
import { WebGL2BindGroup, WebGL2BindGroupLayout, WebGL2Buffer, WebGL2RenderPipeline, WebGL2Sampler, WebGL2Texture, WebGL2TextureView } from "./webgl2-resources.ts";

// ─── Mock GL Context ───────────────────────────────────────────────────────

function createMockGL() {
  const constants: Record<string, number> = {
    TEXTURE_2D: 0x0DE1, TEXTURE_3D: 0x806F, TEXTURE_2D_ARRAY: 0x8C1A,
    ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, UNIFORM_BUFFER: 0x8A11,
    COPY_READ_BUFFER: 0x8F36, COPY_WRITE_BUFFER: 0x8F37,
    PIXEL_UNPACK_BUFFER: 0x88EC, PIXEL_PACK_BUFFER: 0x88EB,
    RGBA: 0x1908, RGBA8: 0x8058, FLOAT: 0x1406, UNSIGNED_BYTE: 0x1401,
    UNSIGNED_SHORT: 0x1403, UNSIGNED_INT: 0x1405,
    TEXTURE0: 0x84C0, FRAMEBUFFER: 0x8D40,
    COLOR_ATTACHMENT0: 0x8CE0, DEPTH_ATTACHMENT: 0x8D00,
    DEPTH_STENCIL_ATTACHMENT: 0x821A,
    COLOR_BUFFER_BIT: 0x4000, NEAREST: 0x2600,
    READ_FRAMEBUFFER: 0x8CA8, DRAW_FRAMEBUFFER: 0x8CA9,
    DEPTH: 0x8840, STENCIL: 0x8841,
    UNPACK_FLIP_Y_WEBGL: 0x9240,
    FUNC_ADD: 0x8006, BLEND: 0x0BE2,
    DEPTH_TEST: 0x0B71, STENCIL_TEST: 0x0B90, CULL_FACE: 0x0B44,
    NONE: 0, ZERO: 0, ONE: 1,
    FRONT: 0x0404, BACK: 0x0405, CCW: 0x0901, CW: 0x0900,
    ALWAYS: 0x0207, KEEP: 0x1E00,
    TRIANGLES: 0x0004, LINES: 0x0001, POINTS: 0x0000,
    SRC_COLOR: 0x0300, ONE_MINUS_SRC_COLOR: 0x0301,
    SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303,
    DST_COLOR: 0x0306, ONE_MINUS_DST_COLOR: 0x0307,
    DST_ALPHA: 0x0304, ONE_MINUS_DST_ALPHA: 0x0305,
    SRC_ALPHA_SATURATE: 0x0308,
    CONSTANT_COLOR: 0x8001, ONE_MINUS_CONSTANT_COLOR: 0x8002,
    FUNC_SUBTRACT: 0x800A, FUNC_REVERSE_SUBTRACT: 0x800B,
    MIN: 0x8007, MAX: 0x8008,
    NEVER: 0x0200, LESS: 0x0201, LEQUAL: 0x0203,
    GREATER: 0x0204, GEQUAL: 0x0206, EQUAL: 0x0202, NOTEQUAL: 0x0205,
    REPLACE: 0x1E01, INVERT: 0x150A, INCR: 0x1E02, DECR: 0x1E03,
    INCR_WRAP: 0x8507, DECR_WRAP: 0x8508,
    LINE_STRIP: 0x0003, TRIANGLE_STRIP: 0x0005,
    COMPARE_REF_TO_TEXTURE: 0x884E,
  };
  let id = 1;
  const gl: Record<string, unknown> = {
    ...constants,
    createBuffer: vi.fn(() => ({ id: id++ })),
    deleteBuffer: vi.fn(),
    createTexture: vi.fn(() => ({ id: id++ })),
    deleteTexture: vi.fn(),
    createFramebuffer: vi.fn(() => ({ id: id++ })),
    deleteFramebuffer: vi.fn(),
    bindBuffer: vi.fn(), bindTexture: vi.fn(), bindFramebuffer: vi.fn(),
    bindBufferBase: vi.fn(), bindSampler: vi.fn(),
    viewport: vi.fn(), depthRange: vi.fn(), scissor: vi.fn(),
    enable: vi.fn(), disable: vi.fn(),
    cullFace: vi.fn(), frontFace: vi.fn(),
    depthFunc: vi.fn(), depthMask: vi.fn(),
    colorMask: vi.fn(),
    blendEquationSeparate: vi.fn(), blendFuncSeparate: vi.fn(),
    stencilMaskSeparate: vi.fn(), stencilFuncSeparate: vi.fn(), stencilOpSeparate: vi.fn(),
    useProgram: vi.fn(),
    drawArrays: vi.fn(), drawElements: vi.fn(),
    drawArraysInstanced: vi.fn(), drawElementsInstanced: vi.fn(),
    enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(), vertexAttribDivisor: vi.fn(),
    activeTexture: vi.fn(),
    pixelStorei: vi.fn(),
    clearBufferfv: vi.fn(), clearBufferiv: vi.fn(),
    copyBufferSubData: vi.fn(),
    bufferSubData: vi.fn(),
    bufferData: vi.fn(),
    texSubImage2D: vi.fn(), compressedTexSubImage2D: vi.fn(),
    blitFramebuffer: vi.fn(),
    framebufferTexture2D: vi.fn(), framebufferTextureLayer: vi.fn(),
    getParameter: vi.fn(() => 4096),
    getExtension: vi.fn(() => null),
  };
  return gl as unknown as WebGL2RenderingContext;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("WebGL2Queue", () => {
  let gl: WebGL2RenderingContext;
  let queue: WebGL2Queue;

  beforeEach(() => {
    gl = createMockGL();
    queue = new WebGL2Queue(gl);
  });

  it("getNative() returns the GL context", () => {
    expect(queue.getNative()).toBe(gl);
  });

  it("submit() with empty array does nothing", () => {
    expect(() => queue.submit([])).not.toThrow();
  });

  it("submit() executes recorded commands", () => {
    const cmds: Command[] = [
      { type: "setViewport", x: 0, y: 0, w: 800, h: 600, minD: 0, maxD: 1 },
    ];
    const cb = new WebGL2CommandBuffer(cmds);
    queue.submit([cb]);
    expect(gl.viewport).toHaveBeenCalledWith(0, 0, 800, 600);
  });

  it("submit() executes draw command", () => {
    const buf = new WebGL2Buffer(gl, 256, 32, "vbuf");
    const tex = new WebGL2Texture(gl, {} as WebGLTexture, 64, 64, 1, "rgba8unorm", 16, 1, 1, "tex", false, "2d");
    const view = new WebGL2TextureView(tex, undefined);
    const pipelineInfo = {
      program: {} as WebGLProgram,
      vertexBuffers: [],
      topology: gl.TRIANGLES,
      cullMode: gl.NONE,
      frontFace: gl.CCW,
      depthTest: false, depthWrite: false, depthFunc: gl.ALWAYS,
      stencilTest: false,
      stencilFront: { failOp: gl.KEEP, depthFailOp: gl.KEEP, passOp: gl.KEEP, compare: gl.ALWAYS },
      stencilBack: { failOp: gl.KEEP, depthFailOp: gl.KEEP, passOp: gl.KEEP, compare: gl.ALWAYS },
      stencilReadMask: 0xFFFFFFFF, stencilWriteMask: 0xFFFFFFFF,
      colorAttachments: [], blendEnabled: false, blendState: null, colorWriteMask: 15,
    };
    const pipeline = new WebGL2RenderPipeline(gl, {} as WebGLProgram, pipelineInfo, "p");

    const cmds: Command[] = [
      { type: "beginRenderPass", desc: { colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] } },
      { type: "setPipeline", pipeline },
      { type: "setVertexBuffer", slot: 0, buffer: buf, offset: 0 },
      { type: "draw", vertexCount: 6, instanceCount: 1, firstVertex: 0, firstInstance: 0 },
      { type: "endRenderPass" },
    ];
    const cb = new WebGL2CommandBuffer(cmds);
    queue.submit([cb]);
    expect(gl.useProgram).toHaveBeenCalled();
    expect(gl.drawArrays).toHaveBeenCalledWith(gl.TRIANGLES, 0, 6);
  });

  it("submit() executes drawIndexed command", () => {
    const indexBuf = new WebGL2Buffer(gl, 256, 16, "ibuf");
    const tex = new WebGL2Texture(gl, {} as WebGLTexture, 64, 64, 1, "rgba8unorm", 16, 1, 1, "tex", false, "2d");
    const view = new WebGL2TextureView(tex, undefined);
    const pipelineInfo = {
      program: {} as WebGLProgram,
      vertexBuffers: [],
      topology: gl.TRIANGLES,
      cullMode: gl.NONE, frontFace: gl.CCW,
      depthTest: false, depthWrite: false, depthFunc: gl.ALWAYS,
      stencilTest: false,
      stencilFront: { failOp: gl.KEEP, depthFailOp: gl.KEEP, passOp: gl.KEEP, compare: gl.ALWAYS },
      stencilBack: { failOp: gl.KEEP, depthFailOp: gl.KEEP, passOp: gl.KEEP, compare: gl.ALWAYS },
      stencilReadMask: 0xFFFFFFFF, stencilWriteMask: 0xFFFFFFFF,
      colorAttachments: [], blendEnabled: false, blendState: null, colorWriteMask: 15,
    };
    const pipeline = new WebGL2RenderPipeline(gl, {} as WebGLProgram, pipelineInfo, "p");

    const cmds: Command[] = [
      { type: "beginRenderPass", desc: { colorAttachments: [{ view, loadOp: "load", storeOp: "store" }] } },
      { type: "setPipeline", pipeline },
      { type: "setIndexBuffer", buffer: indexBuf, format: "uint16" as const, offset: 0 },
      { type: "drawIndexed", indexCount: 36, instanceCount: 1, firstIndex: 0, baseVertex: 0, firstInstance: 0 },
      { type: "endRenderPass" },
    ];
    const cb = new WebGL2CommandBuffer(cmds);
    queue.submit([cb]);
    expect(gl.drawElements).toHaveBeenCalled();
  });

  it("submit() executes drawInstanced when instanceCount > 1", () => {
    const tex = new WebGL2Texture(gl, {} as WebGLTexture, 64, 64, 1, "rgba8unorm", 16, 1, 1, "tex", false, "2d");
    const view = new WebGL2TextureView(tex, undefined);
    const pipelineInfo = {
      program: {} as WebGLProgram, vertexBuffers: [],
      topology: gl.TRIANGLES, cullMode: gl.NONE, frontFace: gl.CCW,
      depthTest: false, depthWrite: false, depthFunc: gl.ALWAYS,
      stencilTest: false,
      stencilFront: { failOp: gl.KEEP, depthFailOp: gl.KEEP, passOp: gl.KEEP, compare: gl.ALWAYS },
      stencilBack: { failOp: gl.KEEP, depthFailOp: gl.KEEP, passOp: gl.KEEP, compare: gl.ALWAYS },
      stencilReadMask: 0xFFFFFFFF, stencilWriteMask: 0xFFFFFFFF,
      colorAttachments: [], blendEnabled: false, blendState: null, colorWriteMask: 15,
    };
    const pipeline = new WebGL2RenderPipeline(gl, {} as WebGLProgram, pipelineInfo, "p");

    const cmds: Command[] = [
      { type: "beginRenderPass", desc: { colorAttachments: [{ view, loadOp: "load", storeOp: "store" }] } },
      { type: "setPipeline", pipeline },
      { type: "draw", vertexCount: 6, instanceCount: 10, firstVertex: 0, firstInstance: 0 },
      { type: "endRenderPass" },
    ];
    const cb = new WebGL2CommandBuffer(cmds);
    queue.submit([cb]);
    expect(gl.drawArraysInstanced).toHaveBeenCalledWith(gl.TRIANGLES, 0, 6, 10);
  });

  it("submit() executes copyBufferToBuffer", () => {
    const src = new WebGL2Buffer(gl, 256, 8, "src");
    const dst = new WebGL2Buffer(gl, 256, 8, "dst");
    const cmds: Command[] = [
      { type: "copyBufferToBuffer", src, srcOffset: 0, dst, dstOffset: 0, size: 256 },
    ];
    const cb = new WebGL2CommandBuffer(cmds);
    queue.submit([cb]);
    expect(gl.copyBufferSubData).toHaveBeenCalledWith(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, 0, 0, 256);
  });

  it("submit() executes setScissor", () => {
    const cmds: Command[] = [
      { type: "setScissor", x: 10, y: 20, w: 100, h: 200 },
    ];
    const cb = new WebGL2CommandBuffer(cmds);
    queue.submit([cb]);
    expect(gl.scissor).toHaveBeenCalledWith(10, 20, 100, 200);
  });

  it("submit() handles multiple command buffers", () => {
    const cb1 = new WebGL2CommandBuffer([
      { type: "setViewport", x: 0, y: 0, w: 100, h: 100, minD: 0, maxD: 1 },
    ]);
    const cb2 = new WebGL2CommandBuffer([
      { type: "setViewport", x: 100, y: 100, w: 200, h: 200, minD: 0, maxD: 1 },
    ]);
    queue.submit([cb1, cb2]);
    expect(gl.viewport).toHaveBeenCalledTimes(2);
  });

  it("writeBuffer() calls bufferSubData", () => {
    const buf = new WebGL2Buffer(gl, 256, 64, "buf");
    const data = new Float32Array(16);
    queue.writeBuffer(buf, 0, data);
    expect(gl.bufferSubData).toHaveBeenCalled();
  });

  it("writeTexture() calls texSubImage2D", () => {
    const tex = new WebGL2Texture(gl, {} as WebGLTexture, 64, 64, 1, "rgba8unorm", 16, 1, 1, "tex", false, "2d");
    const data = new Uint8Array(64 * 64 * 4);
    queue.writeTexture(
      { texture: tex, mipLevel: 0, origin: [0, 0] },
      data,
      { offset: 0, bytesPerRow: 256 },
      [64, 64],
    );
    expect(gl.texSubImage2D).toHaveBeenCalled();
  });

  it("copyExternalImageToTexture() calls texSubImage2D with flipY", () => {
    const tex = new WebGL2Texture(gl, {} as WebGLTexture, 64, 64, 1, "rgba8unorm", 16, 1, 1, "tex", false, "2d");
    const mockImage = {} as CanvasImageSource;
    queue.copyExternalImageToTexture(
      { source: mockImage, flipY: true },
      { texture: tex, mipLevel: 0, origin: [0, 0] },
      [64, 64],
    );
    expect(gl.pixelStorei).toHaveBeenCalledWith(gl.UNPACK_FLIP_Y_WEBGL, 1);
    expect(gl.texSubImage2D).toHaveBeenCalled();
    // Should reset flipY after
    expect(gl.pixelStorei).toHaveBeenCalledWith(gl.UNPACK_FLIP_Y_WEBGL, 0);
  });

  it("onSubmittedWorkDone() resolves", async () => {
    await expect(queue.onSubmittedWorkDone()).resolves.toBeUndefined();
  });

  it("submit() with setBindGroup binds uniform buffer", () => {
    const buf = new WebGL2Buffer(gl, 256, 64, "ubuf");
    const tex = new WebGL2Texture(gl, {} as WebGLTexture, 64, 64, 1, "rgba8unorm", 16, 1, 1, "tex", false, "2d");
    const view = new WebGL2TextureView(tex, undefined);
    const bgl = new WebGL2BindGroupLayout({ entries: [{ binding: 0, visibility: 1, buffer: { type: "uniform" } }] }, "bgl");
    const bg = new WebGL2BindGroup({ entries: [{ binding: 0, resource: { buffer: buf, offset: 0, size: 256 } }], layout: bgl }, "bg");
    const pipelineInfo = {
      program: {} as WebGLProgram, vertexBuffers: [],
      topology: gl.TRIANGLES, cullMode: gl.NONE, frontFace: gl.CCW,
      depthTest: false, depthWrite: false, depthFunc: gl.ALWAYS,
      stencilTest: false,
      stencilFront: { failOp: gl.KEEP, depthFailOp: gl.KEEP, passOp: gl.KEEP, compare: gl.ALWAYS },
      stencilBack: { failOp: gl.KEEP, depthFailOp: gl.KEEP, passOp: gl.KEEP, compare: gl.ALWAYS },
      stencilReadMask: 0xFFFFFFFF, stencilWriteMask: 0xFFFFFFFF,
      colorAttachments: [], blendEnabled: false, blendState: null, colorWriteMask: 15,
    };
    const pipeline = new WebGL2RenderPipeline(gl, {} as WebGLProgram, pipelineInfo, "p");

    const cmds: Command[] = [
      { type: "beginRenderPass", desc: { colorAttachments: [{ view, loadOp: "load", storeOp: "store" }] } },
      { type: "setPipeline", pipeline },
      { type: "setBindGroup", index: 0, group: bg, dynamicOffsets: [] },
      { type: "endRenderPass" },
    ];
    const cb = new WebGL2CommandBuffer(cmds);
    queue.submit([cb]);
    expect(gl.bindBufferBase).toHaveBeenCalledWith(gl.UNIFORM_BUFFER, 0, buf.glBuffer);
  });

  it("submit() with setBindGroup binds texture and sampler", () => {
    const tex = new WebGL2Texture(gl, {} as WebGLTexture, 64, 64, 1, "rgba8unorm", 16, 1, 1, "tex", false, "2d");
    const view = new WebGL2TextureView(tex, undefined);
    const sampler = new WebGL2Sampler(gl, {} as WebGLSampler, "samp");
    const bgl = new WebGL2BindGroupLayout({
      entries: [
        { binding: 1, visibility: 2, texture: { sampleType: "float" } },
        { binding: 2, visibility: 2, sampler: { type: "filtering" } },
      ],
    }, "bgl");
    const bg = new WebGL2BindGroup({
      entries: [
        { binding: 1, resource: { textureView: view } },
        { binding: 2, resource: { sampler } },
      ],
      layout: bgl,
    }, "bg");
    const pipelineInfo = {
      program: {} as WebGLProgram, vertexBuffers: [],
      topology: gl.TRIANGLES, cullMode: gl.NONE, frontFace: gl.CCW,
      depthTest: false, depthWrite: false, depthFunc: gl.ALWAYS,
      stencilTest: false,
      stencilFront: { failOp: gl.KEEP, depthFailOp: gl.KEEP, passOp: gl.KEEP, compare: gl.ALWAYS },
      stencilBack: { failOp: gl.KEEP, depthFailOp: gl.KEEP, passOp: gl.KEEP, compare: gl.ALWAYS },
      stencilReadMask: 0xFFFFFFFF, stencilWriteMask: 0xFFFFFFFF,
      colorAttachments: [], blendEnabled: false, blendState: null, colorWriteMask: 15,
    };
    const pipeline = new WebGL2RenderPipeline(gl, {} as WebGLProgram, pipelineInfo, "p");

    const cmds: Command[] = [
      { type: "beginRenderPass", desc: { colorAttachments: [{ view, loadOp: "load", storeOp: "store" }] } },
      { type: "setPipeline", pipeline },
      { type: "setBindGroup", index: 0, group: bg, dynamicOffsets: [] },
      { type: "endRenderPass" },
    ];
    const cb = new WebGL2CommandBuffer(cmds);
    queue.submit([cb]);
    expect(gl.activeTexture).toHaveBeenCalled();
    expect(gl.bindTexture).toHaveBeenCalled();
    expect(gl.bindSampler).toHaveBeenCalled();
  });

  it("submit() with depth attachment clears depth", () => {
    const depthTex = new WebGL2Texture(gl, {} as WebGLTexture, 64, 64, 1, "depth24plus", 16, 1, 1, "depth", true, "2d");
    const depthView = new WebGL2TextureView(depthTex, undefined);
    const colorTex = new WebGL2Texture(gl, {} as WebGLTexture, 64, 64, 1, "rgba8unorm", 16, 1, 1, "color", false, "2d");
    const colorView = new WebGL2TextureView(colorTex, undefined);

    const cmds: Command[] = [
      {
        type: "beginRenderPass",
        desc: {
          colorAttachments: [{ view: colorView, loadOp: "load", storeOp: "store" }],
          depthStencilAttachment: {
            view: depthView,
            depthLoadOp: "clear", depthStoreOp: "store",
            depthClearValue: 1.0,
          },
        },
      },
      { type: "endRenderPass" },
    ];
    const cb = new WebGL2CommandBuffer(cmds);
    queue.submit([cb]);
    expect(gl.clearBufferfv).toHaveBeenCalled();
  });

  it("submit() applies cull face state", () => {
    const tex = new WebGL2Texture(gl, {} as WebGLTexture, 64, 64, 1, "rgba8unorm", 16, 1, 1, "tex", false, "2d");
    const view = new WebGL2TextureView(tex, undefined);
    const pipelineInfo = {
      program: {} as WebGLProgram, vertexBuffers: [],
      topology: gl.TRIANGLES, cullMode: gl.BACK, frontFace: gl.CCW,
      depthTest: false, depthWrite: false, depthFunc: gl.ALWAYS,
      stencilTest: false,
      stencilFront: { failOp: gl.KEEP, depthFailOp: gl.KEEP, passOp: gl.KEEP, compare: gl.ALWAYS },
      stencilBack: { failOp: gl.KEEP, depthFailOp: gl.KEEP, passOp: gl.KEEP, compare: gl.ALWAYS },
      stencilReadMask: 0xFFFFFFFF, stencilWriteMask: 0xFFFFFFFF,
      colorAttachments: [], blendEnabled: false, blendState: null, colorWriteMask: 15,
    };
    const pipeline = new WebGL2RenderPipeline(gl, {} as WebGLProgram, pipelineInfo, "p");

    const cmds: Command[] = [
      { type: "beginRenderPass", desc: { colorAttachments: [{ view, loadOp: "load", storeOp: "store" }] } },
      { type: "setPipeline", pipeline },
      { type: "endRenderPass" },
    ];
    const cb = new WebGL2CommandBuffer(cmds);
    queue.submit([cb]);
    expect(gl.enable).toHaveBeenCalledWith(gl.CULL_FACE);
    expect(gl.cullFace).toHaveBeenCalledWith(gl.BACK);
  });

  it("submit() applies depth test state", () => {
    const tex = new WebGL2Texture(gl, {} as WebGLTexture, 64, 64, 1, "rgba8unorm", 16, 1, 1, "tex", false, "2d");
    const view = new WebGL2TextureView(tex, undefined);
    const pipelineInfo = {
      program: {} as WebGLProgram, vertexBuffers: [],
      topology: gl.TRIANGLES, cullMode: gl.NONE, frontFace: gl.CCW,
      depthTest: true, depthWrite: true, depthFunc: gl.LESS,
      stencilTest: false,
      stencilFront: { failOp: gl.KEEP, depthFailOp: gl.KEEP, passOp: gl.KEEP, compare: gl.ALWAYS },
      stencilBack: { failOp: gl.KEEP, depthFailOp: gl.KEEP, passOp: gl.KEEP, compare: gl.ALWAYS },
      stencilReadMask: 0xFFFFFFFF, stencilWriteMask: 0xFFFFFFFF,
      colorAttachments: [], blendEnabled: false, blendState: null, colorWriteMask: 15,
    };
    const pipeline = new WebGL2RenderPipeline(gl, {} as WebGLProgram, pipelineInfo, "p");

    const cmds: Command[] = [
      { type: "beginRenderPass", desc: { colorAttachments: [{ view, loadOp: "load", storeOp: "store" }] } },
      { type: "setPipeline", pipeline },
      { type: "endRenderPass" },
    ];
    const cb = new WebGL2CommandBuffer(cmds);
    queue.submit([cb]);
    expect(gl.enable).toHaveBeenCalledWith(gl.DEPTH_TEST);
    expect(gl.depthFunc).toHaveBeenCalledWith(gl.LESS);
    expect(gl.depthMask).toHaveBeenCalledWith(true);
  });

  it("submit() applies blend state", () => {
    const tex = new WebGL2Texture(gl, {} as WebGLTexture, 64, 64, 1, "rgba8unorm", 16, 1, 1, "tex", false, "2d");
    const view = new WebGL2TextureView(tex, undefined);
    const blendState = {
      color: { srcFactor: "src-alpha" as const, dstFactor: "one-minus-src-alpha" as const, operation: "add" as const },
      alpha: { srcFactor: "one" as const, dstFactor: "zero" as const, operation: "add" as const },
    };
    const pipelineInfo = {
      program: {} as WebGLProgram, vertexBuffers: [],
      topology: gl.TRIANGLES, cullMode: gl.NONE, frontFace: gl.CCW,
      depthTest: false, depthWrite: false, depthFunc: gl.ALWAYS,
      stencilTest: false,
      stencilFront: { failOp: gl.KEEP, depthFailOp: gl.KEEP, passOp: gl.KEEP, compare: gl.ALWAYS },
      stencilBack: { failOp: gl.KEEP, depthFailOp: gl.KEEP, passOp: gl.KEEP, compare: gl.ALWAYS },
      stencilReadMask: 0xFFFFFFFF, stencilWriteMask: 0xFFFFFFFF,
      colorAttachments: [], blendEnabled: true, blendState, colorWriteMask: 15,
    };
    const pipeline = new WebGL2RenderPipeline(gl, {} as WebGLProgram, pipelineInfo, "p");

    const cmds: Command[] = [
      { type: "beginRenderPass", desc: { colorAttachments: [{ view, loadOp: "load", storeOp: "store" }] } },
      { type: "setPipeline", pipeline },
      { type: "endRenderPass" },
    ];
    const cb = new WebGL2CommandBuffer(cmds);
    queue.submit([cb]);
    expect(gl.enable).toHaveBeenCalledWith(gl.BLEND);
    expect(gl.blendFuncSeparate).toHaveBeenCalled();
  });

  it("submit() applies stencil state", () => {
    const tex = new WebGL2Texture(gl, {} as WebGLTexture, 64, 64, 1, "rgba8unorm", 16, 1, 1, "tex", false, "2d");
    const view = new WebGL2TextureView(tex, undefined);
    const pipelineInfo = {
      program: {} as WebGLProgram, vertexBuffers: [],
      topology: gl.TRIANGLES, cullMode: gl.NONE, frontFace: gl.CCW,
      depthTest: false, depthWrite: false, depthFunc: gl.ALWAYS,
      stencilTest: true,
      stencilFront: { failOp: gl.KEEP, depthFailOp: gl.KEEP, passOp: gl.REPLACE, compare: gl.ALWAYS },
      stencilBack: { failOp: gl.KEEP, depthFailOp: gl.KEEP, passOp: gl.REPLACE, compare: gl.ALWAYS },
      stencilReadMask: 0xFF, stencilWriteMask: 0xFF,
      colorAttachments: [], blendEnabled: false, blendState: null, colorWriteMask: 15,
    };
    const pipeline = new WebGL2RenderPipeline(gl, {} as WebGLProgram, pipelineInfo, "p");

    const cmds: Command[] = [
      { type: "beginRenderPass", desc: { colorAttachments: [{ view, loadOp: "load", storeOp: "store" }] } },
      { type: "setPipeline", pipeline },
      { type: "endRenderPass" },
    ];
    const cb = new WebGL2CommandBuffer(cmds);
    queue.submit([cb]);
    expect(gl.enable).toHaveBeenCalledWith(gl.STENCIL_TEST);
    expect(gl.stencilOpSeparate).toHaveBeenCalled();
  });

  it("submit() with setVertexBuffer binds vertex attributes", () => {
    const buf = new WebGL2Buffer(gl, 256, 32, "vbuf");
    const tex = new WebGL2Texture(gl, {} as WebGLTexture, 64, 64, 1, "rgba8unorm", 16, 1, 1, "tex", false, "2d");
    const view = new WebGL2TextureView(tex, undefined);
    const pipelineInfo = {
      program: {} as WebGLProgram,
      vertexBuffers: [{
        arrayStride: 12,
        stepMode: "vertex" as const,
        attributes: [{ format: "float32x3" as const, offset: 0, shaderLocation: 0 }],
      }],
      topology: gl.TRIANGLES, cullMode: gl.NONE, frontFace: gl.CCW,
      depthTest: false, depthWrite: false, depthFunc: gl.ALWAYS,
      stencilTest: false,
      stencilFront: { failOp: gl.KEEP, depthFailOp: gl.KEEP, passOp: gl.KEEP, compare: gl.ALWAYS },
      stencilBack: { failOp: gl.KEEP, depthFailOp: gl.KEEP, passOp: gl.KEEP, compare: gl.ALWAYS },
      stencilReadMask: 0xFFFFFFFF, stencilWriteMask: 0xFFFFFFFF,
      colorAttachments: [], blendEnabled: false, blendState: null, colorWriteMask: 15,
    };
    const pipeline = new WebGL2RenderPipeline(gl, {} as WebGLProgram, pipelineInfo, "p");

    const cmds: Command[] = [
      { type: "beginRenderPass", desc: { colorAttachments: [{ view, loadOp: "load", storeOp: "store" }] } },
      { type: "setPipeline", pipeline },
      { type: "setVertexBuffer", slot: 0, buffer: buf, offset: 0 },
      { type: "endRenderPass" },
    ];
    const cb = new WebGL2CommandBuffer(cmds);
    queue.submit([cb]);
    expect(gl.bindBuffer).toHaveBeenCalledWith(gl.ARRAY_BUFFER, buf.glBuffer);
    expect(gl.enableVertexAttribArray).toHaveBeenCalledWith(0);
    expect(gl.vertexAttribPointer).toHaveBeenCalled();
  });

  it("submit() with instance stepMode sets divisor", () => {
    const buf = new WebGL2Buffer(gl, 256, 32, "vbuf");
    const tex = new WebGL2Texture(gl, {} as WebGLTexture, 64, 64, 1, "rgba8unorm", 16, 1, 1, "tex", false, "2d");
    const view = new WebGL2TextureView(tex, undefined);
    const pipelineInfo = {
      program: {} as WebGLProgram,
      vertexBuffers: [{
        arrayStride: 16,
        stepMode: "instance" as const,
        attributes: [{ format: "float32x4" as const, offset: 0, shaderLocation: 1 }],
      }],
      topology: gl.TRIANGLES, cullMode: gl.NONE, frontFace: gl.CCW,
      depthTest: false, depthWrite: false, depthFunc: gl.ALWAYS,
      stencilTest: false,
      stencilFront: { failOp: gl.KEEP, depthFailOp: gl.KEEP, passOp: gl.KEEP, compare: gl.ALWAYS },
      stencilBack: { failOp: gl.KEEP, depthFailOp: gl.KEEP, passOp: gl.KEEP, compare: gl.ALWAYS },
      stencilReadMask: 0xFFFFFFFF, stencilWriteMask: 0xFFFFFFFF,
      colorAttachments: [], blendEnabled: false, blendState: null, colorWriteMask: 15,
    };
    const pipeline = new WebGL2RenderPipeline(gl, {} as WebGLProgram, pipelineInfo, "p");

    const cmds: Command[] = [
      { type: "beginRenderPass", desc: { colorAttachments: [{ view, loadOp: "load", storeOp: "store" }] } },
      { type: "setPipeline", pipeline },
      { type: "setVertexBuffer", slot: 0, buffer: buf, offset: 0 },
      { type: "endRenderPass" },
    ];
    const cb = new WebGL2CommandBuffer(cmds);
    queue.submit([cb]);
    expect(gl.vertexAttribDivisor).toHaveBeenCalledWith(1, 1);
  });

  it("submit() with copyTextureToTexture calls blitFramebuffer", () => {
    const srcTex = new WebGL2Texture(gl, {} as WebGLTexture, 64, 64, 1, "rgba8unorm", 16, 1, 1, "src", false, "2d");
    const dstTex = new WebGL2Texture(gl, {} as WebGLTexture, 64, 64, 1, "rgba8unorm", 16, 1, 1, "dst", false, "2d");
    const cmds: Command[] = [
      { type: "copyTextureToTexture", srcTex, srcMip: 0, srcOrigin: [0, 0], dstTex, dstMip: 0, dstOrigin: [0, 0], copySize: [64, 64] },
    ];
    const cb = new WebGL2CommandBuffer(cmds);
    queue.submit([cb]);
    expect(gl.blitFramebuffer).toHaveBeenCalled();
  });
});
