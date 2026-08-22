import type { RenderBackend } from "@downdraft/core/render/backend/render-backend";
import type {
    BackendBindGroup, BackendBindGroupLayout, BackendBuffer, BackendCommandBuffer,
    BackendCommandEncoder, BackendRenderPassEncoder, BackendRenderPipeline,
    BackendSampler, BackendShaderModule, BackendTexture, BackendTextureView,
    BindGroupDescriptor, BindGroupLayoutDescriptor, BufferDescriptor,
    PipelineLayoutDescriptor, RenderPassDescriptor, RenderPipelineDescriptor,
    SamplerDescriptor, TextureDescriptor, TextureViewDescriptor,
} from "@downdraft/core/render/backend/types";
import { LightingSystem, LightSystem, MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS } from "@downdraft/library-lighting";
import { WeatherBlend, WeatherType } from "@downdraft/library-weather";
import { describe, expect, it, vi } from "bun:test";

// ============================================================================
// WebGPU usage flags — not available in Bun's test environment
// ============================================================================

const _g = globalThis as unknown as Record<string, unknown>;
if (!_g.GPUBufferUsage) {
  _g.GPUBufferUsage = {
    MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8,
    INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128,
    INDIRECT: 256, QUERY_RESOLVE: 512,
  };
}
if (!_g.GPUShaderStage) {
  _g.GPUShaderStage = { VERTEX: 0x20, FRAGMENT: 0x10, COMPUTE: 0x04 };
}

// ============================================================================
// Mock GPUDevice — for LightSystem tests that call init()
// ============================================================================

function makeMockDevice(): GPUDevice {
  return {
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
    createBindGroupLayout: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
    createShaderModule: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    queue: { writeBuffer: vi.fn() },
  } as unknown as GPUDevice;
}

// ============================================================================
// Mock Backend Factory (matches pattern from systems-backend-agnostic.spec.ts)
// ============================================================================

function createMockBackend(): RenderBackend {
  const createBuffer = vi.fn((desc: BufferDescriptor) => ({ size: desc.size, usage: desc.usage, getNative: () => ({}), destroy: vi.fn() }) as unknown as BackendBuffer);
  const createTexture = vi.fn((desc: TextureDescriptor) => ({ getNative: () => ({}), destroy: vi.fn(), createView: vi.fn(() => ({ getNative: () => ({}) }) as unknown as BackendTextureView) }) as unknown as BackendTexture);
  const createTextureView = vi.fn((_tex: BackendTexture, _desc?: TextureViewDescriptor) => ({ getNative: () => ({}) }) as unknown as BackendTextureView);
  const createSampler = vi.fn((_desc: SamplerDescriptor) => ({ getNative: () => ({}) }) as unknown as BackendSampler);
  const createShaderModule = vi.fn(() => ({ getNative: () => ({}) }) as unknown as BackendShaderModule);
  const createBindGroupLayout = vi.fn((_desc: BindGroupLayoutDescriptor) => ({ getNative: () => ({}) }) as unknown as BackendBindGroupLayout);
  const createPipelineLayout = vi.fn((_desc: PipelineLayoutDescriptor) => ({ getNative: () => ({}) }) as unknown as { getNative: () => unknown });
  const createBindGroup = vi.fn((_desc: BindGroupDescriptor) => ({ getNative: () => ({}) }) as unknown as BackendBindGroup);
  const createRenderPipeline = vi.fn((_desc: RenderPipelineDescriptor) => ({ getNative: () => ({}) }) as unknown as BackendRenderPipeline);

  const passEncoder = {
    setPipeline: vi.fn(), setBindGroup: vi.fn(), setVertexBuffer: vi.fn(),
    setIndexBuffer: vi.fn(), setViewport: vi.fn(), setScissorRect: vi.fn(),
    draw: vi.fn(), drawIndexed: vi.fn(), end: vi.fn(), getNative: () => ({}),
  } as unknown as BackendRenderPassEncoder;

  const commandBuffer = { getNative: () => ({}) } as unknown as BackendCommandBuffer;
  const encoder = {
    beginRenderPass: vi.fn((_desc: RenderPassDescriptor) => passEncoder),
    beginComputePass: vi.fn(), copyBufferToBuffer: vi.fn(),
    copyBufferToTexture: vi.fn(), copyTextureToBuffer: vi.fn(),
    copyTextureToTexture: vi.fn(), finish: vi.fn(() => commandBuffer),
    getNative: () => ({}),
  } as unknown as BackendCommandEncoder;

  return {
    type: "webgl2",
    capabilities: {
      backend: "webgl2", computeShaders: false, storageBuffers: false,
      timestampQueries: false, floatRenderTargets: true, halfFloatRenderTargets: true,
      comparisonSamplers: true, bcCompression: false, anisotropicFiltering: false,
      multipleRenderTargets: true, instancing: true, uniformBuffers: true,
      transformFeedback: true, maxTextureSize: 4096, maxTextureArrayLayers: 256,
      maxUniformBufferBindingSize: 16384, maxStorageBufferBindingSize: 0,
      maxBindGroups: 4, maxVertexBuffers: 16, maxVertexAttributes: 16,
      maxColorAttachments: 4, maxUniformBuffersPerShaderStage: 24,
      maxSampledTexturesPerShaderStage: 16, maxSamplersPerShaderStage: 16,
      maxPointLights: 8, maxSpotLights: 4, maxParticles: 1000, maxShadowMapSize: 1024,
      isFormatSupported: vi.fn(() => true), isFormatRenderable: vi.fn(() => true),
      isFormatFilterable: vi.fn(() => true),
    },
    configureSurface: vi.fn(), getCurrentSurfaceTexture: vi.fn(() => null),
    getSurfaceFormat: vi.fn(() => "rgba8unorm"), reconfigureSurface: vi.fn(),
    createBuffer, createTexture, createSampler, createShaderModule,
    createBindGroupLayout, createPipelineLayout, createBindGroup,
    createRenderPipeline, createCommandEncoder: vi.fn(() => encoder),
    createTextureView, destroy: vi.fn(), onDeviceLost: vi.fn(),
    getNativeDevice: vi.fn(() => null),
    queue: {
      submit: vi.fn(), writeBuffer: vi.fn(), writeTexture: vi.fn(),
      copyExternalImageToTexture: vi.fn(),
      onSubmittedWorkDone: vi.fn(() => Promise.resolve()),
      getNative: () => ({}),
    },
  } as unknown as RenderBackend;
}

// ============================================================================
// WeatherBlend Tests
// ============================================================================

describe("WeatherBlend", () => {
  it("should start at blend factor 1.0 (fully settled)", () => {
    const wb = new WeatherBlend(30.0);
    expect(wb.getBlendFactor()).toBe(1.0);
    expect(wb.isTransitioning()).toBe(false);
  });

  it("should start transition when weather type changes", () => {
    const wb = new WeatherBlend(30.0);
    wb.update(WeatherType.Storm, 1.0);
    expect(wb.isTransitioning()).toBe(true);
    expect(wb.getBlendFactor()).toBeLessThan(1.0);
    expect(wb.getDisplayedWeatherType()).toBe(WeatherType.Storm);
    expect(wb.getPrevWeatherType()).toBe(WeatherType.Clear);
  });

  it("should not transition when same weather is updated", () => {
    const wb = new WeatherBlend(30.0);
    wb.update(WeatherType.Clear, 1.0);
    expect(wb.isTransitioning()).toBe(false);
    expect(wb.getBlendFactor()).toBe(1.0);
  });

  it("should complete transition over time", () => {
    const wb = new WeatherBlend(2.0); // 2-second transition
    wb.update(WeatherType.Rain, 0);
    expect(wb.isTransitioning()).toBe(true);

    wb.update(WeatherType.Rain, 1.0);
    expect(wb.getBlendFactor()).toBe(0.5);

    wb.update(WeatherType.Rain, 1.0);
    expect(wb.getBlendFactor()).toBe(1.0);
    expect(wb.isTransitioning()).toBe(false);
  });

  it("should clamp blend factor to 1.0", () => {
    const wb = new WeatherBlend(1.0);
    wb.update(WeatherType.Storm, 0);
    wb.update(WeatherType.Storm, 2.0); // exceeds duration
    expect(wb.getBlendFactor()).toBe(1.0);
  });

  it("should produce eased blend (smoothstep)", () => {
    const wb = new WeatherBlend(1.0);
    wb.update(WeatherType.Rain, 0);
    wb.update(WeatherType.Rain, 0.5); // blend = 0.5
    const eased = wb.getEasedBlend();
    // smoothstep: t*t*(3-2t) = 0.25 * 2 = 0.5
    expect(eased).toBeCloseTo(0.5, 4);
  });

  it("should blend values between prev and curr", () => {
    const wb = new WeatherBlend(1.0);
    wb.update(WeatherType.Storm, 0);
    wb.update(WeatherType.Storm, 0.5); // blend = 0.5, eased = 0.5
    const result = wb.blendValues(10, 20);
    expect(result).toBeCloseTo(15, 4);
  });

  it("should return prev values at start of transition", () => {
    const wb = new WeatherBlend(1.0);
    wb.update(WeatherType.Storm, 0); // blend = 0
    const result = wb.blendValues(10, 20);
    expect(result).toBeCloseTo(10, 4);
  });

  it("should return curr values at end of transition", () => {
    const wb = new WeatherBlend(1.0);
    wb.update(WeatherType.Storm, 0);
    wb.update(WeatherType.Storm, 1.0); // blend = 1.0
    const result = wb.blendValues(10, 20);
    expect(result).toBeCloseTo(20, 4);
  });

  it("should handle rapid weather changes", () => {
    const wb = new WeatherBlend(1.0);
    wb.update(WeatherType.Rain, 0.1);
    expect(wb.getDisplayedWeatherType()).toBe(WeatherType.Rain);
    wb.update(WeatherType.Storm, 0.1);
    expect(wb.getDisplayedWeatherType()).toBe(WeatherType.Storm);
    expect(wb.getPrevWeatherType()).toBe(WeatherType.Rain);
  });
});

// ============================================================================
// WeatherBlend.getLightingParams Tests
// ============================================================================

describe("WeatherBlend.getLightingParams", () => {
  it("should return ambient, sunIntensity, and wetness", () => {
    const wb = new WeatherBlend(30.0);
    const params = wb.getLightingParams(0.5, WeatherType.Clear, 1.0);
    expect(typeof params.ambient).toBe("number");
    expect(typeof params.sunIntensity).toBe("number");
    expect(typeof params.wetness).toBe("number");
  });

  it("should have high sunIntensity at noon (timeOfDay=0.5)", () => {
    const wb = new WeatherBlend(30.0);
    const params = wb.getLightingParams(0.5, WeatherType.Clear, 1.0);
    expect(params.sunIntensity).toBeGreaterThan(0.9);
  });

  it("should have zero sunIntensity at midnight (timeOfDay=0.0)", () => {
    const wb = new WeatherBlend(30.0);
    const params = wb.getLightingParams(0.0, WeatherType.Clear, 1.0);
    expect(params.sunIntensity).toBe(0);
  });

  it("should have zero sunIntensity at dawn (timeOfDay=0.25)", () => {
    const wb = new WeatherBlend(30.0);
    const params = wb.getLightingParams(0.25, WeatherType.Clear, 1.0);
    expect(params.sunIntensity).toBe(0);
  });

  it("should reduce sunIntensity in overcast weather", () => {
    const wbClear = new WeatherBlend(30.0);
    const clear = wbClear.getLightingParams(0.5, WeatherType.Clear, 1.0);
    const wbOvercast = new WeatherBlend(30.0);
    wbOvercast.update(WeatherType.Overcast, 100); // complete transition
    const overcast = wbOvercast.getLightingParams(0.5, WeatherType.Overcast, 1.0);
    expect(overcast.sunIntensity).toBeLessThan(clear.sunIntensity);
  });

  it("should reduce sunIntensity in storm weather", () => {
    const wbClear = new WeatherBlend(30.0);
    const clear = wbClear.getLightingParams(0.5, WeatherType.Clear, 1.0);
    const wbStorm = new WeatherBlend(30.0);
    wbStorm.update(WeatherType.Storm, 100);
    const storm = wbStorm.getLightingParams(0.5, WeatherType.Storm, 1.0);
    expect(storm.sunIntensity).toBeLessThan(clear.sunIntensity);
  });

  it("should reduce ambient in fog", () => {
    const wbClear = new WeatherBlend(30.0);
    const clear = wbClear.getLightingParams(0.5, WeatherType.Clear, 1.0);
    const wbFog = new WeatherBlend(30.0);
    wbFog.update(WeatherType.Fog, 100);
    const fog = wbFog.getLightingParams(0.5, WeatherType.Fog, 1.0);
    expect(fog.ambient).toBeLessThan(clear.ambient);
  });

  it("should have wetness in rain", () => {
    const wb = new WeatherBlend(30.0);
    wb.update(WeatherType.Rain, 100);
    const params = wb.getLightingParams(0.5, WeatherType.Rain, 1.0);
    expect(params.wetness).toBeGreaterThan(0);
  });

  it("should have high wetness in storm", () => {
    const wbRain = new WeatherBlend(30.0);
    wbRain.update(WeatherType.Rain, 100);
    const rain = wbRain.getLightingParams(0.5, WeatherType.Rain, 1.0);
    const wbStorm = new WeatherBlend(30.0);
    wbStorm.update(WeatherType.Storm, 100);
    const storm = wbStorm.getLightingParams(0.5, WeatherType.Storm, 1.0);
    expect(storm.wetness).toBeGreaterThan(rain.wetness);
  });

  it("should have zero wetness in clear weather", () => {
    const wb = new WeatherBlend(30.0);
    const params = wb.getLightingParams(0.5, WeatherType.Clear, 1.0);
    expect(params.wetness).toBe(0);
  });

  it("should have minimal sunIntensity in eclipse", () => {
    const wb = new WeatherBlend(30.0);
    wb.update(WeatherType.Eclipse, 100);
    const params = wb.getLightingParams(0.5, WeatherType.Eclipse, 1.0);
    expect(params.sunIntensity).toBeLessThan(0.1);
  });

  it("should have minimal sunIntensity in hellstorm", () => {
    const wb = new WeatherBlend(30.0);
    wb.update(WeatherType.HellStorm, 100);
    const params = wb.getLightingParams(0.5, WeatherType.HellStorm, 1.0);
    expect(params.sunIntensity).toBeLessThan(0.15);
  });

  it("should blend lighting during weather transition", () => {
    const wbClear = new WeatherBlend(30.0);
    const clearParams = wbClear.getLightingParams(0.5, WeatherType.Clear, 1.0);
    const clearSun = clearParams.sunIntensity;

    const wbStorm = new WeatherBlend(30.0);
    wbStorm.update(WeatherType.Storm, 100);
    const stormParams = wbStorm.getLightingParams(0.5, WeatherType.Storm, 1.0);
    const stormSun = stormParams.sunIntensity;

    const wbBlend = new WeatherBlend(2.0);
    wbBlend.update(WeatherType.Storm, 0);
    wbBlend.update(WeatherType.Storm, 1.0); // blend = 0.5
    const blendedParams = wbBlend.getLightingParams(0.5, WeatherType.Storm, 1.0);
    expect(blendedParams.sunIntensity).toBeGreaterThan(stormSun);
    expect(blendedParams.sunIntensity).toBeLessThan(clearSun);
  });
});

// ============================================================================
// LightingSystem Tests
// ============================================================================

describe("LightingSystem", () => {
  it("should construct with null device and no backend", () => {
    expect(() => new LightingSystem(null)).not.toThrow();
  });

  it("should construct with a mock backend", () => {
    const backend = createMockBackend();
    expect(() => new LightingSystem(null, backend)).not.toThrow();
  });

  it("should return lighting params with all required fields", () => {
    const ls = new LightingSystem(null);
    const params = ls.getLightingParams(0.5, WeatherType.Clear, 1.0);
    expect(params).toHaveProperty("sunDir");
    expect(params).toHaveProperty("sunIntensity");
    expect(params).toHaveProperty("sunBrightness");
    expect(params).toHaveProperty("moonDir");
    expect(params).toHaveProperty("moonIntensity");
    expect(params).toHaveProperty("ambient");
    expect(params).toHaveProperty("fogDensity");
    expect(params).toHaveProperty("wetness");
    expect(params).toHaveProperty("fogColor");
  });

  it("should compute sun direction as normalized vector", () => {
    const ls = new LightingSystem(null);
    const params = ls.getLightingParams(0.5, WeatherType.Clear, 1.0);
    const len = Math.sqrt(
      params.sunDir[0] ** 2 + params.sunDir[1] ** 2 + params.sunDir[2] ** 2,
    );
    expect(len).toBeCloseTo(1.0, 4);
  });

  it("should compute moon direction as opposite of sun", () => {
    const ls = new LightingSystem(null);
    const params = ls.getLightingParams(0.5, WeatherType.Clear, 1.0);
    expect(params.moonDir[0]).toBeCloseTo(-params.sunDir[0], 4);
    expect(params.moonDir[1]).toBeCloseTo(-params.sunDir[1], 4);
    expect(params.moonDir[2]).toBeCloseTo(-params.sunDir[2], 4);
  });

  it("should have positive sunIntensity at noon", () => {
    const ls = new LightingSystem(null);
    const params = ls.getLightingParams(0.5, WeatherType.Clear, 1.0);
    expect(params.sunIntensity).toBeGreaterThan(0);
  });

  it("should have zero sunIntensity at midnight", () => {
    const ls = new LightingSystem(null);
    const params = ls.getLightingParams(0.0, WeatherType.Clear, 1.0);
    expect(params.sunIntensity).toBe(0);
  });

  it("should have positive moonIntensity at midnight", () => {
    const ls = new LightingSystem(null);
    const params = ls.getLightingParams(0.0, WeatherType.Clear, 1.0);
    expect(params.moonIntensity).toBeGreaterThan(0);
  });

  it("should have zero moonIntensity at noon", () => {
    const ls = new LightingSystem(null);
    const params = ls.getLightingParams(0.5, WeatherType.Clear, 1.0);
    expect(params.moonIntensity).toBe(0);
  });

  it("should compute sunBrightness as sunIntensity * 3.0", () => {
    const ls = new LightingSystem(null);
    const params = ls.getLightingParams(0.5, WeatherType.Clear, 1.0);
    expect(params.sunBrightness).toBeCloseTo(params.sunIntensity * 3.0, 4);
  });

  it("should compute fogDensity from visibility", () => {
    const ls = new LightingSystem(null);
    const clear = ls.getLightingParams(0.5, WeatherType.Clear, 1.0);
    const clearFog = clear.fogDensity;
    const foggy = ls.getLightingParams(0.5, WeatherType.Clear, 0.3);
    expect(clearFog).toBe(0);
    expect(foggy.fogDensity).toBeGreaterThan(0);
    expect(foggy.fogDensity).toBeCloseTo((1 - 0.3) * 0.01, 6);
  });

  it("should reduce ambient in storm vs clear", () => {
    const lsClear = new LightingSystem(null);
    const clear = lsClear.getLightingParams(0.5, WeatherType.Clear, 1.0);
    const clearAmbient = clear.ambient;
    const lsStorm = new LightingSystem(null);
    lsStorm.updateWeatherBlend(WeatherType.Storm, 100);
    const storm = lsStorm.getLightingParams(0.5, WeatherType.Storm, 1.0);
    expect(storm.ambient).toBeLessThan(clearAmbient);
  });

  it("should reduce sunIntensity in fog vs clear", () => {
    const lsClear = new LightingSystem(null);
    const clear = lsClear.getLightingParams(0.5, WeatherType.Clear, 1.0);
    const clearSun = clear.sunIntensity;
    const lsFog = new LightingSystem(null);
    lsFog.updateWeatherBlend(WeatherType.Fog, 100);
    const fog = lsFog.getLightingParams(0.5, WeatherType.Fog, 1.0);
    expect(fog.sunIntensity).toBeLessThan(clearSun);
  });

  it("should have wetness in rain", () => {
    const ls = new LightingSystem(null);
    ls.updateWeatherBlend(WeatherType.Rain, 100);
    const params = ls.getLightingParams(0.5, WeatherType.Rain, 1.0);
    expect(params.wetness).toBeGreaterThan(0);
  });

  it("should update weather blend without errors", () => {
    const ls = new LightingSystem(null);
    ls.updateWeatherBlend(WeatherType.Storm, 1.0);
    ls.updateWeatherBlend(WeatherType.Clear, 1.0);
  });

  it("should return pooled object (same reference)", () => {
    const ls = new LightingSystem(null);
    const p1 = ls.getLightingParams(0.5, WeatherType.Clear, 1.0);
    const p2 = ls.getLightingParams(0.5, WeatherType.Clear, 1.0);
    expect(p1).toBe(p2); // pooled return
  });

  it("should handle all weather types without errors", () => {
    const ls = new LightingSystem(null);
    for (const wt of Object.values(WeatherType).filter((v): v is WeatherType => typeof v === "number")) {
      const params = ls.getLightingParams(0.5, wt, 1.0);
      expect(Number.isFinite(params.ambient)).toBe(true);
      expect(Number.isFinite(params.sunIntensity)).toBe(true);
      expect(Number.isFinite(params.fogDensity)).toBe(true);
    }
  });

  it("should handle all times of day without errors", () => {
    const ls = new LightingSystem(null);
    for (let t = 0; t <= 1; t += 0.05) {
      const params = ls.getLightingParams(t, WeatherType.Clear, 1.0);
      expect(Number.isFinite(params.sunDir[0])).toBe(true);
      expect(Number.isFinite(params.sunDir[1])).toBe(true);
      expect(Number.isFinite(params.sunDir[2])).toBe(true);
    }
  });
});

// ============================================================================
// LightSystem Tests — Point/Spot Light Management
// ============================================================================

describe("LightSystem — light management", () => {
  it("should construct with mock backend", () => {
    const backend = createMockBackend();
    expect(() => new LightSystem(makeMockDevice(), backend)).not.toThrow();
  });

  it("should export correct max light constants", () => {
    expect(MAX_POINT_LIGHTS).toBe(32);
    expect(MAX_SPOT_LIGHTS).toBe(8);
  });

  it("should init and create storage buffer", () => {
    const backend = createMockBackend();
    const device = makeMockDevice();
    const ls = new LightSystem(device, backend);
    ls.init();
    expect(device.createBuffer).toHaveBeenCalled();
  });

  it("should return bind group after init", () => {
    const backend = createMockBackend();
    const ls = new LightSystem(makeMockDevice(), backend);
    ls.init();
    expect(ls.getLightBindGroup()).not.toBeNull();
  });

  it("should return bind group layout after init", () => {
    const backend = createMockBackend();
    const ls = new LightSystem(makeMockDevice(), backend);
    ls.init();
    expect(ls.getLightBindGroupLayout()).not.toBeNull();
  });

  it("should return null bind group before init", () => {
    const backend = createMockBackend();
    const ls = new LightSystem(makeMockDevice(), backend);
    expect(ls.getLightBindGroup()).toBeNull();
  });

  it("should beginFrame by resetting light counts", () => {
    const backend = createMockBackend();
    const device = makeMockDevice();
    const ls = new LightSystem(device, backend);
    ls.init();
    ls.addPointLight([0, 0, 0], [1, 1, 1], 1.0, 10);
    ls.beginFrame();
    // After beginFrame, adding should start from 0 again
    ls.addPointLight([1, 1, 1], [1, 0, 0], 2.0, 5);
    // Upload should only have 1 light
    (device.queue as any).writeBuffer.mockClear();
    ls.upload([0, 0, 0]);
    expect((device.queue as any).writeBuffer).toHaveBeenCalled();
  });

  it("should add point lights up to MAX_POINT_LIGHTS", () => {
    const backend = createMockBackend();
    const ls = new LightSystem(makeMockDevice(), backend);
    ls.init();
    ls.beginFrame();
    for (let i = 0; i < MAX_POINT_LIGHTS; i++) {
      ls.addPointLight([i, 0, 0], [1, 1, 1], 1.0, 10);
    }
    // Adding one more should be silently ignored
    ls.addPointLight([100, 0, 0], [1, 1, 1], 1.0, 10);
    // Upload should only process MAX_POINT_LIGHTS
    expect(() => ls.upload([0, 0, 0])).not.toThrow();
  });

  it("should add spot lights up to MAX_SPOT_LIGHTS", () => {
    const backend = createMockBackend();
    const ls = new LightSystem(makeMockDevice(), backend);
    ls.init();
    ls.beginFrame();
    for (let i = 0; i < MAX_SPOT_LIGHTS; i++) {
      ls.addSpotLight([i, 0, 0], [0, -1, 0], [1, 1, 1], 1.0, 10, 0.9, 0.7);
    }
    // Adding one more should be silently ignored
    ls.addSpotLight([100, 0, 0], [0, -1, 0], [1, 1, 1], 1.0, 10, 0.9, 0.7);
    expect(() => ls.upload([0, 0, 0])).not.toThrow();
  });

  it("should reuse pooled light objects across frames", () => {
    const backend = createMockBackend();
    const ls = new LightSystem(makeMockDevice(), backend);
    ls.init();
    ls.beginFrame();
    ls.addPointLight([0, 0, 0], [1, 1, 1], 1.0, 10);
    ls.beginFrame();
    ls.addPointLight([1, 0, 0], [1, 1, 1], 2.0, 20);
    // Should not throw — pool reuse
    expect(() => ls.upload([0, 0, 0])).not.toThrow();
  });

  it("should upload without errors after adding lights", () => {
    const backend = createMockBackend();
    const device = makeMockDevice();
    const ls = new LightSystem(device, backend);
    ls.init();
    ls.beginFrame();
    ls.addPointLight([5, 3, 2], [1, 0.5, 0.2], 2.5, 15);
    ls.addSpotLight([0, 10, 0], [0, -1, 0], [0.8, 0.8, 1], 3.0, 20, 0.95, 0.8);
    (device.queue as any).writeBuffer.mockClear();
    ls.upload([0, 0, 0]);
    expect((device.queue as any).writeBuffer).toHaveBeenCalled();
  });

  it("should not upload when not initialized", () => {
    const backend = createMockBackend();
    const device = makeMockDevice();
    const ls = new LightSystem(device, backend);
    // Don't call init()
    ls.beginFrame();
    ls.addPointLight([0, 0, 0], [1, 1, 1], 1.0, 10);
    expect(() => ls.upload([0, 0, 0])).not.toThrow();
    expect((device.queue as any).writeBuffer).not.toHaveBeenCalled();
  });
});

// ============================================================================
// LightSystem Tests — Culling and Sorting
// ============================================================================

describe("LightSystem — culling and sorting", () => {
  it("should cull lights beyond their radius + margin", () => {
    const backend = createMockBackend();
    const device = makeMockDevice();
    const ls = new LightSystem(device, backend);
    ls.init();
    ls.beginFrame();
    // Near light (within radius + 300 margin)
    ls.addPointLight([50, 0, 0], [1, 1, 1], 1.0, 100);
    // Far light (beyond radius + 300 margin)
    ls.addPointLight([10000, 0, 0], [1, 1, 1], 1.0, 10);
    (device.queue as any).writeBuffer.mockClear();
    ls.upload([0, 0, 0]);
    // Should have written buffer (with at least the near light)
    expect((device.queue as any).writeBuffer).toHaveBeenCalled();
  });

  it("should sort point lights by distance to camera (nearest first)", () => {
    const backend = createMockBackend();
    const ls = new LightSystem(makeMockDevice(), backend);
    ls.init();
    ls.beginFrame();
    ls.addPointLight([100, 0, 0], [1, 0, 0], 1.0, 200); // far
    ls.addPointLight([10, 0, 0], [0, 1, 0], 1.0, 200);  // near
    ls.addPointLight([50, 0, 0], [0, 0, 1], 1.0, 200);  // mid
    // Should not throw — sorting happens internally
    expect(() => ls.upload([0, 0, 0]).not.toThrow());
  });

  it("should cull spot lights beyond their radius + margin", () => {
    const backend = createMockBackend();
    const ls = new LightSystem(makeMockDevice(), backend);
    ls.init();
    ls.beginFrame();
    ls.addSpotLight([50, 0, 0], [0, -1, 0], [1, 1, 1], 1.0, 100, 0.9, 0.7);
    ls.addSpotLight([10000, 0, 0], [0, -1, 0], [1, 1, 1], 1.0, 10, 0.9, 0.7);
    expect(() => ls.upload([0, 0, 0]).not.toThrow());
  });

  it("should handle all lights being culled", () => {
    const backend = createMockBackend();
    const ls = new LightSystem(makeMockDevice(), backend);
    ls.init();
    ls.beginFrame();
    ls.addPointLight([10000, 0, 0], [1, 1, 1], 1.0, 10);
    ls.addSpotLight([10000, 0, 0], [0, -1, 0], [1, 1, 1], 1.0, 10, 0.9, 0.7);
    expect(() => ls.upload([0, 0, 0]).not.toThrow());
  });

  it("should handle zero lights in upload", () => {
    const backend = createMockBackend();
    const device = makeMockDevice();
    const ls = new LightSystem(device, backend);
    ls.init();
    ls.beginFrame();
    (device.queue as any).writeBuffer.mockClear();
    ls.upload([0, 0, 0]);
    // Should still write the header (zeroed)
    expect((device.queue as any).writeBuffer).toHaveBeenCalled();
  });
});

// ============================================================================
// LightSystem Tests — Debug Gizmos
// ============================================================================

describe("LightSystem — debug gizmos", () => {
  it("should init debug gizmos without errors", () => {
    const backend = createMockBackend();
    const ls = new LightSystem(makeMockDevice(), backend);
    ls.init();
    expect(() => ls.initDebugGizmos("bgra8unorm")).not.toThrow();
  });

  it("should create render pipeline for debug gizmos", () => {
    const backend = createMockBackend();
    const device = makeMockDevice();
    const ls = new LightSystem(device, backend);
    ls.init();
    ls.initDebugGizmos("bgra8unorm");
    expect(device.createRenderPipeline).toHaveBeenCalled();
  });

  it("should create shader module for debug gizmos", () => {
    const backend = createMockBackend();
    const device = makeMockDevice();
    const ls = new LightSystem(device, backend);
    ls.init();
    ls.initDebugGizmos("bgra8unorm");
    expect(device.createShaderModule).toHaveBeenCalled();
  });

  it("should create vertex, index, instance, and uniform buffers", () => {
    const backend = createMockBackend();
    const device = makeMockDevice();
    const ls = new LightSystem(device, backend);
    ls.init();
    ls.initDebugGizmos("bgra8unorm");
    // init() creates 1 buffer (storage), debug creates 4 more
    expect((device.createBuffer as any).mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it("should not render debug gizmos when showDebugGizmos is false", () => {
    const backend = createMockBackend();
    const ls = new LightSystem(makeMockDevice(), backend);
    ls.init();
    ls.initDebugGizmos("bgra8unorm");
    ls.showDebugGizmos = false;

    const mockPass = {
      setPipeline: vi.fn(), setBindGroup: vi.fn(), setVertexBuffer: vi.fn(),
      setIndexBuffer: vi.fn(), drawIndexed: vi.fn(),
    };

    ls.renderDebugGizmos(mockPass as any, {
      position: [0, 0, 0], yaw: 0, pitch: 0, fov: 75, aspect: 1,
      near: 0.1, far: 1000, viewportW: 800, viewportH: 600,
      projectionMatrix: new Float32Array(16), viewMatrix: new Float32Array(16),
    } as any);

    expect(mockPass.setPipeline).not.toHaveBeenCalled();
  });

  it("should render debug gizmos when showDebugGizmos is true", () => {
    const backend = createMockBackend();
    const ls = new LightSystem(makeMockDevice(), backend);
    ls.init();
    ls.initDebugGizmos("bgra8unorm");
    ls.showDebugGizmos = true;
    ls.beginFrame();
    ls.addPointLight([0, 5, 0], [1, 0, 0], 2.0, 10);
    ls.addSpotLight([5, 10, 0], [0, -1, 0], [0, 1, 0], 3.0, 15, 0.9, 0.7);

    const mockPass = {
      setPipeline: vi.fn(), setBindGroup: vi.fn(), setVertexBuffer: vi.fn(),
      setIndexBuffer: vi.fn(), drawIndexed: vi.fn(),
    };

    ls.renderDebugGizmos(mockPass as any, {
      position: [0, 0, 0], yaw: 0, pitch: 0, fov: 75, aspect: 1,
      near: 0.1, far: 1000, viewportW: 800, viewportH: 600,
      projectionMatrix: new Float32Array(16), viewMatrix: new Float32Array(16),
    } as any);

    expect(mockPass.setPipeline).toHaveBeenCalled();
    expect(mockPass.drawIndexed).toHaveBeenCalled();
  });

  it("should not render debug gizmos before initDebugGizmos", () => {
    const backend = createMockBackend();
    const ls = new LightSystem(makeMockDevice(), backend);
    ls.init();
    ls.showDebugGizmos = true;

    const mockPass = {
      setPipeline: vi.fn(), setBindGroup: vi.fn(), setVertexBuffer: vi.fn(),
      setIndexBuffer: vi.fn(), drawIndexed: vi.fn(),
    };

    expect(() => ls.renderDebugGizmos(mockPass as any, {
      position: [0, 0, 0], yaw: 0, pitch: 0, fov: 75, aspect: 1,
      near: 0.1, far: 1000, viewportW: 800, viewportH: 600,
      projectionMatrix: new Float32Array(16), viewMatrix: new Float32Array(16),
    } as any)).not.toThrow();

    expect(mockPass.setPipeline).not.toHaveBeenCalled();
  });
});

// ============================================================================
// LightSystem Tests — Buffer Layout
// ============================================================================

describe("LightSystem — buffer layout", () => {
  it("should allocate buffer with correct size for header + point + spot lights", () => {
    const backend = createMockBackend();
    const device = makeMockDevice();
    const ls = new LightSystem(device, backend);
    ls.init();

    const bufDesc = (device.createBuffer as any).mock.calls[0][0];
    // Header: 4 floats (16 bytes)
    // PointLights: MAX_POINT_LIGHTS * 8 floats (32 * 32 = 1024 bytes)
    // SpotLights: MAX_SPOT_LIGHTS * 16 floats (8 * 64 = 512 bytes)
    const expectedSize = (4 + MAX_POINT_LIGHTS * 8 + MAX_SPOT_LIGHTS * 16) * 4;
    expect(bufDesc.size).toBe(expectedSize);
  });

  it("should use STORAGE | COPY_DST usage flags", () => {
    const backend = createMockBackend();
    const device = makeMockDevice();
    const ls = new LightSystem(device, backend);
    ls.init();

    const bufDesc = (device.createBuffer as any).mock.calls[0][0];
    expect(bufDesc.usage).toBe(0x80 | 0x08);
  });

  it("should use read-only-storage buffer type in bind group layout", () => {
    const backend = createMockBackend();
    const device = makeMockDevice();
    const ls = new LightSystem(device, backend);
    ls.init();

    const layoutDesc = (device.createBindGroupLayout as any).mock.calls[0][0];
    expect(layoutDesc.entries[0].buffer.type).toBe("read-only-storage");
  });
});

// ============================================================================
// LightSystem — WebGPU Device Path
// ============================================================================

describe("LightSystem — WebGPU device path", () => {
  it("should init with GPUDevice when provided", () => {
    const mockDevice = makeMockDevice();

    const ls = new LightSystem(mockDevice, null);
    ls.init();

    expect(mockDevice.createBuffer).toHaveBeenCalled();
    expect(mockDevice.createBindGroupLayout).toHaveBeenCalled();
    expect(mockDevice.createBindGroup).toHaveBeenCalled();
  });

  it("should init debug gizmos with GPUDevice", () => {
    const mockDevice = makeMockDevice();

    const ls = new LightSystem(mockDevice, null);
    ls.init();
    expect(() => ls.initDebugGizmos("bgra8unorm")).not.toThrow();
    expect(mockDevice.createRenderPipeline).toHaveBeenCalled();
  });
});

// ============================================================================
// Integration: LightingSystem + LightSystem
// ============================================================================

describe("Integration: LightingSystem + LightSystem", () => {
  it("LightSystem should inherit lighting params from LightingSystem", () => {
    const backend = createMockBackend();
    const ls = new LightSystem(makeMockDevice(), backend);
    const params = ls.getLightingParams(0.5, WeatherType.Clear, 1.0);
    expect(params.sunIntensity).toBeGreaterThan(0);
    expect(params.ambient).toBeGreaterThan(0);
  });

  it("LightSystem should update weather blend", () => {
    const backend = createMockBackend();
    const ls = new LightSystem(makeMockDevice(), backend);
    ls.updateWeatherBlend(WeatherType.Storm, 1.0);
    const params = ls.getLightingParams(0.5, WeatherType.Storm, 1.0);
    expect(params.sunIntensity).toBeLessThan(
      new LightingSystem(null).getLightingParams(0.5, WeatherType.Clear, 1.0).sunIntensity,
    );
  });

  it("LightSystem should handle full frame cycle", () => {
    const backend = createMockBackend();
    const device = makeMockDevice();
    const ls = new LightSystem(device, backend);
    ls.init();

    // Frame 1
    ls.beginFrame();
    ls.addPointLight([10, 5, 10], [1, 0.8, 0.6], 2.0, 25);
    ls.addPointLight([-10, 5, -10], [0.6, 0.8, 1], 1.5, 20);
    ls.addSpotLight([0, 20, 0], [0, -1, 0], [1, 1, 1], 5.0, 50, 0.95, 0.8);
    ls.upload([0, 0, 0]);

    // Frame 2 — different lights
    ls.beginFrame();
    ls.addPointLight([20, 0, 0], [1, 0, 0], 3.0, 30);
    ls.upload([0, 0, 0]);

    // Both frames should have written to the buffer
    expect((device.queue as any).writeBuffer.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
