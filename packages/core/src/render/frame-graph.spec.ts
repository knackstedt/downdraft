import { describe, expect, it, vi } from "bun:test";
import { FrameGraph, FrameGraphBuilder, PassType, TextureHandle } from "./frame-graph";
import { RenderPass } from "./render-pass";

// Minimal mock pass for testing — no GPU needed
class MockPass extends RenderPass {
  name: string;
  passType: PassType = PassType.Render;
  setupFn: (builder: FrameGraphBuilder) => void;

  constructor(name: string, setupFn: (builder: FrameGraphBuilder) => void) {
    super();
    this.name = name;
    this.setupFn = setupFn;
  }

  setup(builder: FrameGraphBuilder): void {
    this.setupFn(builder);
  }

  execute(): void {}

  prepare(): void {}
}

// Minimal mock device for compile() — only createTexture is called
function mockDevice(): GPUDevice {
  return {
    createTexture: () => ({
      createView: () => ({}),
      destroy: () => {},
    }),
  } as unknown as GPUDevice;
}

describe("FrameGraph", () => {
  describe("TextureHandle & resource management", () => {
    it("should import external textures", () => {
      const fg = new FrameGraph();
      const fakeTexture = {} as GPUTexture;
      const handle = fg.importTexture("surface", fakeTexture);
      expect(handle).toBeInstanceOf(TextureHandle);
      expect(handle.name).toBe("surface");
      expect(handle.id).toBe(0);
    });

    it("should create transient textures with descriptors", () => {
      const fg = new FrameGraph();
      const handle = fg.createTransient("hdr", {
        format: "rgba16float",
        usage: 0x10, // GPUTextureUsage.RENDER_ATTACHMENT
      });
      expect(handle.name).toBe("hdr");
      expect(handle.id).toBe(0);
    });

    it("should assign unique handle IDs", () => {
      const fg = new FrameGraph();
      const h1 = fg.importTexture("a", {} as GPUTexture);
      const h2 = fg.importTexture("b", {} as GPUTexture);
      const h3 = fg.createTransient("c", { format: "rgba8unorm", usage: 0 });
      expect(h1.id).toBe(0);
      expect(h2.id).toBe(1);
      expect(h3.id).toBe(2);
    });
  });

  describe("FrameGraphBuilder", () => {
    it("should track color attachments as writes", () => {
      const builder = new FrameGraphBuilder();
      const handle = new TextureHandle(0, "color");
      builder.colorAttachment({ handle, loadOp: "clear", storeOp: "store" });
      expect(builder.colorAttachments.length).toBe(1);
      expect(builder.writes.has(0)).toBe(true);
      expect(builder.reads.has(0)).toBe(false);
    });

    it("should track depth attachments as writes when not read-only", () => {
      const builder = new FrameGraphBuilder();
      const handle = new TextureHandle(0, "depth");
      builder.depthAttachment({ handle, depthLoadOp: "clear", depthStoreOp: "store" });
      expect(builder.depthAttachment).not.toBeNull();
      expect(builder.writes.has(0)).toBe(true);
    });

    it("should track read-only depth attachments as reads", () => {
      const builder = new FrameGraphBuilder();
      const handle = new TextureHandle(0, "depth");
      builder.depthAttachment({ handle, depthLoadOp: "load", depthStoreOp: "store", depthReadOnly: true });
      expect(builder.reads.has(0)).toBe(true);
      expect(builder.writes.has(0)).toBe(false);
    });

    it("should track explicit reads and writes", () => {
      const builder = new FrameGraphBuilder();
      const readHandle = new TextureHandle(0, "input");
      const writeHandle = new TextureHandle(1, "output");
      builder.read(readHandle);
      builder.write(writeHandle);
      expect(builder.reads.has(0)).toBe(true);
      expect(builder.writes.has(1)).toBe(true);
      expect(builder.reads.has(1)).toBe(false);
      expect(builder.writes.has(0)).toBe(false);
    });
  });

  describe("Topological sort", () => {
    it("should preserve registration order when no dependencies", () => {
      const fg = new FrameGraph();
      const a = fg.importTexture("a", {} as GPUTexture);
      const b = fg.importTexture("b", {} as GPUTexture);

      const pass1 = new MockPass("pass1", (builder) => {
        builder.colorAttachment({ handle: a, loadOp: "clear", storeOp: "store" });
      });
      const pass2 = new MockPass("pass2", (builder) => {
        builder.colorAttachment({ handle: b, loadOp: "clear", storeOp: "store" });
      });

      fg.addPass(pass1);
      fg.addPass(pass2);
      fg.compile(mockDevice(), 800, 600);

      expect(fg.getPassOrder()).toEqual(["pass1", "pass2"]);
    });

    it("should order passes by resource dependencies", () => {
      const fg = new FrameGraph();
      const color = fg.createTransient("color", { format: "rgba8unorm", usage: 0 });
      const final = fg.createTransient("final", { format: "rgba8unorm", usage: 0 });

      // pass2 reads color (produced by pass1) and writes final
      // pass3 reads final (produced by pass2)
      // Registration order: pass3, pass2, pass1 — should sort to pass1, pass2, pass3
      const pass1 = new MockPass("pass1", (builder) => {
        builder.colorAttachment({ handle: color, loadOp: "clear", storeOp: "store" });
      });
      const pass2 = new MockPass("pass2", (builder) => {
        builder.read(color);
        builder.colorAttachment({ handle: final, loadOp: "clear", storeOp: "store" });
      });
      const pass3 = new MockPass("pass3", (builder) => {
        builder.read(final);
      });

      fg.addPass(pass3);
      fg.addPass(pass2);
      fg.addPass(pass1);
      fg.compile(mockDevice(), 800, 600);

      expect(fg.getPassOrder()).toEqual(["pass1", "pass2", "pass3"]);
    });

    it("should handle diamond dependencies", () => {
      const fg = new FrameGraph();
      const depth = fg.createTransient("depth", { format: "depth32float", usage: 0 });
      const hdr = fg.createTransient("hdr", { format: "rgba16float", usage: 0 });
      const surface = fg.importTexture("surface", {} as GPUTexture);

      const depthPass = new MockPass("depth-prepass", (builder) => {
        builder.depthAttachment({ handle: depth, depthLoadOp: "clear", depthStoreOp: "store" });
      });
      const opaquePass = new MockPass("opaque", (builder) => {
        builder.depthAttachment({ handle: depth, depthLoadOp: "load", depthStoreOp: "store" });
        builder.colorAttachment({ handle: hdr, loadOp: "clear", storeOp: "store" });
      });
      const transparentPass = new MockPass("transparent", (builder) => {
        builder.depthAttachment({ handle: depth, depthLoadOp: "load", depthStoreOp: "store", depthReadOnly: true });
        builder.colorAttachment({ handle: hdr, loadOp: "load", storeOp: "store" });
      });
      const postProcessPass = new MockPass("post-process", (builder) => {
        builder.read(hdr);
        builder.write(surface);
      });

      fg.addPass(depthPass);
      fg.addPass(opaquePass);
      fg.addPass(transparentPass);
      fg.addPass(postProcessPass);
      fg.compile(mockDevice(), 800, 600);

      const order = fg.getPassOrder();
      expect(order[0]).toBe("depth-prepass");
      expect(order.indexOf("opaque")).toBeGreaterThan(order.indexOf("depth-prepass"));
      expect(order.indexOf("transparent")).toBeGreaterThan(order.indexOf("depth-prepass"));
      expect(order.indexOf("post-process")).toBeGreaterThan(order.indexOf("opaque"));
      expect(order.indexOf("post-process")).toBeGreaterThan(order.indexOf("transparent"));
    });

    it("should fall back to registration order on cycles", () => {
      const fg = new FrameGraph();
      const a = fg.createTransient("a", { format: "rgba8unorm", usage: 0 });
      const b = fg.createTransient("b", { format: "rgba8unorm", usage: 0 });

      // pass1 writes a, reads b; pass2 writes b, reads a — circular
      const pass1 = new MockPass("pass1", (builder) => {
        builder.read(b);
        builder.colorAttachment({ handle: a, loadOp: "clear", storeOp: "store" });
      });
      const pass2 = new MockPass("pass2", (builder) => {
        builder.read(a);
        builder.colorAttachment({ handle: b, loadOp: "clear", storeOp: "store" });
      });

      fg.addPass(pass1);
      fg.addPass(pass2);
      fg.compile(mockDevice(), 800, 600);

      // Falls back to registration order
      expect(fg.getPassOrder()).toEqual(["pass1", "pass2"]);
    });
  });

  describe("Validation", () => {
    it("should not report errors for external resources read before production", () => {
      const fg = new FrameGraph();
      const surface = fg.importTexture("surface", {} as GPUTexture);

      const pass = new MockPass("pass", (builder) => {
        builder.read(surface);
      });

      fg.addPass(pass);
      fg.compile(mockDevice(), 800, 600);
      // No throw = no errors
      expect(fg.getPassOrder()).toEqual(["pass"]);
    });
  });

  describe("Compile & transient allocation", () => {
    it("should allocate transient textures on compile", () => {
      const fg = new FrameGraph();
      let createCount = 0;
      const device = {
        createTexture: () => {
          createCount++;
          return { createView: () => ({}), destroy: () => {} };
        },
      } as unknown as GPUDevice;

      const hdr = fg.createTransient("hdr", { format: "rgba16float", usage: 0x10 });
      const depth = fg.createTransient("depth", { format: "depth32float", usage: 0x10 });

      const pass = new MockPass("pass", (builder) => {
        builder.colorAttachment({ handle: hdr, loadOp: "clear", storeOp: "store" });
        builder.depthAttachment({ handle: depth, depthLoadOp: "clear", depthStoreOp: "store" });
      });
      fg.addPass(pass);
      fg.compile(device, 1920, 1080);

      expect(createCount).toBe(2);
    });

    it("should not allocate external textures", () => {
      const fg = new FrameGraph();
      let createCount = 0;
      const device = {
        createTexture: () => {
          createCount++;
          return { createView: () => ({}), destroy: () => {} };
        },
      } as unknown as GPUDevice;

      fg.importTexture("surface", {} as GPUTexture);
      const hdr = fg.createTransient("hdr", { format: "rgba16float", usage: 0 });

      fg.addPass(new MockPass("pass", (builder) => {
        builder.colorAttachment({ handle: hdr, loadOp: "clear", storeOp: "store" });
      }));
      fg.compile(device, 800, 600);

      expect(createCount).toBe(1);
    });
  });

  describe("Destroy", () => {
    it("should clean up transient resources", () => {
      const fg = new FrameGraph();
      const fakeTexture = { createView: () => ({}), destroy: vi.fn() };
      const device = {
        createTexture: () => fakeTexture,
      } as unknown as GPUDevice;

      const hdr = fg.createTransient("hdr", { format: "rgba16float", usage: 0 });
      fg.addPass(new MockPass("pass", (builder) => {
        builder.colorAttachment({ handle: hdr, loadOp: "clear", storeOp: "store" });
      }));
      fg.compile(device, 800, 600);
      fg.destroy();

      expect(fakeTexture.destroy).toHaveBeenCalled();
    });
  });

  describe("Texture aliasing usage compatibility", () => {
    it("should alias resources with superset usage flags", () => {
      const fg = new FrameGraph();
      let createCount = 0;
      const device = {
        createTexture: () => {
          createCount++;
          return { createView: () => ({}), destroy: () => {}, width: 800, height: 600 };
        },
      } as unknown as GPUDevice;

      // Resource A needs RENDER_ATTACHMENT | TEXTURE_BINDING (0x14)
      // Resource B needs only RENDER_ATTACHMENT (0x10) — subset of A's usage
      const a = fg.createTransient("a", { format: "rgba16float", usage: 0x14 });
      const b = fg.createTransient("b", { format: "rgba16float", usage: 0x10 });

      // pass1 writes A, pass2 writes B — non-overlapping lifetimes allow aliasing
      fg.addPass(new MockPass("pass1", (builder) => {
        builder.colorAttachment({ handle: a, loadOp: "clear", storeOp: "store" });
      }));
      fg.addPass(new MockPass("pass2", (builder) => {
        builder.colorAttachment({ handle: b, loadOp: "clear", storeOp: "store" });
      }));
      fg.compile(device, 800, 600);

      // B's usage (0x10) is a subset of A's physical texture usage (0x14),
      // so they should alias — only 1 physical texture created.
      expect(createCount).toBe(1);
      const aliasing = fg.getAliasing();
      expect(aliasing.get("b")).toBe(aliasing.get("a"));
    });

    it("should not alias resources with incompatible usage flags", () => {
      const fg = new FrameGraph();
      let createCount = 0;
      const device = {
        createTexture: () => {
          createCount++;
          return { createView: () => ({}), destroy: () => {}, width: 800, height: 600 };
        },
      } as unknown as GPUDevice;

      // Resource A needs RENDER_ATTACHMENT (0x10)
      // Resource B needs TEXTURE_BINDING (0x04) — not a subset of A's usage
      const a = fg.createTransient("a", { format: "rgba16float", usage: 0x10 });
      const b = fg.createTransient("b", { format: "rgba16float", usage: 0x04 });

      fg.addPass(new MockPass("pass1", (builder) => {
        builder.colorAttachment({ handle: a, loadOp: "clear", storeOp: "store" });
      }));
      fg.addPass(new MockPass("pass2", (builder) => {
        builder.colorAttachment({ handle: b, loadOp: "clear", storeOp: "store" });
      }));
      fg.compile(device, 800, 600);

      // B's usage (0x04) is not a subset of A's physical texture usage (0x10),
      // so they cannot alias — 2 physical textures created.
      expect(createCount).toBe(2);
    });
  });
});
