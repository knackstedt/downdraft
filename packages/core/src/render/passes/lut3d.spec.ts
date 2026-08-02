import { LUT3DPass } from "./lut3d.ts";

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

describe("LUT3DPass", () => {
  describe("construction", () => {
    it("should construct with a device", () => {
      const pass = new LUT3DPass(makeMockDevice() as GPUDevice);
      expect(pass.name).toBe("lut3d");
    });
  });

  describe("frame graph integration", () => {
    it("should have null handles by default", () => {
      const pass = new LUT3DPass(makeMockDevice() as GPUDevice);
      expect(pass.inputHandle).toBeNull();
      expect(pass.outputHandle).toBeNull();
    });

    it("should not crash setup with null handles", () => {
      const pass = new LUT3DPass(makeMockDevice() as GPUDevice);
      const builder = { read: () => {}, write: () => {} };
      expect(() => pass.setup(builder as never)).not.toThrow();
    });

    it("should not crash execute with null handles", () => {
      const pass = new LUT3DPass(makeMockDevice() as GPUDevice);
      const ctx = { device: makeMockDevice(), getView: () => ({}) };
      expect(() => pass.execute(ctx as never)).not.toThrow();
    });
  });

  describe("setEnabled", () => {
    it("should toggle enabled state without crashing", () => {
      const pass = new LUT3DPass(makeMockDevice() as GPUDevice);
      expect(() => pass.setEnabled(true)).not.toThrow();
      expect(() => pass.setEnabled(false)).not.toThrow();
    });
  });

  describe("prepare with backend param", () => {
    it("should accept null backend and use device path", () => {
      const device = makeMockDevice();
      const pass = new LUT3DPass(device as GPUDevice);
      expect(() => pass.prepare(device as GPUDevice, null)).not.toThrow();
    });
  });
});
