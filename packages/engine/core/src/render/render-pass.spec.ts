import { describe, expect, it, vi } from "bun:test";
import { PassType, type FrameGraphBuilder, type GraphRenderContext } from "./frame-graph";
import { RenderPass, type RenderContext } from "./render-pass";

class TestPass extends RenderPass {
  name = "test-pass";
  passType: PassType = PassType.Render;
  prepareFn = vi.fn();
  executeFn = vi.fn();
  setupFn = vi.fn();
  destroyFn = vi.fn();

  prepare(device: GPUDevice): void {
    this.prepareFn(device);
  }

  setup(builder: FrameGraphBuilder): void {
    this.setupFn(builder);
  }

  execute(ctx: GraphRenderContext): void {
    this.executeFn(ctx);
  }

  destroy(): void {
    this.destroyFn();
  }
}

class TestCustomPass extends TestPass {
  passType: PassType = PassType.Custom;
}

describe("RenderPass", () => {
  describe("prepare()", () => {
    it("receives device as first argument", () => {
      const pass = new TestPass();
      const device = {} as GPUDevice;
      pass.prepare(device);
      expect(pass.prepareFn).toHaveBeenCalledWith(device);
    });
  });

  describe("setup()", () => {
    it("default setup is a no-op that does not throw", () => {
      const pass = new TestPass();
      const builder = {
        colorAttachments: [],
        depthAttachmentDesc: null,
        colorAttachment: vi.fn(),
        depthAttachment: vi.fn(),
        read: vi.fn(),
        write: vi.fn(),
        reads: new Set<number>(),
        writes: new Set<number>(),
      };
      expect(() => pass.setup(builder as unknown as FrameGraphBuilder)).not.toThrow();
    });

    it("calls custom setup function", () => {
      const pass = new TestPass();
      const builder = {
        colorAttachments: [],
        depthAttachmentDesc: null,
        colorAttachment: vi.fn(),
        depthAttachment: vi.fn(),
        read: vi.fn(),
        write: vi.fn(),
        reads: new Set<number>(),
        writes: new Set<number>(),
      };
      pass.setup(builder as unknown as FrameGraphBuilder);
      expect(pass.setupFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("execute()", () => {
    it("calls custom execute function with context", () => {
      const pass = new TestPass();
      const ctx = {} as GraphRenderContext;
      pass.execute(ctx);
      expect(pass.executeFn).toHaveBeenCalledWith(ctx);
    });
  });

  describe("destroy()", () => {
    it("default destroy is a no-op", () => {
      const pass = new TestPass();
      expect(() => pass.destroy()).not.toThrow();
    });

    it("calls custom destroy function", () => {
      const pass = new TestPass();
      pass.destroy();
      expect(pass.destroyFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("passType", () => {
    it("defaults to Render type", () => {
      const pass = new TestPass();
      expect(pass.passType).toBe(PassType.Render);
    });

    it("can be set to Custom type", () => {
      const pass = new TestCustomPass();
      expect(pass.passType).toBe(PassType.Custom);
    });
  });
});

describe("RenderContext", () => {
  it("accepts device and pass fields", () => {
    const device = {} as GPUDevice;
    const ctx: RenderContext = {
      device,
      encoder: {} as GPUCommandEncoder,
      pass: null,
      camera: {} as RenderContext["camera"],
      viewport: {} as RenderContext["viewport"],
      viewportIdx: 0,
      viewportCount: 1,
      dt: 0,
      elapsedTime: 0,
      isFirstViewport: true,
      isLastViewport: true,
      getView: () => ({} as GPUTextureView),
      getTexture: () => ({} as GPUTexture),
      width: 0,
      height: 0,
      viewProj: null,
      invViewProj: null,
      prevViewProj: null,
      cameraPos: [0, 0, 0],
      lightData: null,
      lightViewProj: null,
      mesh: null,
      modelMatrix: null,
      shadowsEnabled: false,
      bloomEnabled: false,
      shadowSampler: null,
      debugQueue: null,
      opaqueVertexBuffer: null,
      opaqueIndexBuffer: null,
      opaqueIndexCount: 0,
      opaqueIndexFormat: "uint16",
      addDrawCalls: () => {},
      addTriangles: () => {},
    };
    expect(ctx.device).toBe(device);
    expect(ctx.pass).toBeDefined();
  });
});
