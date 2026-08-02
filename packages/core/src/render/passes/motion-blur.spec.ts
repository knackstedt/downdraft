import { DEFAULT_MOTION_BLUR_SETTINGS, MotionBlurPass } from "./motion-blur.ts";

const mockUsage = { UNIFORM: 0x40, COPY_DST: 0x08, VERTEX: 0x20, INDEX: 0x10, TEXTURE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10, COPY_SRC: 0x80, STORAGE: 0x80 };
(globalThis as unknown as { GPUBufferUsage: unknown }).GPUBufferUsage = mockUsage;
(globalThis as unknown as { GPUTextureUsage: unknown }).GPUTextureUsage = mockUsage;

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

describe("MotionBlurPass", () => {
  describe("DEFAULT_MOTION_BLUR_SETTINGS", () => {
    it("should have intensity of 1.0", () => {
      expect(DEFAULT_MOTION_BLUR_SETTINGS.intensity).toBe(1.0);
    });

    it("should have maxSamples of 16", () => {
      expect(DEFAULT_MOTION_BLUR_SETTINGS.maxSamples).toBe(16);
    });
  });

  describe("construction", () => {
    it("should construct with default settings", () => {
      const pass = new MotionBlurPass(makeMockDevice() as GPUDevice);
      expect(pass.name).toBe("motion-blur");
    });

    it("should accept partial settings overrides", () => {
      const pass = new MotionBlurPass(makeMockDevice() as GPUDevice, { intensity: 0.5, maxSamples: 8 });
      expect(pass.name).toBe("motion-blur");
    });
  });

  describe("frame graph integration", () => {
    it("should have null handles by default", () => {
      const pass = new MotionBlurPass(makeMockDevice() as GPUDevice);
      expect(pass.colorHandle).toBeNull();
      expect(pass.velocityHandle).toBeNull();
      expect(pass.depthHandle).toBeNull();
      expect(pass.outputHandle).toBeNull();
    });

    it("should not crash setup with null handles", () => {
      const pass = new MotionBlurPass(makeMockDevice() as GPUDevice);
      const builder = { read: () => {}, write: () => {} };
      expect(() => pass.setup(builder as never)).not.toThrow();
    });

    it("should not crash execute with null handles", () => {
      const pass = new MotionBlurPass(makeMockDevice() as GPUDevice);
      const ctx = { device: makeMockDevice(), getView: () => ({}) };
      expect(() => pass.execute(ctx as never)).not.toThrow();
    });
  });

  describe("prepare with backend param", () => {
    it("should accept null backend and use device path", () => {
      const device = makeMockDevice();
      const pass = new MotionBlurPass(device as GPUDevice);
      expect(() => pass.prepare(device as GPUDevice, null)).not.toThrow();
    });
  });
});
