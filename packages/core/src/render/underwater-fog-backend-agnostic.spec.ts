import { describe, expect, it, vi } from "bun:test";
import type { RenderBackend } from "./backend/render-backend.ts";
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
} from "./backend/types.ts";
import { UnderwaterFogPass } from "./passes/underwater-fog.ts";

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

// ─── UnderwaterFogPass Tests ────────────────────────────────────────────────

describe("UnderwaterFogPass backend-agnostic", () => {
    it("should construct with null device and backend", () => {
        const pass = new UnderwaterFogPass(null, "rgba8unorm", 1, createMockBackend());
        expect(pass).toBeDefined();
    });

    it("should prepareBackend when device is null and backend is provided", () => {
        const backend = createMockBackend();
        const pass = new UnderwaterFogPass(null, "rgba8unorm", 1, backend);
        pass.prepare(null as any, backend);

        expect((backend.createShaderModule as any).mock.calls.length).toBe(1);
        expect((backend.createBuffer as any).mock.calls.length).toBe(1);
        expect((backend.createBindGroupLayout as any).mock.calls.length).toBe(1);
        expect((backend.createRenderPipeline as any).mock.calls.length).toBe(1);
        expect((backend.createBindGroup as any).mock.calls.length).toBe(1);
    });

    it("should not re-prepare if already prepared", () => {
        const backend = createMockBackend();
        const pass = new UnderwaterFogPass(null, "rgba8unorm", 1, backend);
        pass.prepare(null as any, backend);
        pass.prepare(null as any, backend);

        expect((backend.createRenderPipeline as any).mock.calls.length).toBe(1);
    });

    it("setDepth should write uniform via backend queue", () => {
        const backend = createMockBackend();
        const pass = new UnderwaterFogPass(null, "rgba8unorm", 1, backend);
        pass.prepare(null as any, backend);

        pass.setDepth(5.0, 12.5);

        expect((backend.queue.writeBuffer as any).mock.calls.length).toBe(1);
        const call = (backend.queue.writeBuffer as any).mock.calls[0];
        expect(call[1]).toBe(0);
        const data = call[2] as Float32Array;
        expect(data[0]).toBe(5.0);
        expect(data[1]).toBe(12.5);
    });

    it("execute should use backend pipeline and bind group when on backend path", () => {
        const backend = createMockBackend();
        const pass = new UnderwaterFogPass(null, "rgba8unorm", 1, backend);
        pass.prepare(null as any, backend);

        const mockPass = {
            setPipeline: vi.fn(),
            setBindGroup: vi.fn(),
            draw: vi.fn(),
        };

        pass.execute({ backend, pass: mockPass as any, device: null } as any);

        expect(mockPass.setPipeline).toHaveBeenCalledTimes(1);
        expect(mockPass.setBindGroup).toHaveBeenCalledTimes(1);
        expect(mockPass.draw).toHaveBeenCalledWith(3);
    });

    it("execute should skip when backend pipeline is not prepared", () => {
        const pass = new UnderwaterFogPass(null, "rgba8unorm", 1, createMockBackend());

        const mockPass = {
            setPipeline: vi.fn(),
            setBindGroup: vi.fn(),
            draw: vi.fn(),
        };

        pass.execute({ backend: createMockBackend(), pass: mockPass as any, device: null } as any);

        expect(mockPass.setPipeline).not.toHaveBeenCalled();
        expect(mockPass.draw).not.toHaveBeenCalled();
    });

    it("should create uniform buffer with correct size and usage", () => {
        const backend = createMockBackend();
        const pass = new UnderwaterFogPass(null, "rgba8unorm", 1, backend);
        pass.prepare(null as any, backend);

        const bufCall = (backend.createBuffer as any).mock.calls[0][0];
        expect(bufCall.size).toBe(32);
        expect(bufCall.usage).toBe(0x40 | 0x08); // UNIFORM | COPY_DST
    });
});
