import { describe, it, expect } from "bun:test";
import { WebGL2Backend } from "./webgl2-backend.ts";

describe("WebGL2Backend stub", () => {
  it("has type 'webgl2'", () => {
    const backend = new WebGL2Backend();
    expect(backend.type).toBe("webgl2");
  });

  it("init() returns false (not yet implemented)", async () => {
    const backend = new WebGL2Backend();
    const result = await backend.init();
    expect(result).toBe(false);
  });

  it("getSurfaceFormat() returns default rgba8unorm", () => {
    const backend = new WebGL2Backend();
    expect(backend.getSurfaceFormat()).toBe("rgba8unorm");
  });

  it("capabilities getter throws before init", () => {
    const backend = new WebGL2Backend();
    expect(() => backend.capabilities).toThrow("not initialized");
  });

  it("queue getter throws (not yet implemented)", () => {
    const backend = new WebGL2Backend();
    expect(() => backend.queue).toThrow("not yet implemented");
  });

  it("configureSurface throws (not yet implemented)", () => {
    const backend = new WebGL2Backend();
    expect(() => backend.configureSurface({} as HTMLCanvasElement)).toThrow("Phase 4");
  });

  it("getCurrentSurfaceTexture throws (not yet implemented)", () => {
    const backend = new WebGL2Backend();
    expect(() => backend.getCurrentSurfaceTexture()).toThrow("Phase 4");
  });

  it("reconfigureSurface throws (not yet implemented)", () => {
    const backend = new WebGL2Backend();
    expect(() => backend.reconfigureSurface(800, 600)).toThrow("Phase 4");
  });

  it("createBuffer throws (not yet implemented)", () => {
    const backend = new WebGL2Backend();
    expect(() => backend.createBuffer({ size: 256, usage: 64 })).toThrow("Phase 4");
  });

  it("createTexture throws (not yet implemented)", () => {
    const backend = new WebGL2Backend();
    expect(() => backend.createTexture({ size: [64, 64], format: "rgba8unorm", usage: 16 })).toThrow("Phase 4");
  });

  it("createSampler throws (not yet implemented)", () => {
    const backend = new WebGL2Backend();
    expect(() => backend.createSampler({})).toThrow("Phase 4");
  });

  it("createShaderModule throws (not yet implemented)", () => {
    const backend = new WebGL2Backend();
    expect(() => backend.createShaderModule({ wgsl: "fn main() {}" }, "wgsl")).toThrow("Phase 4");
  });

  it("createBindGroupLayout throws (not yet implemented)", () => {
    const backend = new WebGL2Backend();
    expect(() => backend.createBindGroupLayout({ entries: [] })).toThrow("Phase 4");
  });

  it("createPipelineLayout throws (not yet implemented)", () => {
    const backend = new WebGL2Backend();
    expect(() => backend.createPipelineLayout({ bindGroupLayouts: [] })).toThrow("Phase 4");
  });

  it("createBindGroup throws (not yet implemented)", () => {
    const backend = new WebGL2Backend();
    expect(() => backend.createBindGroup({ layout: {} as never, entries: [] })).toThrow("Phase 4");
  });

  it("createRenderPipeline throws (not yet implemented)", () => {
    const backend = new WebGL2Backend();
    expect(() => backend.createRenderPipeline({} as never)).toThrow("Phase 4");
  });

  it("createCommandEncoder throws (not yet implemented)", () => {
    const backend = new WebGL2Backend();
    expect(() => backend.createCommandEncoder()).toThrow("Phase 4");
  });

  it("createTextureView throws (not yet implemented)", () => {
    const backend = new WebGL2Backend();
    expect(() => backend.createTextureView({} as never)).toThrow("Phase 4");
  });

  it("destroy() clears state without throwing", () => {
    const backend = new WebGL2Backend();
    expect(() => backend.destroy()).not.toThrow();
  });

  it("onDeviceLost() does not throw", () => {
    const backend = new WebGL2Backend();
    expect(() => backend.onDeviceLost(() => {})).not.toThrow();
  });

  it("getNativeDevice() returns null before init", () => {
    const backend = new WebGL2Backend();
    expect(backend.getNativeDevice()).toBeNull();
  });
});
