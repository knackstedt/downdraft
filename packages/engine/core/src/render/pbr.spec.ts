import { describe, expect, it, vi } from "bun:test";
import { PBRSystem, geometrySchlickGGX, geometrySmith, hammersley, integrateBRDF, radicalInverseVdC } from "./pbr";

function mockDevice(): GPUDevice {
  const calls: Record<string, unknown[]> = {};

  const texture = {
    createView: vi.fn(() => ({})),
    destroy: vi.fn(),
    width: 256,
    height: 256,
  };

  const device = {
    createTexture: vi.fn((desc: GPUTextureDescriptor) => {
      calls.createTexture ??= [];
      calls.createTexture.push(desc);
      return texture;
    }),
    createSampler: vi.fn(() => ({})),
    createBindGroupLayout: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
    createShaderModule: vi.fn(() => ({})),
    createComputePipeline: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createBuffer: vi.fn(() => ({})),
    createCommandEncoder: vi.fn(() => ({
      beginComputePass: vi.fn(() => ({
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        dispatchWorkgroups: vi.fn(),
        end: vi.fn(),
      })),
      finish: vi.fn(() => ({})),
    })),
    queue: {
      writeBuffer: vi.fn(),
      submit: vi.fn(),
    },
  };

  return { ...device, __calls: calls } as unknown as GPUDevice;
}

describe("PBRSystem", () => {
  describe("CPU reference functions", () => {
    it("radicalInverseVdC produces valid Van der Corput values", () => {
      expect(radicalInverseVdC(0)).toBe(0);
      expect(radicalInverseVdC(1)).toBeCloseTo(0.5, 5);
      expect(radicalInverseVdC(2)).toBeCloseTo(0.25, 5);
      expect(radicalInverseVdC(3)).toBeCloseTo(0.75, 5);
    });

    it("hammersley returns [i/n, radicalInverse]", () => {
      const [x, y] = hammersley(0, 4);
      expect(x).toBe(0);
      expect(y).toBe(0);
      const [x2, y2] = hammersley(1, 4);
      expect(x2).toBeCloseTo(0.25, 5);
      expect(y2).toBeCloseTo(0.5, 5);
    });

    it("geometrySchlickGGX clamps correctly", () => {
      expect(geometrySchlickGGX(1.0, 0.0)).toBeCloseTo(1.0, 4);
      expect(geometrySchlickGGX(0.0, 1.0)).toBeCloseTo(0.0, 4);
    });

    it("geometrySmith is product of two SchlickGGX", () => {
      const g = geometrySmith(0.5, 0.8, 0.3);
      const g1 = geometrySchlickGGX(0.5, 0.3);
      const g2 = geometrySchlickGGX(0.8, 0.3);
      expect(g).toBeCloseTo(g1 * g2, 8);
    });

    it("integrateBRDF returns values in [0, 1] range", () => {
      const [scale, bias] = integrateBRDF(0.5, 0.5);
      expect(scale).toBeGreaterThanOrEqual(0);
      expect(scale).toBeLessThanOrEqual(1);
      expect(bias).toBeGreaterThanOrEqual(0);
      expect(bias).toBeLessThanOrEqual(1);
    });

    it("integrateBRDF at NdotV=1, roughness=0 returns ~[1, 0]", () => {
      const [scale, bias] = integrateBRDF(1.0, 0.0);
      expect(scale).toBeCloseTo(1.0, 1);
      expect(bias).toBeCloseTo(0.0, 1);
    });
  });

  describe("GPU init", () => {
    it("creates LUT texture with STORAGE_BINDING | TEXTURE_BINDING usage", () => {
      const device = mockDevice();
      const pbr = new PBRSystem(device);
      pbr.init();

      expect(device.createTexture).toHaveBeenCalledWith(
        expect.objectContaining({
          format: "rgba16float",
          usage: expect.any(Number),
        }),
      );
      const desc = (device as any).__calls.createTexture[0] as GPUTextureDescriptor;
      const usage = desc.usage as number;
      // GPUTextureUsage.STORAGE_BINDING = 0x08, TEXTURE_BINDING = 0x04
      expect(usage & 0x08).toBeTruthy(); // STORAGE_BINDING
      expect(usage & 0x04).toBeTruthy(); // TEXTURE_BINDING
    });

    it("creates compute pipeline and dispatches workgroups", () => {
      const device = mockDevice();
      const pbr = new PBRSystem(device);
      pbr.init();

      expect(device.createComputePipeline).toHaveBeenCalled();
      expect(device.createCommandEncoder).toHaveBeenCalled();
      expect(device.queue.submit).toHaveBeenCalled();
    });

    it("lutReady resolves immediately after init", async () => {
      const device = mockDevice();
      const pbr = new PBRSystem(device);
      pbr.init();
      await expect(pbr.lutReady).resolves.toBeUndefined();
    });

    it("creates bind group layout and bind group for fragment sampling", () => {
      const device = mockDevice();
      const pbr = new PBRSystem(device);
      pbr.init();

      expect(device.createBindGroupLayout).toHaveBeenCalled();
      expect(device.createBindGroup).toHaveBeenCalled();
      expect(pbr.getBindGroupLayout()).not.toBeNull();
      expect(pbr.getBindGroup()).not.toBeNull();
    });
  });
});
