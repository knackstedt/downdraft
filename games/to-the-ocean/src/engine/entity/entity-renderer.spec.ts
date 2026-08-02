import { describe, expect, it, vi } from "bun:test";
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

// ─── GPU Global Polyfills ───────────────────────────────────────────────────
const GPU_SHADER_STAGE = { VERTEX: 0x1, FRAGMENT: 0x8, COMPUTE: 0x2 } as const;
const GPU_BUFFER_USAGE = { UNIFORM: 0x40, STORAGE: 0x80, COPY_DST: 0x8, COPY_SRC: 0x4, MAP_READ: 0x1, INDEX: 0x10, VERTEX: 0x20 } as const;
const GPU_TEXTURE_USAGE = { TEXTURE_BINDING: 0x8, COPY_DST: 0x4, COPY_SRC: 0x1, RENDER_ATTACHMENT: 0x10, STORAGE_BINDING: 0x100 } as const;

(globalThis as any).GPUShaderStage = GPU_SHADER_STAGE;
(globalThis as any).GPUBufferUsage = GPU_BUFFER_USAGE;
(globalThis as any).GPUTextureUsage = GPU_TEXTURE_USAGE;

// ─── Mock Backend Factory ───────────────────────────────────────────────────

function createMockBackend(): RenderBackend {
    const createBuffer = vi.fn((desc: BufferDescriptor) => ({
        size: desc.size,
        usage: desc.usage,
        getNative: () => ({}),
        destroy: vi.fn(),
    }) as unknown as BackendBuffer);

    const createTexture = vi.fn((desc: TextureDescriptor) => ({
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
        beginComputePass: vi.fn(() => ({
            setPipeline: vi.fn(),
            setBindGroup: vi.fn(),
            dispatchWorkgroups: vi.fn(),
            end: vi.fn(),
        })),
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
        getCurrentSurfaceTexture: vi.fn(() => null),
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

// ─── EntityRenderContext Tests ──────────────────────────────────────────────

describe("EntityRenderContext", () => {
    it("should accept device=null with backend set (backend-only path)", async () => {
        const { EntityRenderContext } = await import("./render-context.ts");
        const ctx: EntityRenderContext = {
            device: null,
            backend: createMockBackend(),
            format: "rgba8unorm",
            uniformBuffer: null,
            bindGroup: null,
            bindGroupLayout: null,
            viewProjCache: null,
            cameraPosCache: [0, 0, 0],
            lightingParamsCache: {
                sunDir: [0.5, 0.8, 0.3],
                sunIntensity: 1.0,
                ambient: 0.5,
                fogColor: [0, 0.1, 0.2],
                wetness: 0,
            },
            lightBindGroup: null,
            pbrBindGroup: null,
            reusableUniforms: new Float32Array(64),
            reusableHbUniforms: new Float32Array(64),
            viewportWidth: 1,
            viewportHeight: 1,
            drawEntityTypes: [],
            drawEntityBoatSlots: [],
            drawEntityScales: [],
            drawEntityPortSizes: [],
            drawEntityChunkX: [],
            drawEntityChunkZ: [],
            drawEntityBiome: [],
            drawEntityIslandSize: [],
            drawEntityPosX: [],
            drawEntityPosY: [],
            drawEntityPosZ: [],
            drawEntityCount: 0,
        };
        expect(ctx.device).toBeNull();
        expect(ctx.backend).not.toBeNull();
        expect(ctx.format).toBe("rgba8unorm");
    });

    it("should accept device set with backend=null (WebGPU-only path)", async () => {
        const { EntityRenderContext } = await import("./render-context.ts");
        const mockDevice = { queue: { writeBuffer: vi.fn() } } as unknown as GPUDevice;
        const ctx: EntityRenderContext = {
            device: mockDevice,
            backend: null,
            format: "bgra8unorm",
            uniformBuffer: null,
            bindGroup: null,
            bindGroupLayout: null,
            viewProjCache: null,
            cameraPosCache: [0, 0, 0],
            lightingParamsCache: {
                sunDir: [0.5, 0.8, 0.3],
                sunIntensity: 1.0,
                ambient: 0.5,
                fogColor: [0, 0.1, 0.2],
                wetness: 0,
            },
            lightBindGroup: null,
            pbrBindGroup: null,
            reusableUniforms: new Float32Array(64),
            reusableHbUniforms: new Float32Array(64),
            viewportWidth: 1,
            viewportHeight: 1,
            drawEntityTypes: [],
            drawEntityBoatSlots: [],
            drawEntityScales: [],
            drawEntityPortSizes: [],
            drawEntityChunkX: [],
            drawEntityChunkZ: [],
            drawEntityBiome: [],
            drawEntityIslandSize: [],
            drawEntityPosX: [],
            drawEntityPosY: [],
            drawEntityPosZ: [],
            drawEntityCount: 0,
        };
        expect(ctx.device).not.toBeNull();
        expect(ctx.backend).toBeNull();
        expect(ctx.format).toBe("bgra8unorm");
    });

    it("should accept union types for uniformBuffer and bindGroup", async () => {
        const { EntityRenderContext } = await import("./render-context.ts");
        const backend = createMockBackend();
        const buf = backend.createBuffer({ size: 256, usage: 0x40 | 0x08 });
        const bg = backend.createBindGroup({
            layout: backend.createBindGroupLayout({ entries: [] }),
            entries: [],
        });
        const ctx: EntityRenderContext = {
            device: null,
            backend,
            format: "rgba8unorm",
            uniformBuffer: buf,
            bindGroup: bg,
            bindGroupLayout: null,
            viewProjCache: null,
            cameraPosCache: [0, 0, 0],
            lightingParamsCache: {
                sunDir: [0.5, 0.8, 0.3],
                sunIntensity: 1.0,
                ambient: 0.5,
                fogColor: [0, 0.1, 0.2],
                wetness: 0,
            },
            lightBindGroup: null,
            pbrBindGroup: null,
            reusableUniforms: new Float32Array(64),
            reusableHbUniforms: new Float32Array(64),
            viewportWidth: 1,
            viewportHeight: 1,
            drawEntityTypes: [],
            drawEntityBoatSlots: [],
            drawEntityScales: [],
            drawEntityPortSizes: [],
            drawEntityChunkX: [],
            drawEntityChunkZ: [],
            drawEntityBiome: [],
            drawEntityIslandSize: [],
            drawEntityPosX: [],
            drawEntityPosY: [],
            drawEntityPosZ: [],
            drawEntityCount: 0,
        };
        expect(ctx.uniformBuffer).not.toBeNull();
        expect(ctx.bindGroup).not.toBeNull();
    });
});

// ─── EntityRenderer Backend-Agnostic Tests ──────────────────────────────────

describe("EntityRenderer backend-agnostic", () => {
    it("should construct with device=null and backend set", async () => {
        const { EntityRenderer } = await import("../EntityRenderer.ts");
        const backend = createMockBackend();
        const renderer = new EntityRenderer(null, "rgba8unorm", backend);
        expect(renderer).toBeDefined();
    });

    it("should construct with device set and backend=null", async () => {
        const { EntityRenderer } = await import("../EntityRenderer.ts");
        const mockDevice = {
            createShaderModule: vi.fn(() => ({})),
            createSampler: vi.fn(() => ({})),
            createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
            createTexture: vi.fn(() => ({ createView: vi.fn(() => ({})), destroy: vi.fn() })),
            createBindGroup: vi.fn(() => ({})),
            createBindGroupLayout: vi.fn(() => ({})),
            createPipelineLayout: vi.fn(() => ({})),
            createRenderPipeline: vi.fn(() => ({ getBindGroupLayout: vi.fn(() => ({}) ) })),
            createCommandEncoder: vi.fn(() => ({
                beginRenderPass: vi.fn(() => ({
                    setPipeline: vi.fn(), setBindGroup: vi.fn(), setVertexBuffer: vi.fn(),
                    setIndexBuffer: vi.fn(), drawIndexed: vi.fn(), draw: vi.fn(), end: vi.fn(),
                })),
                beginComputePass: vi.fn(() => ({
                    setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn(),
                })),
                finish: vi.fn(() => ({})),
            })),
            queue: {
                writeBuffer: vi.fn(),
                submit: vi.fn(),
                writeTexture: vi.fn(),
                copyExternalImageToTexture: vi.fn(),
                onSubmittedWorkDone: vi.fn(() => Promise.resolve()),
            },
            features: new Set<string>(),
            lost: Promise.resolve({ reason: "unknown", message: "" }),
        } as unknown as GPUDevice;
        const renderer = new EntityRenderer(mockDevice, "bgra8unorm", null);
        expect(renderer).toBeDefined();
    });

    it("should call initBackend when device is null", async () => {
        const { EntityRenderer } = await import("../EntityRenderer.ts");
        const backend = createMockBackend();
        const renderer = new EntityRenderer(null, "rgba8unorm", backend);
        await renderer.init();
        // Verify backend.createBuffer was called (initBackend creates uniform buffer)
        expect(backend.createBuffer).toHaveBeenCalled();
        // Verify backend.createBindGroupLayout was called
        expect(backend.createBindGroupLayout).toHaveBeenCalled();
        // Verify backend.createShaderModule was called
        expect(backend.createShaderModule).toHaveBeenCalled();
        // Verify backend.createRenderPipeline was called
        expect(backend.createRenderPipeline).toHaveBeenCalled();
    });

    it("should use backend.queue.writeBuffer for uniform updates in backend mode", async () => {
        const { EntityRenderer } = await import("../EntityRenderer.ts");
        const backend = createMockBackend();
        const renderer = new EntityRenderer(null, "rgba8unorm", backend);
        await renderer.init();

        // beginFrame + writeEntityUniforms should use backend queue
        renderer.beginFrame(
            { position: [0, 10, 0], target: [0, 0, 0], up: [0, 1, 0], fov: 60, aspect: 1, near: 0.1, far: 1000 },
            800, 600,
            { sunDir: [0.5, 0.8, 0.3], sunIntensity: 1.0, ambient: 0.5, fogColor: [0, 0.1, 0.2], wetness: 0 },
        );

        renderer.writeEntityUniforms(
            0,
            1, // EntityType.Player
            { x: 10, y: 5, z: 20 },
            1.0,
            { x: 0, y: 0, z: 0, w: 1 },
        );

        // backend.queue.writeBuffer should have been called
        expect(backend.queue.writeBuffer).toHaveBeenCalled();
    });

    it("should accept BackendRenderPassEncoder in render methods", async () => {
        const { EntityRenderer } = await import("../EntityRenderer.ts");
        const backend = createMockBackend();
        const renderer = new EntityRenderer(null, "rgba8unorm", backend);
        await renderer.init();

        const mockPassEncoder = {
            setPipeline: vi.fn(),
            setBindGroup: vi.fn(),
            setVertexBuffer: vi.fn(),
            setIndexBuffer: vi.fn(),
            draw: vi.fn(),
            drawIndexed: vi.fn(),
            end: vi.fn(),
            setViewport: vi.fn(),
            setScissorRect: vi.fn(),
        } as unknown as GPURenderPassEncoder;

        // These should not throw even with a mock pass encoder
        renderer.renderInstanced(mockPassEncoder);
        renderer.render(mockPassEncoder, 0);
        renderer.renderAnchors(mockPassEncoder, {
            getEntityCount: () => 0,
            getEntitySlot: () => null,
        } as any);
        renderer.renderHitboxes(mockPassEncoder);

        // If we got here without throwing, the test passes
        expect(true).toBe(true);
    });

    it("should set light and PBR bind groups with union types", async () => {
        const { EntityRenderer } = await import("../EntityRenderer.ts");
        const backend = createMockBackend();
        const renderer = new EntityRenderer(null, "rgba8unorm", backend);
        await renderer.init();

        const mockBindGroup = backend.createBindGroup({
            layout: backend.createBindGroupLayout({ entries: [] }),
            entries: [],
        });

        // Should accept BackendBindGroup
        renderer.setLightBindGroup(mockBindGroup);
        renderer.setPBRBindGroup(mockBindGroup);

        // If we got here without throwing, the test passes
        expect(true).toBe(true);
    });

    it("should create backend resources with numeric usage flags in initBackend", async () => {
        const { EntityRenderer } = await import("../EntityRenderer.ts");
        const backend = createMockBackend();
        const renderer = new EntityRenderer(null, "rgba8unorm", backend);
        await renderer.init();

        // Check that createBuffer was called with numeric usage flags (not GPUBufferUsage enums)
        const calls = (backend.createBuffer as any).mock.calls;
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) {
            const desc = call[0] as BufferDescriptor;
            expect(typeof desc.usage).toBe("number");
        }
    });

    it("should create shader module with ShaderSource object in backend mode", async () => {
        const { EntityRenderer } = await import("../EntityRenderer.ts");
        const backend = createMockBackend();
        const renderer = new EntityRenderer(null, "rgba8unorm", backend);
        await renderer.init();

        // createShaderModule should have been called with a ShaderSource-like object
        expect(backend.createShaderModule).toHaveBeenCalled();
        const call = (backend.createShaderModule as any).mock.calls[0];
        expect(call[0]).toHaveProperty("wgsl");
    });
});
