import { CSMPass, DEFAULT_CSM_SETTINGS } from "./csm.ts";

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

describe("CSMPass", () => {
  describe("DEFAULT_CSM_SETTINGS", () => {
    it("should default to 4 cascades", () => {
      expect(DEFAULT_CSM_SETTINGS.cascadeCount).toBe(4);
    });

    it("should default to 2048 shadow map size", () => {
      expect(DEFAULT_CSM_SETTINGS.shadowMapSize).toBe(2048);
    });

    it("should default lambda to 0.5", () => {
      expect(DEFAULT_CSM_SETTINGS.lambda).toBe(0.5);
    });

    it("should have positive bias values", () => {
      expect(DEFAULT_CSM_SETTINGS.bias).toBeGreaterThan(0);
      expect(DEFAULT_CSM_SETTINGS.normalBias).toBeGreaterThan(0);
    });
  });

  describe("computeCascadeSplits", () => {
    it("should return correct number of splits", () => {
      const pass = new CSMPass(makeMockDevice() as GPUDevice);
      const splits = pass.computeCascadeSplits(0.1, 100.0);
      expect(splits.length).toBe(4);
    });

    it("should produce monotonically increasing splits", () => {
      const pass = new CSMPass(makeMockDevice() as GPUDevice);
      const splits = pass.computeCascadeSplits(0.1, 100.0);
      for (let i = 1; i < splits.length; i++) {
        expect(splits[i]).toBeGreaterThan(splits[i - 1]);
      }
    });

    it("should have all splits between near and far", () => {
      const pass = new CSMPass(makeMockDevice() as GPUDevice);
      const near = 0.1;
      const far = 100.0;
      const splits = pass.computeCascadeSplits(near, far);
      for (const s of splits) {
        expect(s).toBeGreaterThan(near);
        expect(s).toBeLessThanOrEqual(far);
      }
    });

    it("should respect custom cascade count", () => {
      const pass = new CSMPass(makeMockDevice() as GPUDevice, { cascadeCount: 2 });
      const splits = pass.computeCascadeSplits(0.1, 100.0);
      expect(splits.length).toBe(2);
    });

    it("should produce different splits for different lambda values", () => {
      const pass1 = new CSMPass(makeMockDevice() as GPUDevice, { lambda: 0.0 });
      const pass2 = new CSMPass(makeMockDevice() as GPUDevice, { lambda: 1.0 });
      const splits1 = pass1.computeCascadeSplits(0.1, 100.0);
      const splits2 = pass2.computeCascadeSplits(0.1, 100.0);
      expect(splits1).not.toEqual(splits2);
    });

    it("should handle custom cascade count of 1", () => {
      const pass = new CSMPass(makeMockDevice() as GPUDevice, { cascadeCount: 1 });
      const splits = pass.computeCascadeSplits(0.1, 100.0);
      expect(splits.length).toBe(1);
      expect(splits[0]).toBeGreaterThan(0.1);
      expect(splits[0]).toBeLessThanOrEqual(100.0);
    });
  });

  describe("settings overrides", () => {
    it("should merge partial settings with defaults", () => {
      const pass = new CSMPass(makeMockDevice() as GPUDevice, { cascadeCount: 2 });
      expect(pass.cascadeCount).toBe(2);
      expect(pass.shadowMapSize).toBe(DEFAULT_CSM_SETTINGS.shadowMapSize);
    });

    it("should use all defaults when no overrides provided", () => {
      const pass = new CSMPass(makeMockDevice() as GPUDevice);
      expect(pass.cascadeCount).toBe(DEFAULT_CSM_SETTINGS.cascadeCount);
      expect(pass.shadowMapSize).toBe(DEFAULT_CSM_SETTINGS.shadowMapSize);
    });
  });
});
