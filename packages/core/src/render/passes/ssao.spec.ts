import { DEFAULT_SSAO_SETTINGS, SSAOPass } from "./ssao.ts";

const mockUsage = { UNIFORM: 0x40, COPY_DST: 0x08, VERTEX: 0x20, INDEX: 0x10, TEXTURE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10, COPY_SRC: 0x80, STORAGE: 0x80 };
(globalThis as unknown as { GPUBufferUsage: unknown }).GPUBufferUsage = mockUsage;
(globalThis as unknown as { GPUTextureUsage: unknown }).GPUTextureUsage = mockUsage;

function makeMockDevice(): unknown {
  return {
    createShaderModule: () => ({}),
    createTexture: () => ({ createView: () => ({}), destroy: () => {} }),
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
      writeTexture: () => {},
      submit: () => {},
    },
  };
}

describe("SSAOPass", () => {
  describe("DEFAULT_SSAO_SETTINGS", () => {
    it("should have radius of 0.5", () => {
      expect(DEFAULT_SSAO_SETTINGS.radius).toBe(0.5);
    });

    it("should have positive bias", () => {
      expect(DEFAULT_SSAO_SETTINGS.bias).toBeGreaterThan(0);
    });

    it("should have kernel size of 32", () => {
      expect(DEFAULT_SSAO_SETTINGS.kernelSize).toBe(32);
    });

    it("should have blur enabled by default", () => {
      expect(DEFAULT_SSAO_SETTINGS.blurEnabled).toBe(true);
    });

    it("should have noise size of 4", () => {
      expect(DEFAULT_SSAO_SETTINGS.noiseSize).toBe(4);
    });
  });

  describe("construction", () => {
    it("should construct with default settings", () => {
      const pass = new SSAOPass(makeMockDevice() as GPUDevice);
      expect(pass.name).toBe("ssao");
    });

    it("should accept partial settings overrides", () => {
      const pass = new SSAOPass(makeMockDevice() as GPUDevice, { radius: 1.0, kernelSize: 16 });
      expect(pass.name).toBe("ssao");
    });
  });

  describe("frame graph integration", () => {
    it("should have null handles by default", () => {
      const pass = new SSAOPass(makeMockDevice() as GPUDevice);
      expect(pass.depthHandle).toBeNull();
      expect(pass.normalHandle).toBeNull();
      expect(pass.outputHandle).toBeNull();
    });

    it("should not crash setup with null handles", () => {
      const pass = new SSAOPass(makeMockDevice() as GPUDevice);
      const builder = {
        read: () => {},
        write: () => {},
      };
      expect(() => pass.setup(builder as never)).not.toThrow();
    });

    it("should not crash execute with null handles", () => {
      const pass = new SSAOPass(makeMockDevice() as GPUDevice);
      const ctx = { device: makeMockDevice(), getView: () => ({}) };
      expect(() => pass.execute(ctx as never)).not.toThrow();
    });
  });

  describe("prepare with backend param", () => {
    it("should accept null backend and use device path", () => {
      const device = makeMockDevice();
      const pass = new SSAOPass(device as GPUDevice);
      expect(() => pass.prepare(device as GPUDevice, null)).not.toThrow();
    });
  });
});
