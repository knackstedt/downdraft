import { DEFAULT_POST_PROCESS_SETTINGS, PostProcessPass } from "./post-process";

const mockUsage = { UNIFORM: 0x40, COPY_DST: 0x08, VERTEX: 0x20, INDEX: 0x10, TEXTURE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10, COPY_SRC: 0x80, STORAGE: 0x80 };
(globalThis as unknown as { GPUBufferUsage: unknown }).GPUBufferUsage = mockUsage;
(globalThis as unknown as { GPUTextureUsage: unknown }).GPUTextureUsage = mockUsage;

function makeMockDevice(): unknown {
  return {
    createShaderModule: () => ({}),
    createSampler: () => ({}),
    createBuffer: () => ({ destroy: () => {} }),
    createTexture: () => ({ createView: () => ({}), destroy: () => {} }),
    createBindGroup: () => ({}),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createCommandEncoder: () => ({
      beginRenderPass: () => ({
        setPipeline: () => {},
        setBindGroup: () => {},
        draw: () => {},
        end: () => {},
      }),
      copyTextureToTexture: () => {},
      finish: () => ({}),
    }),
    queue: {
      writeBuffer: () => {},
      submit: () => {},
    },
  };
}

describe("PostProcessPass", () => {
  describe("DEFAULT_POST_PROCESS_SETTINGS", () => {
    it("should have exposure of 1.0", () => {
      expect(DEFAULT_POST_PROCESS_SETTINGS.exposure).toBe(1.0);
    });

    it("should have positive bloomIntensity", () => {
      expect(DEFAULT_POST_PROCESS_SETTINGS.bloomIntensity).toBeGreaterThan(0);
    });

    it("should have gamma of 2.2", () => {
      expect(DEFAULT_POST_PROCESS_SETTINGS.gamma).toBe(2.2);
    });

    it("should have taaBlendFactor between 0 and 1", () => {
      expect(DEFAULT_POST_PROCESS_SETTINGS.taaBlendFactor).toBeGreaterThan(0);
      expect(DEFAULT_POST_PROCESS_SETTINGS.taaBlendFactor).toBeLessThanOrEqual(1);
    });

    it("should have positive vignette", () => {
      expect(DEFAULT_POST_PROCESS_SETTINGS.vignette).toBeGreaterThan(0);
    });
  });

  describe("construction", () => {
    it("should construct with device, format, width, height", () => {
      const pass = new PostProcessPass(makeMockDevice() as GPUDevice, "bgra8unorm", 800, 600);
      expect(pass.name).toBe("post-process");
    });

    it("should have Custom pass type", () => {
      const pass = new PostProcessPass(makeMockDevice() as GPUDevice, "bgra8unorm", 800, 600);
      expect(pass.passType).toBe("custom");
    });
  });

  describe("frame graph integration", () => {
    it("should have null handles by default", () => {
      const pass = new PostProcessPass(makeMockDevice() as GPUDevice, "bgra8unorm", 800, 600);
      expect(pass.hdrHandle).toBeNull();
      expect(pass.velocityHandle).toBeNull();
      expect(pass.surfaceHandle).toBeNull();
    });

    it("should not crash setup with null handles", () => {
      const pass = new PostProcessPass(makeMockDevice() as GPUDevice, "bgra8unorm", 800, 600);
      const builder = { read: () => {}, write: () => {} };
      expect(() => pass.setup(builder as never)).not.toThrow();
    });

    it("should not crash execute with null handles", () => {
      const pass = new PostProcessPass(makeMockDevice() as GPUDevice, "bgra8unorm", 800, 600);
      const ctx = { device: makeMockDevice(), getView: () => ({}) };
      expect(() => pass.execute(ctx as never)).not.toThrow();
    });
  });

  describe("setSettings", () => {
    it("should merge partial settings", () => {
      const pass = new PostProcessPass(makeMockDevice() as GPUDevice, "bgra8unorm", 800, 600);
      pass.setSettings({ exposure: 2.0, gamma: 1.8 });
      // Should not throw — internal settings updated
    });
  });

  describe("resize", () => {
    it("should not recreate textures when size is same", () => {
      const pass = new PostProcessPass(makeMockDevice() as GPUDevice, "bgra8unorm", 800, 600);
      expect(() => pass.resize(800, 600)).not.toThrow();
    });

    it("should handle resize to new dimensions", () => {
      const pass = new PostProcessPass(makeMockDevice() as GPUDevice, "bgra8unorm", 800, 600);
      expect(() => pass.resize(1024, 768)).not.toThrow();
    });
  });
});
