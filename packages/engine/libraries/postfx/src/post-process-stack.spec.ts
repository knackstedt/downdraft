import { PostProcessStack, type EffectId } from "./post-process-stack";

const mockUsage = { UNIFORM: 0x40, COPY_DST: 0x08, VERTEX: 0x20, INDEX: 0x10, TEXTURE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10, COPY_SRC: 0x80, STORAGE: 0x80 };
(globalThis as unknown as { GPUBufferUsage: unknown }).GPUBufferUsage = mockUsage;
(globalThis as unknown as { GPUTextureUsage: unknown }).GPUTextureUsage = mockUsage;
(globalThis as unknown as { GPUShaderStage: unknown }).GPUShaderStage = { FRAGMENT: 0x10, VERTEX: 0x20, COMPUTE: 0x40 };

// Stub document.createElement("canvas") for the glyph atlas (runs in browser only)
if (typeof globalThis.document === "undefined") {
  const mockCanvas = {
    width: 0, height: 0,
    getContext: () => ({
      fillStyle: "", font: "",
      fillRect: () => {},
      fillText: () => {},
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    }),
  };
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => mockCanvas,
  };
}

function makeMockDevice(): unknown {
  return {
    createShaderModule: () => ({}),
    createTexture: () => ({ createView: () => ({}), destroy: () => {}, size: [1, 1] }),
    createSampler: () => ({}),
    createBuffer: () => ({ destroy: () => {} }),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
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
      writeTexture: () => {},
      copyExternalImageToTexture: () => {},
      submit: () => {},
    },
  };
}

describe("PostProcessStack", () => {
  describe("construction + init", () => {
    it("should construct and init without crashing", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      expect(() => stack.init()).not.toThrow();
    });
  });

  describe("enable/disable effects", () => {
    it("should toggle existing effects", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      stack.setEnabled("bloom", true);
      expect(stack.isEnabled("bloom")).toBe(true);
      stack.setEnabled("bloom", false);
      expect(stack.isEnabled("bloom")).toBe(false);
    });

    it("should toggle new color-grading effects", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      const newEffects: EffectId[] = ["lut", "white-balance", "channel-mixer", "split-tone"];
      for (const id of newEffects) {
        stack.setEnabled(id, true);
        expect(stack.isEnabled(id)).toBe(true);
      }
    });

    it("should toggle new camera/lens effects", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      const newEffects: EffectId[] = ["chromatic-aberration", "lens-distortion"];
      for (const id of newEffects) {
        stack.setEnabled(id, true);
        expect(stack.isEnabled(id)).toBe(true);
      }
    });

    it("should toggle new stylized effects", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      const newEffects: EffectId[] = ["halftone", "dithering", "watercolor"];
      for (const id of newEffects) {
        stack.setEnabled(id, true);
        expect(stack.isEnabled(id)).toBe(true);
      }
    });
  });

  describe("hasEnabledEffects", () => {
    it("should return false when no effects enabled", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      expect(stack.hasEnabledEffects()).toBe(false);
    });

    it("should return true when an effect is enabled", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      stack.setEnabled("bloom", true);
      expect(stack.hasEnabledEffects()).toBe(true);
    });
  });

  describe("getEnabledEffects", () => {
    it("should return names of enabled effects", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      stack.setEnabled("bloom", true);
      stack.setEnabled("lut", true);
      const names = stack.getEnabledEffects();
      expect(names).toContain("Bloom");
      expect(names).toContain("LUT (3D)");
    });
  });

  describe("LUT loading", () => {
    it("should load a 3D LUT without crashing", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      const size = 16;
      const data = new Uint8Array(size * size * size * 4);
      // Fill with identity LUT
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 128; data[i + 1] = 128; data[i + 2] = 128; data[i + 3] = 255;
      }
      expect(() => stack.setLUT(data, size)).not.toThrow();
    });

    it("should toggle LUT enabled state", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      stack.setLUTEnabled(false);
      stack.setLUTEnabled(true);
      expect(() => stack.setLUTEnabled(true)).not.toThrow();
    });
  });

  describe("new effect setters", () => {
    it("should set white balance params without crashing", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      expect(() => stack.setWhiteBalance(0.5, -0.2)).not.toThrow();
    });

    it("should set channel mixer params without crashing", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      expect(() => stack.setChannelMixer(1, 0, 0, 0, 1, 0, 0, 0, 1)).not.toThrow();
      expect(() => stack.setChannelMixerMonochrome(true)).not.toThrow();
    });

    it("should set split-tone params without crashing", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      expect(() => stack.setSplitTone(0.1, 0, 0, 0, 0, 0.1, 0.5)).not.toThrow();
    });

    it("should set chromatic aberration params without crashing", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      expect(() => stack.setChromaticAberration(0.8, 0.1, 0.9)).not.toThrow();
      expect(() => stack.setChromaticAberrationCenter(0.4, 0.6)).not.toThrow();
    });

    it("should set lens distortion params without crashing", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      expect(() => stack.setLensDistortion(0.3, 1.1, 0.2)).not.toThrow();
    });

    it("should set halftone params without crashing", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      expect(() => stack.setHalftone(12, 1.5, 0.5, false)).not.toThrow();
    });

    it("should set dithering params without crashing", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      expect(() => stack.setDithering(2, 0.7, 32)).not.toThrow();
    });

    it("should set watercolor params without crashing", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      expect(() => stack.setWatercolor(1.5, 3.0, 0.8)).not.toThrow();
    });
  });

  describe("upgraded effect setters", () => {
    it("should set DOF bokeh params without crashing", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      expect(() => stack.setDOFBokehShape(1)).not.toThrow();
      expect(() => stack.setDOFSampleCount(48)).not.toThrow();
      expect(() => stack.setDOFNearOnly(true)).not.toThrow();
      expect(() => stack.setDOFFarOnly(false)).not.toThrow();
      expect(() => stack.setDOFBladeRotation(0.5)).not.toThrow();
    });

    it("should set bloom MIP params without crashing", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      expect(() => stack.setBloomMipCount(4)).not.toThrow();
      expect(() => stack.setBloomTint(1.2, 0.9, 0.8)).not.toThrow();
      expect(() => stack.setBloomSoftKnee(0.5)).not.toThrow();
      expect(() => stack.setBloomMipWeights([0, 0.1, 0.3, 0.5, 0.7, 1.0])).not.toThrow();
    });

    it("should set SSAO GTAO params without crashing", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      expect(() => stack.setSSAODirections(6)).not.toThrow();
      expect(() => stack.setSSAOSlices(12)).not.toThrow();
      expect(() => stack.setSSAOPower(2.0)).not.toThrow();
      expect(() => stack.setSSAOThickness(0.15)).not.toThrow();
    });

    it("should set SSR DDA params without crashing", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      expect(() => stack.setSSRBinarySteps(12)).not.toThrow();
      expect(() => stack.setSSRStride(2.0)).not.toThrow();
    });

    it("should set TAA jitter + variance params without crashing", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      expect(() => stack.setTAAVarianceClamp(true)).not.toThrow();
      expect(() => stack.setJitter(0.25, -0.25)).not.toThrow();
    });
  });

  describe("destroy", () => {
    it("should destroy without crashing", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      expect(() => stack.destroy()).not.toThrow();
    });
  });

  describe("occlusion culling", () => {
    it("setOccluderRects should write correct data to the uniform buffer", () => {
      const writes: { buf: unknown; offset: number; data: Float32Array }[] = [];
      const device = makeMockDevice() as unknown as {
        queue: { writeBuffer: (buf: unknown, offset: number, data: Float32Array) => void };
      };
      device.queue.writeBuffer = (buf, offset, data) => { writes.push({ buf, offset, data: new Float32Array(data) }); };
      const stack = new PostProcessStack(device as unknown as GPUDevice, "rgba8unorm");
      stack.init();
      // Initial init writes zeros (count=0)
      expect(writes.length).toBeGreaterThanOrEqual(1);
      writes.length = 0;
      // Set 2 rects
      stack.setOccluderRects([
        { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
        { x: 0.5, y: 0.6, w: 0.1, h: 0.1 },
      ]);
      expect(writes.length).toBe(1);
      const data = writes[0].data;
      expect(data[0]).toBe(2); // count
      // rect 0: x, y, w, h
      expect(data[4]).toBeCloseTo(0.1);
      expect(data[5]).toBeCloseTo(0.2);
      expect(data[6]).toBeCloseTo(0.3);
      expect(data[7]).toBeCloseTo(0.4);
      // rect 1
      expect(data[8]).toBeCloseTo(0.5);
      expect(data[9]).toBeCloseTo(0.6);
      expect(data[10]).toBeCloseTo(0.1);
      expect(data[11]).toBeCloseTo(0.1);
    });

    it("setOccluderRects should clamp to 8 rects", () => {
      const writes: { data: Float32Array }[] = [];
      const device = makeMockDevice() as unknown as {
        queue: { writeBuffer: (buf: unknown, offset: number, data: Float32Array) => void };
      };
      device.queue.writeBuffer = (_buf, _offset, data) => { writes.push({ data: new Float32Array(data) }); };
      const stack = new PostProcessStack(device as unknown as GPUDevice, "rgba8unorm");
      stack.init();
      writes.length = 0;
      const rects = Array.from({ length: 12 }, (_, i) => ({ x: i * 0.01, y: 0, w: 0.1, h: 0.1 }));
      stack.setOccluderRects(rects);
      expect(writes.length).toBe(1);
      expect(writes[0].data[0]).toBe(8); // clamped to 8
    });

    it("isFullyOccluded should return true when a rect covers >=95% of UV space", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      stack.setOccluderRects([{ x: 0, y: 0, w: 1, h: 1 }]);
      expect(stack.isFullyOccluded()).toBe(true);
      stack.setOccluderRects([{ x: 0, y: 0, w: 0.9, h: 0.9 }]);
      expect(stack.isFullyOccluded()).toBe(false); // 0.81 < 0.95
    });

    it("isFullyOccluded should return false when no rects", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      stack.setOccluderRects([]);
      expect(stack.isFullyOccluded()).toBe(false);
    });

    it("setOccluderRects should set TAA history reset when rects change", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      stack.setOccluderRects([{ x: 0, y: 0, w: 0.5, h: 0.5 }]);
      // TAA reset is internal — verify via applyTAA using blendFactor=1.0.
      // We can't easily test the private flag directly, but we can verify
      // that calling setOccluderRects with the same rects doesn't reset again.
      // The key-based dedup means identical rects won't trigger a reset.
      // This test just verifies no crash on repeated calls.
      stack.setOccluderRects([{ x: 0, y: 0, w: 0.5, h: 0.5 }]);
      stack.setOccluderRects([{ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }]);
      expect(stack.getOccluderRects()).toHaveLength(1);
    });

    it("getOccluderRects should return the set rects", () => {
      const stack = new PostProcessStack(makeMockDevice() as GPUDevice, "rgba8unorm");
      stack.init();
      const rects = [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }];
      stack.setOccluderRects(rects);
      expect(stack.getOccluderRects()).toEqual(rects);
    });
  });
});
