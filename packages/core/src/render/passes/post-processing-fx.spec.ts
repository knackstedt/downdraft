import { DEFAULT_EDGES_SETTINGS, EdgesPass } from "./edges";
import { DEFAULT_GLOW_SETTINGS, GlowPass } from "./glow";
import { DEFAULT_GRAIN_SETTINGS, GrainPass } from "./grain";
import { DEFAULT_HIGHLIGHT_SETTINGS, HighlightPass } from "./highlight";
import { DEFAULT_LENS_FLARE_SETTINGS, LensFlarePass } from "./lens-flare";
import { DEFAULT_OUTLINE_SETTINGS, OutlinePass } from "./outline";
import { DEFAULT_SHARPEN_SETTINGS, SharpenPass } from "./sharpen";

const mockUsage = { UNIFORM: 0x40, COPY_DST: 0x08, VERTEX: 0x20, INDEX: 0x10, TEXTURE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10, COPY_SRC: 0x80, STORAGE: 0x80 };
(globalThis as unknown as { GPUBufferUsage: unknown }).GPUBufferUsage = mockUsage;
(globalThis as unknown as { GPUTextureUsage: unknown }).GPUTextureUsage = mockUsage;

function makeMockDevice(): unknown {
  return {
    createShaderModule: () => ({}),
    createSampler: () => ({}),
    createBuffer: () => ({ destroy: () => {} }),
    createTexture: () => ({
      width: 800, height: 600,
      createView: () => ({}),
      destroy: () => {},
    }),
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

function makeMockCtx(device: unknown): unknown {
  return {
    device,
    width: 800,
    height: 600,
    getView: () => ({}),
  };
}

// ─── GrainPass ───

describe("GrainPass", () => {
  describe("DEFAULT_GRAIN_SETTINGS", () => {
    it("should have intensity of 0.05", () => {
      expect(DEFAULT_GRAIN_SETTINGS.intensity).toBe(0.05);
    });
    it("should have luminanceAware enabled", () => {
      expect(DEFAULT_GRAIN_SETTINGS.luminanceAware).toBe(true);
    });
  });

  describe("construction", () => {
    it("should construct with default settings", () => {
      const pass = new GrainPass(makeMockDevice() as GPUDevice);
      expect(pass.name).toBe("grain");
      expect(pass.passType).toBe("custom");
    });
    it("should accept partial settings overrides", () => {
      const pass = new GrainPass(makeMockDevice() as GPUDevice, { intensity: 0.2 });
      expect(pass.name).toBe("grain");
    });
  });

  describe("frame graph integration", () => {
    it("should have null handles by default", () => {
      const pass = new GrainPass(makeMockDevice() as GPUDevice);
      expect(pass.colorHandle).toBeNull();
      expect(pass.outputHandle).toBeNull();
    });
    it("should not crash setup with null handles", () => {
      const pass = new GrainPass(makeMockDevice() as GPUDevice);
      const builder = { read: () => {}, write: () => {} };
      expect(() => pass.setup(builder as never)).not.toThrow();
    });
    it("should not crash execute with null handles", () => {
      const pass = new GrainPass(makeMockDevice() as GPUDevice);
      const ctx = makeMockCtx(makeMockDevice());
      expect(() => pass.execute(ctx as never)).not.toThrow();
    });
  });

  describe("prepare", () => {
    it("should prepare with device path", () => {
      const device = makeMockDevice();
      const pass = new GrainPass(device as GPUDevice);
      expect(() => pass.prepare(device as GPUDevice)).not.toThrow();
    });
  });

  describe("update", () => {
    it("should accumulate time", () => {
      const pass = new GrainPass(makeMockDevice() as GPUDevice);
      pass.update(0.016);
      pass.update(0.016);
    });
  });
});

// ─── SharpenPass ───

describe("SharpenPass", () => {
  describe("DEFAULT_SHARPEN_SETTINGS", () => {
    it("should have sharpness of 0.5", () => {
      expect(DEFAULT_SHARPEN_SETTINGS.sharpness).toBe(0.5);
    });
  });

  describe("construction", () => {
    it("should construct with default settings", () => {
      const pass = new SharpenPass(makeMockDevice() as GPUDevice);
      expect(pass.name).toBe("sharpen");
      expect(pass.passType).toBe("custom");
    });
    it("should accept partial settings overrides", () => {
      const pass = new SharpenPass(makeMockDevice() as GPUDevice, { sharpness: 1.5 });
      expect(pass.name).toBe("sharpen");
    });
  });

  describe("frame graph integration", () => {
    it("should have null handles by default", () => {
      const pass = new SharpenPass(makeMockDevice() as GPUDevice);
      expect(pass.colorHandle).toBeNull();
      expect(pass.outputHandle).toBeNull();
    });
    it("should not crash setup with null handles", () => {
      const pass = new SharpenPass(makeMockDevice() as GPUDevice);
      const builder = { read: () => {}, write: () => {} };
      expect(() => pass.setup(builder as never)).not.toThrow();
    });
    it("should not crash execute with null handles", () => {
      const pass = new SharpenPass(makeMockDevice() as GPUDevice);
      const ctx = makeMockCtx(makeMockDevice());
      expect(() => pass.execute(ctx as never)).not.toThrow();
    });
  });

  describe("prepare", () => {
    it("should prepare with device path", () => {
      const device = makeMockDevice();
      const pass = new SharpenPass(device as GPUDevice);
      expect(() => pass.prepare(device as GPUDevice)).not.toThrow();
    });
  });

  describe("setResolution", () => {
    it("should set width and height", () => {
      const pass = new SharpenPass(makeMockDevice() as GPUDevice);
      pass.setResolution(1920, 1080);
    });
  });
});

// ─── EdgesPass ───

describe("EdgesPass", () => {
  describe("DEFAULT_EDGES_SETTINGS", () => {
    it("should have threshold of 0.4", () => {
      expect(DEFAULT_EDGES_SETTINGS.threshold).toBe(0.4);
    });
    it("should have white edge color", () => {
      expect(DEFAULT_EDGES_SETTINGS.edgeColor).toEqual([1.0, 1.0, 1.0]);
    });
  });

  describe("construction", () => {
    it("should construct with default settings", () => {
      const pass = new EdgesPass(makeMockDevice() as GPUDevice);
      expect(pass.name).toBe("edges");
      expect(pass.passType).toBe("custom");
    });
    it("should accept partial settings overrides", () => {
      const pass = new EdgesPass(makeMockDevice() as GPUDevice, { threshold: 0.8, edgeColor: [1, 0, 0] });
      expect(pass.name).toBe("edges");
    });
  });

  describe("frame graph integration", () => {
    it("should have null handles by default", () => {
      const pass = new EdgesPass(makeMockDevice() as GPUDevice);
      expect(pass.normalHandle).toBeNull();
      expect(pass.depthHandle).toBeNull();
      expect(pass.outputHandle).toBeNull();
    });
    it("should not crash setup with null handles", () => {
      const pass = new EdgesPass(makeMockDevice() as GPUDevice);
      const builder = { read: () => {}, write: () => {} };
      expect(() => pass.setup(builder as never)).not.toThrow();
    });
    it("should not crash execute with null handles", () => {
      const pass = new EdgesPass(makeMockDevice() as GPUDevice);
      const ctx = makeMockCtx(makeMockDevice());
      expect(() => pass.execute(ctx as never)).not.toThrow();
    });
  });

  describe("prepare", () => {
    it("should prepare with device path", () => {
      const device = makeMockDevice();
      const pass = new EdgesPass(device as GPUDevice);
      expect(() => pass.prepare(device as GPUDevice)).not.toThrow();
    });
  });
});

// ─── LensFlarePass ───

describe("LensFlarePass", () => {
  describe("DEFAULT_LENS_FLARE_SETTINGS", () => {
    it("should have intensity of 0.8", () => {
      expect(DEFAULT_LENS_FLARE_SETTINGS.intensity).toBe(0.8);
    });
    it("should have ghostCount of 8", () => {
      expect(DEFAULT_LENS_FLARE_SETTINGS.ghostCount).toBe(8);
    });
  });

  describe("construction", () => {
    it("should construct with default settings", () => {
      const pass = new LensFlarePass(makeMockDevice() as GPUDevice);
      expect(pass.name).toBe("lens-flare");
      expect(pass.passType).toBe("custom");
    });
    it("should accept partial settings overrides", () => {
      const pass = new LensFlarePass(makeMockDevice() as GPUDevice, { intensity: 1.5, ghostCount: 4 });
      expect(pass.name).toBe("lens-flare");
    });
  });

  describe("frame graph integration", () => {
    it("should have null handles by default", () => {
      const pass = new LensFlarePass(makeMockDevice() as GPUDevice);
      expect(pass.colorHandle).toBeNull();
      expect(pass.depthHandle).toBeNull();
      expect(pass.outputHandle).toBeNull();
    });
    it("should not crash setup with null handles", () => {
      const pass = new LensFlarePass(makeMockDevice() as GPUDevice);
      const builder = { read: () => {}, write: () => {} };
      expect(() => pass.setup(builder as never)).not.toThrow();
    });
    it("should not crash execute with null handles", () => {
      const pass = new LensFlarePass(makeMockDevice() as GPUDevice);
      const ctx = makeMockCtx(makeMockDevice());
      expect(() => pass.execute(ctx as never)).not.toThrow();
    });
  });

  describe("prepare", () => {
    it("should prepare with device path", () => {
      const device = makeMockDevice();
      const pass = new LensFlarePass(device as GPUDevice);
      expect(() => pass.prepare(device as GPUDevice)).not.toThrow();
    });
  });

  describe("setLightScreenPos", () => {
    it("should set light position", () => {
      const pass = new LensFlarePass(makeMockDevice() as GPUDevice);
      pass.setLightScreenPos(0.3, 0.7);
    });
  });
});

// ─── OutlinePass ───

describe("OutlinePass", () => {
  describe("DEFAULT_OUTLINE_SETTINGS", () => {
    it("should have outlineWidth of 2.0", () => {
      expect(DEFAULT_OUTLINE_SETTINGS.outlineWidth).toBe(2.0);
    });
    it("should have golden outline color", () => {
      expect(DEFAULT_OUTLINE_SETTINGS.outlineColor).toEqual([1.0, 0.8, 0.2]);
    });
  });

  describe("construction", () => {
    it("should construct with default settings", () => {
      const pass = new OutlinePass(makeMockDevice() as GPUDevice);
      expect(pass.name).toBe("outline");
      expect(pass.passType).toBe("custom");
    });
    it("should accept partial settings overrides", () => {
      const pass = new OutlinePass(makeMockDevice() as GPUDevice, { outlineWidth: 4, outlineColor: [0, 1, 0] });
      expect(pass.name).toBe("outline");
    });
  });

  describe("frame graph integration", () => {
    it("should have null handles by default", () => {
      const pass = new OutlinePass(makeMockDevice() as GPUDevice);
      expect(pass.colorHandle).toBeNull();
      expect(pass.outputHandle).toBeNull();
    });
    it("should not crash setup with null handles", () => {
      const pass = new OutlinePass(makeMockDevice() as GPUDevice);
      const builder = { read: () => {}, write: () => {} };
      expect(() => pass.setup(builder as never)).not.toThrow();
    });
    it("should not crash execute with null handles and no targets", () => {
      const pass = new OutlinePass(makeMockDevice() as GPUDevice);
      const ctx = makeMockCtx(makeMockDevice());
      expect(() => pass.execute(ctx as never)).not.toThrow();
    });
  });

  describe("prepare", () => {
    it("should prepare with device path", () => {
      const device = makeMockDevice();
      const pass = new OutlinePass(device as GPUDevice);
      expect(() => pass.prepare(device as GPUDevice)).not.toThrow();
    });
  });

  describe("setTargets", () => {
    it("should accept empty targets array", () => {
      const pass = new OutlinePass(makeMockDevice() as GPUDevice);
      pass.setTargets([]);
    });
  });
});

// ─── HighlightPass ───

describe("HighlightPass", () => {
  describe("DEFAULT_HIGHLIGHT_SETTINGS", () => {
    it("should have intensity of 0.8", () => {
      expect(DEFAULT_HIGHLIGHT_SETTINGS.intensity).toBe(0.8);
    });
    it("should have blurRadius of 3.0", () => {
      expect(DEFAULT_HIGHLIGHT_SETTINGS.blurRadius).toBe(3.0);
    });
  });

  describe("construction", () => {
    it("should construct with default settings", () => {
      const pass = new HighlightPass(makeMockDevice() as GPUDevice);
      expect(pass.name).toBe("highlight");
      expect(pass.passType).toBe("custom");
    });
    it("should accept partial settings overrides", () => {
      const pass = new HighlightPass(makeMockDevice() as GPUDevice, { intensity: 1.2, blurRadius: 6 });
      expect(pass.name).toBe("highlight");
    });
  });

  describe("frame graph integration", () => {
    it("should have null handles by default", () => {
      const pass = new HighlightPass(makeMockDevice() as GPUDevice);
      expect(pass.colorHandle).toBeNull();
      expect(pass.outputHandle).toBeNull();
    });
    it("should not crash setup with null handles", () => {
      const pass = new HighlightPass(makeMockDevice() as GPUDevice);
      const builder = { read: () => {}, write: () => {} };
      expect(() => pass.setup(builder as never)).not.toThrow();
    });
    it("should not crash execute with null handles and no targets", () => {
      const pass = new HighlightPass(makeMockDevice() as GPUDevice);
      const ctx = makeMockCtx(makeMockDevice());
      expect(() => pass.execute(ctx as never)).not.toThrow();
    });
  });

  describe("prepare", () => {
    it("should prepare with device path", () => {
      const device = makeMockDevice();
      const pass = new HighlightPass(device as GPUDevice);
      expect(() => pass.prepare(device as GPUDevice)).not.toThrow();
    });
  });

  describe("setTargets", () => {
    it("should accept empty targets array", () => {
      const pass = new HighlightPass(makeMockDevice() as GPUDevice);
      pass.setTargets([]);
    });
  });
});

// ─── GlowPass ───

describe("GlowPass", () => {
  describe("DEFAULT_GLOW_SETTINGS", () => {
    it("should have intensity of 1.0", () => {
      expect(DEFAULT_GLOW_SETTINGS.intensity).toBe(1.0);
    });
    it("should have blurRadius of 4.0", () => {
      expect(DEFAULT_GLOW_SETTINGS.blurRadius).toBe(4.0);
    });
  });

  describe("construction", () => {
    it("should construct with default settings", () => {
      const pass = new GlowPass(makeMockDevice() as GPUDevice);
      expect(pass.name).toBe("glow");
      expect(pass.passType).toBe("custom");
    });
    it("should accept partial settings overrides", () => {
      const pass = new GlowPass(makeMockDevice() as GPUDevice, { intensity: 2.0, blurRadius: 8 });
      expect(pass.name).toBe("glow");
    });
  });

  describe("frame graph integration", () => {
    it("should have null handles by default", () => {
      const pass = new GlowPass(makeMockDevice() as GPUDevice);
      expect(pass.colorHandle).toBeNull();
      expect(pass.outputHandle).toBeNull();
    });
    it("should not crash setup with null handles", () => {
      const pass = new GlowPass(makeMockDevice() as GPUDevice);
      const builder = { read: () => {}, write: () => {} };
      expect(() => pass.setup(builder as never)).not.toThrow();
    });
    it("should not crash execute with null handles and no targets", () => {
      const pass = new GlowPass(makeMockDevice() as GPUDevice);
      const ctx = makeMockCtx(makeMockDevice());
      expect(() => pass.execute(ctx as never)).not.toThrow();
    });
  });

  describe("prepare", () => {
    it("should prepare with device path", () => {
      const device = makeMockDevice();
      const pass = new GlowPass(device as GPUDevice);
      expect(() => pass.prepare(device as GPUDevice)).not.toThrow();
    });
  });

  describe("setTargets", () => {
    it("should accept empty targets array", () => {
      const pass = new GlowPass(makeMockDevice() as GPUDevice);
      pass.setTargets([]);
    });
  });
});

// ─── Execute with handles (device path) ───

describe("Execute with handles — device path", () => {
  it("GrainPass should execute with non-null handles", () => {
    const device = makeMockDevice();
    const pass = new GrainPass(device as GPUDevice);
    pass.prepare(device as GPUDevice);
    pass.colorHandle = 1 as never;
    pass.outputHandle = 2 as never;
    const ctx = makeMockCtx(device);
    expect(() => pass.execute(ctx as never)).not.toThrow();
  });

  it("SharpenPass should execute with non-null handles", () => {
    const device = makeMockDevice();
    const pass = new SharpenPass(device as GPUDevice);
    pass.prepare(device as GPUDevice);
    pass.setResolution(800, 600);
    pass.colorHandle = 1 as never;
    pass.outputHandle = 2 as never;
    const ctx = makeMockCtx(device);
    expect(() => pass.execute(ctx as never)).not.toThrow();
  });

  it("EdgesPass should execute with non-null handles", () => {
    const device = makeMockDevice();
    const pass = new EdgesPass(device as GPUDevice);
    pass.prepare(device as GPUDevice);
    pass.setResolution(800, 600);
    pass.normalHandle = 1 as never;
    pass.depthHandle = 2 as never;
    pass.outputHandle = 3 as never;
    const ctx = makeMockCtx(device);
    expect(() => pass.execute(ctx as never)).not.toThrow();
  });

  it("LensFlarePass should execute with non-null handles", () => {
    const device = makeMockDevice();
    const pass = new LensFlarePass(device as GPUDevice);
    pass.prepare(device as GPUDevice);
    pass.setLightScreenPos(0.5, 0.5);
    pass.colorHandle = 1 as never;
    pass.depthHandle = 2 as never;
    pass.outputHandle = 3 as never;
    const ctx = makeMockCtx(device);
    expect(() => pass.execute(ctx as never)).not.toThrow();
  });

  it("OutlinePass should skip execute when no targets set", () => {
    const device = makeMockDevice();
    const pass = new OutlinePass(device as GPUDevice);
    pass.prepare(device as GPUDevice);
    pass.setResolution(800, 600);
    pass.colorHandle = 1 as never;
    pass.outputHandle = 2 as never;
    pass.setTargets([]);
    const ctx = makeMockCtx(device);
    expect(() => pass.execute(ctx as never)).not.toThrow();
  });

  it("HighlightPass should skip execute when no targets set", () => {
    const device = makeMockDevice();
    const pass = new HighlightPass(device as GPUDevice);
    pass.prepare(device as GPUDevice);
    pass.setResolution(800, 600);
    pass.colorHandle = 1 as never;
    pass.outputHandle = 2 as never;
    pass.setTargets([]);
    const ctx = makeMockCtx(device);
    expect(() => pass.execute(ctx as never)).not.toThrow();
  });

  it("GlowPass should skip execute when no targets set", () => {
    const device = makeMockDevice();
    const pass = new GlowPass(device as GPUDevice);
    pass.prepare(device as GPUDevice);
    pass.setResolution(800, 600);
    pass.colorHandle = 1 as never;
    pass.outputHandle = 2 as never;
    pass.setTargets([]);
    const ctx = makeMockCtx(device);
    expect(() => pass.execute(ctx as never)).not.toThrow();
  });
});

// ─── Settings mutation ───

describe("Settings mutation", () => {
  it("GrainPass should apply setSettings", () => {
    const pass = new GrainPass(makeMockDevice() as GPUDevice);
    pass.setSettings({ intensity: 0.3, luminanceAware: false });
  });

  it("SharpenPass should apply setSettings", () => {
    const pass = new SharpenPass(makeMockDevice() as GPUDevice);
    pass.setSettings({ sharpness: 2.0 });
  });

  it("EdgesPass should apply setSettings", () => {
    const pass = new EdgesPass(makeMockDevice() as GPUDevice);
    pass.setSettings({ threshold: 0.9, edgeColor: [0, 1, 0] });
  });

  it("LensFlarePass should apply setSettings", () => {
    const pass = new LensFlarePass(makeMockDevice() as GPUDevice);
    pass.setSettings({ intensity: 1.5, ghostCount: 12 });
  });

  it("OutlinePass should apply setSettings", () => {
    const pass = new OutlinePass(makeMockDevice() as GPUDevice);
    pass.setSettings({ outlineWidth: 5, opacity: 0.5 });
  });

  it("HighlightPass should apply setSettings", () => {
    const pass = new HighlightPass(makeMockDevice() as GPUDevice);
    pass.setSettings({ intensity: 1.5, blurRadius: 8 });
  });

  it("GlowPass should apply setSettings", () => {
    const pass = new GlowPass(makeMockDevice() as GPUDevice);
    pass.setSettings({ intensity: 3.0, blurRadius: 12 });
  });
});
