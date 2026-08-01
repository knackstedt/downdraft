import { DEFAULT_SSR_SETTINGS, SSRPass } from "./ssr.ts";

function makeMockDevice(): unknown {
  return {
    createShaderModule: () => ({}),
    createSampler: () => ({}),
    createBuffer: () => ({ destroy: () => {} }),
    createBindGroup: () => ({}),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createCommandEncoder: () => ({
      beginRenderPass: () => ({
        setPipeline: () => {},
        setBindGroup: () => {},
        draw: () => {},
        end: () => {},
      }),
      finish: () => ({}),
    }),
    queue: {
      writeBuffer: () => {},
      submit: () => {},
    },
  };
}

describe("SSRPass", () => {
  describe("DEFAULT_SSR_SETTINGS", () => {
    it("should have maxSteps of 64", () => {
      expect(DEFAULT_SSR_SETTINGS.maxSteps).toBe(64);
    });

    it("should have positive thickness", () => {
      expect(DEFAULT_SSR_SETTINGS.thickness).toBeGreaterThan(0);
    });

    it("should have positive maxDistance", () => {
      expect(DEFAULT_SSR_SETTINGS.maxDistance).toBeGreaterThan(0);
    });

    it("should have resolutionScale between 0 and 1", () => {
      expect(DEFAULT_SSR_SETTINGS.resolutionScale).toBeGreaterThan(0);
      expect(DEFAULT_SSR_SETTINGS.resolutionScale).toBeLessThanOrEqual(1);
    });

    it("should have fadeStart < fadeEnd", () => {
      expect(DEFAULT_SSR_SETTINGS.fadeStart).toBeLessThan(DEFAULT_SSR_SETTINGS.fadeEnd);
    });
  });

  describe("construction", () => {
    it("should construct with default settings", () => {
      const pass = new SSRPass(makeMockDevice() as GPUDevice);
      expect(pass.name).toBe("ssr");
    });

    it("should accept partial settings overrides", () => {
      const pass = new SSRPass(makeMockDevice() as GPUDevice, { maxSteps: 32, thickness: 0.1 });
      expect(pass.name).toBe("ssr");
    });
  });

  describe("frame graph integration", () => {
    it("should have null handles by default", () => {
      const pass = new SSRPass(makeMockDevice() as GPUDevice);
      expect(pass.colorHandle).toBeNull();
      expect(pass.depthHandle).toBeNull();
      expect(pass.normalHandle).toBeNull();
      expect(pass.outputHandle).toBeNull();
    });

    it("should not crash setup with null handles", () => {
      const pass = new SSRPass(makeMockDevice() as GPUDevice);
      const builder = { read: () => {}, write: () => {} };
      expect(() => pass.setup(builder as never)).not.toThrow();
    });

    it("should not crash execute with null handles", () => {
      const pass = new SSRPass(makeMockDevice() as GPUDevice);
      const ctx = { device: makeMockDevice(), getView: () => ({}) };
      expect(() => pass.execute(ctx as never)).not.toThrow();
    });
  });
});
