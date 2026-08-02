import { describe, it, expect, vi } from "bun:test";
import {
  WebGPUBuffer,
  WebGPUTexture,
  WebGPUTextureView,
  WebGPUSampler,
  WebGPUShaderModule,
  WebGPUBindGroupLayout,
  WebGPUPipelineLayout,
  WebGPUBindGroup,
  WebGPURenderPipeline,
} from "./webgpu-resources.ts";

describe("WebGPUBuffer wrapper", () => {
  it("stores and exposes properties", () => {
    const mockBuffer = { destroy: vi.fn() } as unknown as GPUBuffer;
    const wrapper = new WebGPUBuffer(mockBuffer, 1024, 64, "test-buffer");
    expect(wrapper.size).toBe(1024);
    expect(wrapper.usage).toBe(64);
    expect(wrapper.label).toBe("test-buffer");
  });

  it("getNative returns the underlying GPUBuffer", () => {
    const mockBuffer = { destroy: vi.fn() } as unknown as GPUBuffer;
    const wrapper = new WebGPUBuffer(mockBuffer, 512, 32, "buf");
    expect(wrapper.getNative()).toBe(mockBuffer);
  });

  it("gpuBuffer getter returns the underlying buffer", () => {
    const mockBuffer = { destroy: vi.fn() } as unknown as GPUBuffer;
    const wrapper = new WebGPUBuffer(mockBuffer, 512, 32, "buf");
    expect(wrapper.gpuBuffer).toBe(mockBuffer);
  });

  it("destroy() calls underlying buffer.destroy()", () => {
    const destroy = vi.fn();
    const mockBuffer = { destroy } as unknown as GPUBuffer;
    const wrapper = new WebGPUBuffer(mockBuffer, 256, 16, "buf");
    wrapper.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe("WebGPUTexture wrapper", () => {
  it("stores and exposes properties", () => {
    const mockTexture = {
      createView: vi.fn(() => ({})),
      destroy: vi.fn(),
    } as unknown as GPUTexture;
    const wrapper = new WebGPUTexture(mockTexture, 512, 512, 1, "rgba8unorm", 16, 1, 4, "test-tex");
    expect(wrapper.width).toBe(512);
    expect(wrapper.height).toBe(512);
    expect(wrapper.depthOrArrayLayers).toBe(1);
    expect(wrapper.format).toBe("rgba8unorm");
    expect(wrapper.usage).toBe(16);
    expect(wrapper.sampleCount).toBe(1);
    expect(wrapper.mipLevelCount).toBe(4);
    expect(wrapper.label).toBe("test-tex");
  });

  it("getNative returns the underlying GPUTexture", () => {
    const mockTexture = {
      createView: vi.fn(),
      destroy: vi.fn(),
    } as unknown as GPUTexture;
    const wrapper = new WebGPUTexture(mockTexture, 64, 64, 1, "rgba8unorm", 16, 1, 1, "tex");
    expect(wrapper.getNative()).toBe(mockTexture);
  });

  it("createView() creates a WebGPUTextureView", () => {
    const mockView = {};
    const mockTexture = {
      createView: vi.fn(() => mockView),
      destroy: vi.fn(),
    } as unknown as GPUTexture;
    const wrapper = new WebGPUTexture(mockTexture, 64, 64, 1, "rgba8unorm", 16, 1, 1, "tex");
    const view = wrapper.createView({ label: "view1" });
    expect(view).toBeInstanceOf(WebGPUTextureView);
    expect(view.label).toBe("view1");
    expect(view.getNative()).toBe(mockView);
    expect(mockTexture.createView).toHaveBeenCalledWith({ label: "view1" });
  });

  it("destroy() calls underlying texture.destroy()", () => {
    const destroy = vi.fn();
    const mockTexture = {
      createView: vi.fn(),
      destroy,
    } as unknown as GPUTexture;
    const wrapper = new WebGPUTexture(mockTexture, 64, 64, 1, "rgba8unorm", 16, 1, 1, "tex");
    wrapper.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe("WebGPUTextureView wrapper", () => {
  it("stores label and returns native", () => {
    const mockView = {} as GPUTextureView;
    const wrapper = new WebGPUTextureView(mockView, "view-label");
    expect(wrapper.label).toBe("view-label");
    expect(wrapper.getNative()).toBe(mockView);
    expect(wrapper.gpuView).toBe(mockView);
  });

  it("supports undefined label", () => {
    const mockView = {} as GPUTextureView;
    const wrapper = new WebGPUTextureView(mockView, undefined);
    expect(wrapper.label).toBeUndefined();
  });
});

describe("WebGPUSampler wrapper", () => {
  it("stores label and returns native", () => {
    const mockSampler = {} as GPUSampler;
    const wrapper = new WebGPUSampler(mockSampler, "sampler");
    expect(wrapper.label).toBe("sampler");
    expect(wrapper.getNative()).toBe(mockSampler);
    expect(wrapper.gpuSampler).toBe(mockSampler);
  });
});

describe("WebGPUShaderModule wrapper", () => {
  it("stores label and returns native", () => {
    const mockModule = {} as GPUShaderModule;
    const wrapper = new WebGPUShaderModule(mockModule, "shader");
    expect(wrapper.label).toBe("shader");
    expect(wrapper.getNative()).toBe(mockModule);
    expect(wrapper.gpuModule).toBe(mockModule);
  });
});

describe("WebGPUBindGroupLayout wrapper", () => {
  it("stores label and returns native", () => {
    const mockLayout = {} as GPUBindGroupLayout;
    const wrapper = new WebGPUBindGroupLayout(mockLayout, "bgl");
    expect(wrapper.label).toBe("bgl");
    expect(wrapper.getNative()).toBe(mockLayout);
    expect(wrapper.gpuLayout).toBe(mockLayout);
  });
});

describe("WebGPUPipelineLayout wrapper", () => {
  it("stores label and returns native", () => {
    const mockLayout = {} as GPUPipelineLayout;
    const wrapper = new WebGPUPipelineLayout(mockLayout, "pl");
    expect(wrapper.label).toBe("pl");
    expect(wrapper.getNative()).toBe(mockLayout);
    expect(wrapper.gpuLayout).toBe(mockLayout);
  });
});

describe("WebGPUBindGroup wrapper", () => {
  it("stores label and returns native", () => {
    const mockGroup = {} as GPUBindGroup;
    const wrapper = new WebGPUBindGroup(mockGroup, "bg");
    expect(wrapper.label).toBe("bg");
    expect(wrapper.getNative()).toBe(mockGroup);
    expect(wrapper.gpuGroup).toBe(mockGroup);
  });
});

describe("WebGPURenderPipeline wrapper", () => {
  it("stores label and returns native", () => {
    const mockPipeline = {} as GPURenderPipeline;
    const wrapper = new WebGPURenderPipeline(mockPipeline, "pipeline");
    expect(wrapper.label).toBe("pipeline");
    expect(wrapper.getNative()).toBe(mockPipeline);
    expect(wrapper.gpuPipeline).toBe(mockPipeline);
  });
});
