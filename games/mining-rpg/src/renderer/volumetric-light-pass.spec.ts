import { describe, expect, it } from "bun:test";
import {
    DEFAULT_VOLUMETRIC_LIGHT_CONFIG,
    LIGHT_STRUCT_FLOATS,
    MAX_WORLD_LIGHTS
} from "../shared/constants";
import { VolumetricLightPass } from "./volumetric-light-pass";

// WebGPU usage flags are not available in Bun's test environment.
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
if (!_g.GPUShaderStage) {
  _g.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
}

// Minimal mock GPUDevice — records calls so we can assert resource creation.
function makeMockDevice(): {
  device: GPUDevice;
  textures: { format: string; usage: number; size: number[] }[];
  buffers: { size: number; usage: number }[];
  pipelines: { fragmentEntryPoint: string }[];
  stats: { bindGroups: number; draws: number; renderPasses: number };
} {
  const textures: { format: string; usage: number; size: number[] }[] = [];
  const buffers: { size: number; usage: number }[] = [];
  const pipelines: { fragmentEntryPoint: string }[] = [];
  const stats = { bindGroups: 0, draws: 0, renderPasses: 0 };

  const mockView = { label: "mock-view" } as unknown as GPUTextureView;

  const mockTexture = {
    createView: () => mockView,
    destroy: () => {},
  } as unknown as GPUTexture;

  const mockPipeline = {} as unknown as GPURenderPipeline;

  const mockBindGroupLayout = {} as unknown as GPUBindGroupLayout;

  const mockPass = {
    setPipeline: () => {},
    setBindGroup: () => {},
    draw: (v: number) => { stats.draws += v; },
    end: () => {},
  } as unknown as GPURenderPassEncoder;

  const device = {
    createBuffer: (desc: GPUBufferDescriptor): GPUBuffer => {
      buffers.push({ size: desc.size, usage: desc.usage });
      return { size: desc.size, destroy: () => {} } as unknown as GPUBuffer;
    },
    createTexture: (desc: GPUTextureDescriptor): GPUTexture => {
      const s = desc.size;
      const size = typeof s === "number" ? [s] : Array.isArray(s) ? [...s] : [s.width, s.height];
      textures.push({ format: desc.format, usage: desc.usage, size });
      return mockTexture;
    },
    createBindGroupLayout: () => mockBindGroupLayout,
    createPipelineLayout: () => ({}) as unknown as GPUPipelineLayout,
    createShaderModule: () => ({}) as unknown as GPUShaderModule,
    createRenderPipeline: (desc: GPURenderPipelineDescriptor): GPURenderPipeline => {
      pipelines.push({ fragmentEntryPoint: desc.fragment.entryPoint });
      return mockPipeline;
    },
    createBindGroup: (): GPUBindGroup => {
      stats.bindGroups++;
      return {} as unknown as GPUBindGroup;
    },
    createCommandEncoder: (): GPUCommandEncoder => {
      return {
        beginRenderPass: () => {
          stats.renderPasses++;
          return mockPass;
        },
      } as unknown as GPUCommandEncoder;
    },
    queue: {
      writeBuffer: () => {},
      writeTexture: () => {},
    },
  } as unknown as GPUDevice;

  return { device, textures, buffers, pipelines, stats };
}

describe("VolumetricLightPass", () => {
  describe("DEFAULT_VOLUMETRIC_LIGHT_CONFIG", () => {
    it("has expected defaults", () => {
      expect(DEFAULT_VOLUMETRIC_LIGHT_CONFIG.iterations).toBe(16);
      expect(DEFAULT_VOLUMETRIC_LIGHT_CONFIG.airPropagation).toBe(0.85);
      expect(DEFAULT_VOLUMETRIC_LIGHT_CONFIG.waterPropagation).toBe(0.8);
      expect(DEFAULT_VOLUMETRIC_LIGHT_CONFIG.solidPropagation).toBe(0.2);
      expect(DEFAULT_VOLUMETRIC_LIGHT_CONFIG.ambientDepthFalloff).toBe(40);
    });

    it("air propagation is highest (light spreads best through air)", () => {
      const c = DEFAULT_VOLUMETRIC_LIGHT_CONFIG;
      expect(c.airPropagation).toBeGreaterThan(c.waterPropagation);
      expect(c.waterPropagation).toBeGreaterThan(c.solidPropagation);
    });

    it("water absorption tint is blue-green biased", () => {
      const [r, g, b] = DEFAULT_VOLUMETRIC_LIGHT_CONFIG.waterAbsorption;
      expect(b).toBeGreaterThanOrEqual(r);
      expect(b).toBeGreaterThanOrEqual(g);
    });
  });

  describe("init", () => {
    it("creates two ping-pong rgba16float render-target textures at half-res", () => {
      const { device, textures } = makeMockDevice();
      const pass = new VolumetricLightPass(device);
      pass.init(640, 640);

      const fieldTextures = textures.filter(
        (t) => t.format === "rgba16float" && (t.usage & GPUTextureUsage.RENDER_ATTACHMENT) !== 0,
      );
      expect(fieldTextures).toHaveLength(2);
      expect(fieldTextures[0].size).toEqual([320, 320]);
      expect(fieldTextures[1].size).toEqual([320, 320]);
    });

    it("creates uniform buffer for params and storage buffer for light data", () => {
      const { device, buffers } = makeMockDevice();
      const pass = new VolumetricLightPass(device);
      pass.init(640, 640);

      const uniformBufs = buffers.filter((b) => (b.usage & GPUBufferUsage.UNIFORM) !== 0);
      expect(uniformBufs).toHaveLength(1);
      const storageBufs = buffers.filter((b) => (b.usage & GPUBufferUsage.STORAGE) !== 0);
      expect(storageBufs).toHaveLength(1);
    });

    it("creates inject and diffuse render pipelines", () => {
      const { device, pipelines } = makeMockDevice();
      const pass = new VolumetricLightPass(device);
      pass.init(640, 640);

      const entryPoints = pipelines.map((p) => p.fragmentEntryPoint);
      expect(entryPoints).toContain("fs_inject");
      expect(entryPoints).toContain("fs_diffuse");
    });

    it("rounds up half-res dimensions for odd grid sizes", () => {
      const { device, textures } = makeMockDevice();
      const pass = new VolumetricLightPass(device);
      pass.init(641, 639);

      const fieldTextures = textures.filter(
        (t) => t.format === "rgba16float" && (t.usage & GPUTextureUsage.RENDER_ATTACHMENT) !== 0,
      );
      expect(fieldTextures[0].size).toEqual([321, 320]);
    });
  });

  describe("updateLights", () => {
    it("packs worker lights and renderer lights into the uniform buffer", () => {
      const { device } = makeMockDevice();
      const pass = new VolumetricLightPass(device);
      pass.init(640, 640);

      const workerLights = new Float32Array(MAX_WORLD_LIGHTS * LIGHT_STRUCT_FLOATS);
      workerLights[0] = 100;
      workerLights[1] = 200;
      workerLights[2] = 1.0;
      workerLights[5] = 0.9;
      workerLights[6] = 25;

      workerLights[8] = 300;
      workerLights[9] = 400;

      const rendererLights = [
        { x: 500, y: 600, color: [0.1, 0.9, 0.3] as [number, number, number], intensity: 1.5, radius: 25 },
      ];

      pass.updateLights(workerLights, 2, rendererLights, 0, 0);
    });

    it("handles zero lights gracefully", () => {
      const { device } = makeMockDevice();
      const pass = new VolumetricLightPass(device);
      pass.init(640, 640);

      const emptyLights = new Float32Array(MAX_WORLD_LIGHTS * LIGHT_STRUCT_FLOATS);
      pass.updateLights(emptyLights, 0, [], 0, 0);
    });
  });

  describe("updateUniforms", () => {
    it("uploads uniform data without throwing", () => {
      const { device } = makeMockDevice();
      const pass = new VolumetricLightPass(device);
      pass.init(640, 640);

      pass.updateLights(new Float32Array(MAX_WORLD_LIGHTS * LIGHT_STRUCT_FLOATS), 0, [], 0, 0);
      pass.updateUniforms(100, 200, 50);
    });
  });

  describe("compute (render-pass)", () => {
    it("dispatches 1 inject + N diffuse render passes (N = iterations)", () => {
      const mock = makeMockDevice();
      const pass = new VolumetricLightPass(mock.device, { iterations: 4 });
      pass.init(640, 640);

      pass.setGridView({} as unknown as GPUTextureView);
      pass.updateLights(new Float32Array(MAX_WORLD_LIGHTS * LIGHT_STRUCT_FLOATS), 0, [], 0, 0);
      pass.updateUniforms(0, 0, 0);

      const encoder = {
        beginRenderPass: () => mock.device.createCommandEncoder().beginRenderPass(),
      } as unknown as GPUCommandEncoder;

      pass.compute(encoder);

      // 1 inject + 4 diffuse = 5 render passes
      expect(mock.stats.renderPasses).toBe(5);
      // Each pass draws a fullscreen triangle (3 vertices)
      expect(mock.stats.draws).toBe(15);
    });

    it("is a no-op when grid view is not set", () => {
      const mock = makeMockDevice();
      const pass = new VolumetricLightPass(mock.device);
      pass.init(640, 640);

      pass.updateLights(new Float32Array(MAX_WORLD_LIGHTS * LIGHT_STRUCT_FLOATS), 0, [], 0, 0);
      pass.updateUniforms(0, 0, 0);

      const encoder = {
        beginRenderPass: () => mock.device.createCommandEncoder().beginRenderPass(),
      } as unknown as GPUCommandEncoder;

      pass.compute(encoder);
      expect(mock.stats.renderPasses).toBe(0);
    });

    it("is a no-op when disabled", () => {
      const mock = makeMockDevice();
      const pass = new VolumetricLightPass(mock.device);
      pass.init(640, 640);
      pass.disabled = true;

      pass.setGridView({} as unknown as GPUTextureView);
      pass.updateLights(new Float32Array(MAX_WORLD_LIGHTS * LIGHT_STRUCT_FLOATS), 0, [], 0, 0);
      pass.updateUniforms(0, 0, 0);

      const encoder = {
        beginRenderPass: () => mock.device.createCommandEncoder().beginRenderPass(),
      } as unknown as GPUCommandEncoder;

      pass.compute(encoder);
      expect(mock.stats.renderPasses).toBe(0);
    });

    it("output view alternates based on iteration parity", () => {
      const { device } = makeMockDevice();
      const encoder = {
        beginRenderPass: () => ({
          setPipeline: () => {},
          setBindGroup: () => {},
          draw: () => {},
          end: () => {},
        }),
      } as unknown as GPUCommandEncoder;

      const passEven = new VolumetricLightPass(device, { iterations: 4 });
      passEven.init(640, 640);
      passEven.setGridView({} as unknown as GPUTextureView);
      passEven.updateLights(new Float32Array(MAX_WORLD_LIGHTS * LIGHT_STRUCT_FLOATS), 0, []);
      passEven.updateUniforms(0, 0, 0);
      passEven.compute(encoder);
      const evenView = passEven.getVolumetricTextureView();

      const passOdd = new VolumetricLightPass(device, { iterations: 5 });
      passOdd.init(640, 640);
      passOdd.setGridView({} as unknown as GPUTextureView);
      passOdd.updateLights(new Float32Array(MAX_WORLD_LIGHTS * LIGHT_STRUCT_FLOATS), 0, []);
      passOdd.updateUniforms(0, 0, 0);
      passOdd.compute(encoder);
      const oddView = passOdd.getVolumetricTextureView();

      expect(evenView).not.toBeNull();
      expect(oddView).not.toBeNull();
    });
  });

  describe("config override", () => {
    it("accepts partial config overrides", () => {
      const { device } = makeMockDevice();
      const pass = new VolumetricLightPass(device, { iterations: 8, airPropagation: 0.18 });
      const config = pass.getConfig();
      expect(config.iterations).toBe(8);
      expect(config.airPropagation).toBe(0.18);
      expect(config.waterPropagation).toBe(DEFAULT_VOLUMETRIC_LIGHT_CONFIG.waterPropagation);
    });
  });

  describe("destroy", () => {
    it("cleans up without throwing", () => {
      const { device } = makeMockDevice();
      const pass = new VolumetricLightPass(device);
      pass.init(640, 640);
      pass.destroy();
    });
  });
});
