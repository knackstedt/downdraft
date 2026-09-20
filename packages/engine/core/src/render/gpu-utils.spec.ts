import {
    createBlackTextureView,
    createDefaultTextureView,
    createDepthTexture,
    createStorageBuffer,
    createUniformBuffer,
} from "./gpu-utils";

// WebGPU usage flags are not available in Bun's test environment.
// Define them with the spec values so gpu-utils.ts can use them.
// (Values from https://www.w3.org/TR/webgpu/#buffer-usage)
const _g = globalThis as unknown as Record<string, unknown>;
if (!_g.GPUBufferUsage) {
  _g.GPUBufferUsage = {
    MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8,
    INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128,
    INDIRECT: 256, QUERY_RESOLVE: 512,
  };
}
if (!_g.GPUTextureUsage) {
  _g.GPUTextureUsage = {
    COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4,
    STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16,
  };
}

// Minimal mock GPUDevice — records calls so we can assert usage flags and sizes.
function makeMockDevice(): {
  device: GPUDevice;
  calls: { type: "buffer" | "texture"; usage: number; size?: number; format?: string; textureSize?: [number, number] | [number, number, number] }[];
} {
  const calls: { type: "buffer" | "texture"; usage: number; size?: number; format?: string; textureSize?: [number, number] | [number, number, number] }[] = [];

  const mockTexture: GPUTexture = {
    createView: () => ({ label: "mock-view" }) as unknown as GPUTextureView,
    destroy: () => {},
  } as unknown as GPUTexture;

  const device = {
    createBuffer: (desc: GPUBufferDescriptor): GPUBuffer => {
      calls.push({ type: "buffer", usage: desc.usage, size: desc.size });
      return { size: desc.size, usage: desc.usage } as unknown as GPUBuffer;
    },
    createTexture: (desc: GPUTextureDescriptor): GPUTexture => {
      const s = desc.size;
      let textureSize: [number, number];
      if (typeof s === "number") {
        textureSize = [s, 1];
      } else if (Array.isArray(s)) {
        textureSize = [s[0], s[1]];
      } else {
        textureSize = [(s as GPUExtent3DDict).width, (s as GPUExtent3DDict).height ?? 1];
      }
      calls.push({
        type: "texture",
        usage: desc.usage,
        format: desc.format,
        textureSize,
      });
      return mockTexture;
    },
    queue: {
      writeTexture: () => {},
    },
  } as unknown as GPUDevice;

  return { device, calls };
}

describe("gpu-utils", () => {
  it("createUniformBuffer sets UNIFORM | COPY_DST usage", () => {
    const { device, calls } = makeMockDevice();
    createUniformBuffer(device, 256);
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe("buffer");
    expect(calls[0].size).toBe(256);
    expect(calls[0].usage! & GPUBufferUsage.UNIFORM).toBe(GPUBufferUsage.UNIFORM);
    expect(calls[0].usage! & GPUBufferUsage.COPY_DST).toBe(GPUBufferUsage.COPY_DST);
  });

  it("createStorageBuffer sets STORAGE | COPY_DST | COPY_SRC by default", () => {
    const { device, calls } = makeMockDevice();
    createStorageBuffer(device, 1024);
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe("buffer");
    expect(calls[0].size).toBe(1024);
    expect(calls[0].usage! & GPUBufferUsage.STORAGE).toBe(GPUBufferUsage.STORAGE);
    expect(calls[0].usage! & GPUBufferUsage.COPY_DST).toBe(GPUBufferUsage.COPY_DST);
    expect(calls[0].usage! & GPUBufferUsage.COPY_SRC).toBe(GPUBufferUsage.COPY_SRC);
  });

  it("createStorageBuffer omits COPY_SRC when copySrc=false", () => {
    const { device, calls } = makeMockDevice();
    createStorageBuffer(device, 1024, false);
    expect(calls[0].usage! & GPUBufferUsage.COPY_SRC).toBe(0);
    expect(calls[0].usage! & GPUBufferUsage.STORAGE).toBe(GPUBufferUsage.STORAGE);
    expect(calls[0].usage! & GPUBufferUsage.COPY_DST).toBe(GPUBufferUsage.COPY_DST);
  });

  it("createDefaultTextureView creates a 1x1 texture with TEXTURE_BINDING | COPY_DST", () => {
    const { device, calls } = makeMockDevice();
    const view = createDefaultTextureView(device);
    expect(view).toBeDefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe("texture");
    expect(calls[0].format).toBe("rgba8unorm");
    expect(calls[0].usage! & GPUTextureUsage.TEXTURE_BINDING).toBe(GPUTextureUsage.TEXTURE_BINDING);
    expect(calls[0].usage! & GPUTextureUsage.COPY_DST).toBe(GPUTextureUsage.COPY_DST);
    expect(calls[0].textureSize).toEqual([1, 1]);
  });

  it("createDefaultTextureView respects custom format", () => {
    const { device, calls } = makeMockDevice();
    createDefaultTextureView(device, "bgra8unorm");
    expect(calls[0].format).toBe("bgra8unorm");
  });

  it("createBlackTextureView creates a 1x1 texture", () => {
    const { device, calls } = makeMockDevice();
    const view = createBlackTextureView(device);
    expect(view).toBeDefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe("texture");
    expect(calls[0].textureSize).toEqual([1, 1]);
    expect(calls[0].usage! & GPUTextureUsage.TEXTURE_BINDING).toBe(GPUTextureUsage.TEXTURE_BINDING);
  });

  it("createDepthTexture creates a depth texture with RENDER_ATTACHMENT | TEXTURE_BINDING", () => {
    const { device, calls } = makeMockDevice();
    const tex = createDepthTexture(device, [1920, 1080]);
    expect(tex).toBeDefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe("texture");
    expect(calls[0].format).toBe("depth32float");
    expect(calls[0].textureSize).toEqual([1920, 1080]);
    expect(calls[0].usage! & GPUTextureUsage.RENDER_ATTACHMENT).toBe(GPUTextureUsage.RENDER_ATTACHMENT);
    expect(calls[0].usage! & GPUTextureUsage.TEXTURE_BINDING).toBe(GPUTextureUsage.TEXTURE_BINDING);
  });

  it("createDepthTexture respects custom format", () => {
    const { device, calls } = makeMockDevice();
    createDepthTexture(device, [512, 512], "depth24plus");
    expect(calls[0].format).toBe("depth24plus");
  });
});
