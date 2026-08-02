import type { RenderBackend } from "@downdraft/core/render/backend/render-backend";
import type {
    BackendBindGroup,
    BackendBindGroupLayout,
    BackendBuffer,
    BackendCommandBuffer,
    BackendCommandEncoder,
    BackendRenderPassEncoder,
    BackendRenderPipeline,
    BackendSampler,
    BackendShaderModule,
    BackendTexture,
    BackendTextureView,
    BindGroupDescriptor,
    BindGroupLayoutDescriptor,
    BufferDescriptor,
    PipelineLayoutDescriptor,
    RenderPassDescriptor,
    RenderPipelineDescriptor,
    SamplerDescriptor,
    TextureDescriptor,
    TextureViewDescriptor,
} from "@downdraft/core/render/backend/types";
import { WeatherType } from "@downdraft/plugin-weather";
import type { CloudExtractedMesh, CloudLayerConfig, CloudMeshProvider, CloudVoxelField } from "@downdraft/plugin-weatherfx";
import { CloudSystem } from "@downdraft/plugin-weatherfx";
import { describe, expect, it, vi } from "bun:test";

// ─── GPU Global Polyfills ───────────────────────────────────────────────────
const GPU_SHADER_STAGE = { VERTEX: 0x1, FRAGMENT: 0x8, COMPUTE: 0x2 } as const;
const GPU_BUFFER_USAGE = { UNIFORM: 0x40, STORAGE: 0x80, COPY_DST: 0x8, COPY_SRC: 0x4, MAP_READ: 0x1, INDEX: 0x10, VERTEX: 0x20 } as const;
const GPU_TEXTURE_USAGE = { TEXTURE_BINDING: 0x8, COPY_DST: 0x4, COPY_SRC: 0x1, RENDER_ATTACHMENT: 0x10, STORAGE_BINDING: 0x100 } as const;

(globalThis as any).GPUShaderStage = GPU_SHADER_STAGE;
(globalThis as any).GPUBufferUsage = GPU_BUFFER_USAGE;
(globalThis as any).GPUTextureUsage = GPU_TEXTURE_USAGE;

// ─── Mock CloudMeshProvider ─────────────────────────────────────────────────

function createMockProvider(): CloudMeshProvider {
    return {
        getLayerTypes: vi.fn(() => ["cumulus", "stratus"]),
        getLayerConfig: vi.fn((type: string): CloudLayerConfig => ({
            altitude: type === "cumulus" ? 500 : 800,
            density: 0.5,
            isoLevel: 0.5,
            regenDistance: 200,
        })),
        generateLayerField: vi.fn((): CloudVoxelField => ({
            data: new Float32Array(8 * 8 * 8),
            originX: 0,
            originY: 0,
            originZ: 0,
            voxelSize: 20,
            dimX: 8,
            dimY: 8,
            dimZ: 8,
            isoLevel: 0.5,
        })),
        extractMesh: vi.fn((): CloudExtractedMesh => ({
            verts: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1]),
            indices: new Uint16Array([0, 1, 2, 3, 4, 5]),
            useUint32: false,
        })),
        getRegenDistance: vi.fn(() => 200),
        getMaxLayerGenPerFrame: vi.fn(() => 1),
        getLayerGenTimeBudgetMs: vi.fn(() => 5),
    } as unknown as CloudMeshProvider;
}

// ─── Mock Backend Factory ───────────────────────────────────────────────────

function createMockBackend(): RenderBackend {
    const createBuffer = vi.fn((desc: BufferDescriptor) => ({
        size: desc.size,
        usage: desc.usage,
        getNative: () => ({}),
        destroy: vi.fn(),
    }) as unknown as BackendBuffer);

    const createTexture = vi.fn((desc: TextureDescriptor) => ({
        width: desc.size[0] ?? 1,
        height: desc.size[1] ?? 1,
        depthOrArrayLayers: 1,
        getNative: () => ({}),
        destroy: vi.fn(),
        createView: vi.fn(() => ({ getNative: () => ({}) }) as unknown as BackendTextureView),
    }) as unknown as BackendTexture);

    const createTextureView = vi.fn((_tex: BackendTexture, _desc?: TextureViewDescriptor) => ({
        getNative: () => ({}),
    }) as unknown as BackendTextureView);

    const createSampler = vi.fn((_desc: SamplerDescriptor) => ({
        getNative: () => ({}),
    }) as unknown as BackendSampler);

    const createShaderModule = vi.fn(() => ({
        getNative: () => ({}),
    }) as unknown as BackendShaderModule);

    const createBindGroupLayout = vi.fn((_desc: BindGroupLayoutDescriptor) => ({
        getNative: () => ({}),
    }) as unknown as BackendBindGroupLayout);

    const createPipelineLayout = vi.fn((_desc: PipelineLayoutDescriptor) => ({
        getNative: () => ({}),
    }) as unknown as { getNative: () => unknown });

    const createBindGroup = vi.fn((_desc: BindGroupDescriptor) => ({
        getNative: () => ({}),
    }) as unknown as BackendBindGroup);

    const createRenderPipeline = vi.fn((_desc: RenderPipelineDescriptor) => ({
        getNative: () => ({}),
    }) as unknown as BackendRenderPipeline);

    const passEncoder = {
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        setVertexBuffer: vi.fn(),
        setIndexBuffer: vi.fn(),
        setViewport: vi.fn(),
        setScissorRect: vi.fn(),
        draw: vi.fn(),
        drawIndexed: vi.fn(),
        end: vi.fn(),
        getNative: () => ({}),
    } as unknown as BackendRenderPassEncoder;

    const commandBuffer = { getNative: () => ({}) } as unknown as BackendCommandBuffer;
    const encoder = {
        beginRenderPass: vi.fn((_desc: RenderPassDescriptor) => passEncoder),
        beginComputePass: vi.fn(),
        copyBufferToBuffer: vi.fn(),
        copyBufferToTexture: vi.fn(),
        copyTextureToBuffer: vi.fn(),
        copyTextureToTexture: vi.fn(),
        finish: vi.fn(() => commandBuffer),
        getNative: () => ({}),
    } as unknown as BackendCommandEncoder;

    const createCommandEncoder = vi.fn(() => encoder);

    const queue = {
        submit: vi.fn(),
        writeBuffer: vi.fn(),
        writeTexture: vi.fn(),
        copyExternalImageToTexture: vi.fn(),
        onSubmittedWorkDone: vi.fn(() => Promise.resolve()),
        getNative: () => ({}),
    };

    return {
        type: "webgl2",
        capabilities: {
            backend: "webgl2",
            computeShaders: false,
            storageBuffers: false,
            timestampQueries: false,
            floatRenderTargets: true,
            halfFloatRenderTargets: true,
            comparisonSamplers: true,
            bcCompression: false,
            anisotropicFiltering: false,
            multipleRenderTargets: true,
            instancing: true,
            uniformBuffers: true,
            transformFeedback: true,
            maxTextureSize: 4096,
            maxTextureArrayLayers: 256,
            maxUniformBufferBindingSize: 16384,
            maxStorageBufferBindingSize: 0,
            maxBindGroups: 4,
            maxVertexBuffers: 16,
            maxVertexAttributes: 16,
            maxColorAttachments: 4,
            maxUniformBuffersPerShaderStage: 24,
            maxSampledTexturesPerShaderStage: 16,
            maxSamplersPerShaderStage: 16,
            maxPointLights: 8,
            maxSpotLights: 4,
            maxParticles: 1000,
            maxShadowMapSize: 1024,
            isFormatSupported: vi.fn(() => true),
            isFormatRenderable: vi.fn(() => true),
            isFormatFilterable: vi.fn(() => true),
        },
        configureSurface: vi.fn(),
        getCurrentSurfaceTexture: vi.fn(),
        getSurfaceFormat: vi.fn(() => "rgba8unorm"),
        reconfigureSurface: vi.fn(),
        createBuffer,
        createTexture,
        createSampler,
        createShaderModule,
        createBindGroupLayout,
        createPipelineLayout,
        createBindGroup,
        createRenderPipeline,
        createCommandEncoder,
        createTextureView,
        destroy: vi.fn(),
        onDeviceLost: vi.fn(),
        getNativeDevice: vi.fn(() => null),
        queue,
    } as unknown as RenderBackend;
}

// ─── CloudSystem Tests ──────────────────────────────────────────────────────

describe("CloudSystem backend-agnostic", () => {
    it("should construct with null device and backend", () => {
        const provider = createMockProvider();
        const cloud = new CloudSystem(null, "rgba8unorm", provider, createMockBackend());
        expect(cloud).toBeDefined();
    });

    it("should initBackend when device is null and backend is provided", async () => {
        const backend = createMockBackend();
        const provider = createMockProvider();
        const cloud = new CloudSystem(null, "rgba8unorm", provider, backend);
        await cloud.init();

        // Should create shader, uniform buffer, bind group layout, pipeline
        expect((backend.createShaderModule as any).mock.calls.length).toBe(1);
        expect((backend.createBuffer as any).mock.calls.length).toBeGreaterThanOrEqual(1);
        expect((backend.createBindGroupLayout as any).mock.calls.length).toBe(1);
        expect((backend.createRenderPipeline as any).mock.calls.length).toBe(1);
    });

    it("should create per-layer uniform buffers during init", async () => {
        const backend = createMockBackend();
        const provider = createMockProvider();
        const cloud = new CloudSystem(null, "rgba8unorm", provider, backend);
        await cloud.init();

        // 1 main uniform buffer + 2 per-layer uniforms (cumulus + stratus)
        expect((backend.createBuffer as any).mock.calls.length).toBe(3);
    });

    it("should update without errors on backend", () => {
        const backend = createMockBackend();
        const provider = createMockProvider();
        const cloud = new CloudSystem(null, "rgba8unorm", provider, backend);

        cloud.update(0.016, { x: 0, y: 0, z: 0 }, 1, 0, 5, WeatherType.Clear);
        expect(true).toBe(true);
    });

    it("should generate layer mesh using backend buffers", async () => {
        const backend = createMockBackend();
        const provider = createMockProvider();
        const cloud = new CloudSystem(null, "rgba8unorm", provider, backend);
        await cloud.init();

        // Trigger update to generate meshes
        cloud.update(0.016, { x: 0, y: 0, z: 0 }, 1, 0, 5, WeatherType.Clear);

        // 1 main uniform + 2 per-layer + 1 vertex + 1 index = 5 (only 1 layer generated per frame)
        expect((backend.createBuffer as any).mock.calls.length).toBe(5);

        // Queue writeBuffer should have been called for vertex/index data
        expect((backend.queue.writeBuffer as any).mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("should render using backend pipeline on backend path", async () => {
        const backend = createMockBackend();
        const provider = createMockProvider();
        const cloud = new CloudSystem(null, "rgba8unorm", provider, backend);
        await cloud.init();

        // Generate meshes
        cloud.update(0.016, { x: 0, y: 0, z: 0 }, 1, 0, 5, WeatherType.Clear);

        const mockPass = {
            setPipeline: vi.fn(),
            setBindGroup: vi.fn(),
            setVertexBuffer: vi.fn(),
            setIndexBuffer: vi.fn(),
            drawIndexed: vi.fn(),
        };

        const camera = {
            position: [0, 50, 0] as [number, number, number],
            target: [0, 50, -1] as [number, number, number],
            up: [0, 1, 0] as [number, number, number],
            fov: 60,
            near: 0.1,
            far: 4096,
            aspect: 1,
        };

        cloud.render(
            mockPass as any,
            camera as any,
            0.5,
            WeatherType.Clear,
            5, 1, 0, 10.0,
            { x: 0, y: 0, z: 0 },
            [0, 1, 0], 1.0,
            [0, -1, 0], 0.0,
            [0.5, 0.5, 0.5], 0.001,
        );

        expect(mockPass.setPipeline).toHaveBeenCalledTimes(1);
        // Should draw at least one layer
        expect(mockPass.drawIndexed).toHaveBeenCalled();
    });

    it("should not render if backend pipeline is not initialized", () => {
        const provider = createMockProvider();
        const cloud = new CloudSystem(null, "rgba8unorm", provider, createMockBackend());

        const mockPass = {
            setPipeline: vi.fn(),
            setBindGroup: vi.fn(),
            setVertexBuffer: vi.fn(),
            setIndexBuffer: vi.fn(),
            drawIndexed: vi.fn(),
        };

        cloud.render(
            mockPass as any,
            { position: [0, 0, 0], target: [0, 0, -1], up: [0, 1, 0], fov: 60, near: 0.1, far: 4096, aspect: 1 } as any,
            0.5, WeatherType.Clear, 5, 1, 0, 10.0,
            { x: 0, y: 0, z: 0 },
            [0, 1, 0], 1.0, [0, -1, 0], 0.0,
            [0.5, 0.5, 0.5], 0.001,
        );

        expect(mockPass.setPipeline).not.toHaveBeenCalled();
    });

    it("should create bind groups for layers using backend", async () => {
        const backend = createMockBackend();
        const provider = createMockProvider();
        const cloud = new CloudSystem(null, "rgba8unorm", provider, backend);
        await cloud.init();

        // Generate meshes
        cloud.update(0.016, { x: 0, y: 0, z: 0 }, 1, 0, 5, WeatherType.Clear);

        // Only 1 layer generated per frame (maxPerFrame=1) → 1 bind group
        expect((backend.createBindGroup as any).mock.calls.length).toBe(1);
    });
});
