import { ShadowPass } from "./shadow";

const mockUsage = { UNIFORM: 0x40, COPY_DST: 0x08, VERTEX: 0x20, INDEX: 0x10, TEXTURE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10, COPY_SRC: 0x80, STORAGE: 0x80, DEPTH_STENCIL_ATTACHMENT: 0x20 };
(globalThis as unknown as { GPUBufferUsage: unknown }).GPUBufferUsage = mockUsage;
(globalThis as unknown as { GPUTextureUsage: unknown }).GPUTextureUsage = mockUsage;

function makeMockDevice(): unknown {
  return {
    createShaderModule: () => ({}),
    createTexture: () => ({ createView: () => ({}), destroy: () => {} }),
    createBuffer: () => ({ destroy: () => {} }),
    createBindGroup: () => ({}),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createCommandEncoder: () => ({
      beginRenderPass: () => ({
        setPipeline: () => {},
        setBindGroup: () => {},
        setVertexBuffer: () => {},
        setIndexBuffer: () => {},
        drawIndexed: () => {},
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

describe("ShadowPass", () => {
  describe("construction", () => {
    it("should construct with a device", () => {
      const pass = new ShadowPass(makeMockDevice() as GPUDevice);
      expect(pass.name).toBe("shadow");
    });

    it("should have Custom pass type", () => {
      const pass = new ShadowPass(makeMockDevice() as GPUDevice);
      expect(pass.passType as string).toBe("custom");
    });
  });

  describe("frame graph integration", () => {
    it("should have null shadowHandle by default", () => {
      const pass = new ShadowPass(makeMockDevice() as GPUDevice);
      expect(pass.shadowHandle).toBeNull();
    });

    it("should not crash setup with null handles", () => {
      const pass = new ShadowPass(makeMockDevice() as GPUDevice);
      const builder = { read: () => {}, write: () => {} };
      expect(() => pass.setup(builder as never)).not.toThrow();
    });

    it("should not crash execute with shadowsEnabled false", () => {
      const pass = new ShadowPass(makeMockDevice() as GPUDevice);
      const ctx = { shadowsEnabled: false };
      expect(() => pass.execute(ctx as never)).not.toThrow();
    });
  });

  describe("getShadowTexture", () => {
    it("should return null before prepare", () => {
      const pass = new ShadowPass(makeMockDevice() as GPUDevice);
      expect(pass.getShadowTexture()).toBeNull();
    });
  });

  describe("setLightViewProj / setModelMatrix", () => {
    it("should not crash before prepare (no uniform buffer)", () => {
      const pass = new ShadowPass(makeMockDevice() as GPUDevice);
      const mat = new Float32Array(16);
      expect(() => pass.setLightViewProj(mat as never)).not.toThrow();
      expect(() => pass.setModelMatrix(mat as never)).not.toThrow();
    });
  });
});
