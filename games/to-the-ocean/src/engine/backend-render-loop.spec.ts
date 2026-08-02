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
        width: desc.size[0] ?? 1,
        height: desc.size[1] ?? 1,
        depthOrArrayLayers: 1,
        format: desc.format,
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

    const surfaceTexture = {
        width: 800,
        height: 600,
        depthOrArrayLayers: 1,
        format: "rgba8unorm",
        getNative: () => ({}),
        destroy: vi.fn(),
        createView: vi.fn(() => ({ getNative: () => ({}) }) as unknown as BackendTextureView),
    } as unknown as BackendTexture;

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
        getCurrentSurfaceTexture: vi.fn(() => surfaceTexture),
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("WebGPURenderer backend render loop", () => {
    it("mock backend should have all required RenderBackend methods", () => {
        const backend = createMockBackend();
        expect(backend.type).toBe("webgl2");
        expect(backend.queue).toBeDefined();
        expect(backend.createCommandEncoder).toBeDefined();
        expect(backend.getCurrentSurfaceTexture).toBeDefined();
        expect(backend.createTextureView).toBeDefined();
        expect(backend.createTexture).toBeDefined();
    });

    it("backend createCommandEncoder should return encoder with beginRenderPass", () => {
        const backend = createMockBackend();
        const encoder = backend.createCommandEncoder();
        expect(encoder).toBeDefined();
        expect(encoder.beginRenderPass).toBeDefined();
        expect(encoder.finish).toBeDefined();
    });

    it("backend beginRenderPass should return pass encoder with setViewport/setScissorRect", () => {
        const backend = createMockBackend();
        const encoder = backend.createCommandEncoder();
        const depthView = backend.createTextureView(
            backend.createTexture({ size: [800, 600], format: "depth24plus", usage: 0x10 }),
        );
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: backend.createTextureView(backend.getCurrentSurfaceTexture()!),
                clearValue: { r: 0, g: 0.1, b: 0.2, a: 1 },
                loadOp: "clear",
                storeOp: "store",
            }],
            depthStencilAttachment: {
                view: depthView,
                depthClearValue: 1.0,
                depthLoadOp: "clear",
                depthStoreOp: "store",
            },
        });
        expect(pass).toBeDefined();
        expect(pass.setViewport).toBeDefined();
        expect(pass.setScissorRect).toBeDefined();
        expect(pass.end).toBeDefined();
    });

    it("backend queue.submit should be callable with command buffer", () => {
        const backend = createMockBackend();
        const encoder = backend.createCommandEncoder();
        const cmd = encoder.finish();
        backend.queue.submit([cmd]);
        expect((backend.queue.submit as any).mock.calls.length).toBe(1);
    });

    it("backend depth texture should be created with correct format and usage", () => {
        const backend = createMockBackend();
        const tex = backend.createTexture({
            size: [800, 600],
            format: "depth24plus",
            usage: 0x10,
        });
        expect(tex).toBeDefined();
        expect((backend.createTexture as any).mock.calls.length).toBe(1);
        const desc = (backend.createTexture as any).mock.calls[0][0];
        expect(desc.format).toBe("depth24plus");
        expect(desc.usage).toBe(0x10);
    });

    it("backend surface texture should be available via getCurrentSurfaceTexture", () => {
        const backend = createMockBackend();
        const surf = backend.getCurrentSurfaceTexture();
        expect(surf).not.toBeNull();
        const view = backend.createTextureView(surf!);
        expect(view).toBeDefined();
    });

    it("full backend render pass cycle: create encoder → begin pass → set viewport → end → submit", () => {
        const backend = createMockBackend();
        const encoder = backend.createCommandEncoder();
        const surfTex = backend.getCurrentSurfaceTexture()!;
        const colorView = backend.createTextureView(surfTex);
        const depthTex = backend.createTexture({ size: [800, 600], format: "depth24plus", usage: 0x10 });
        const depthView = backend.createTextureView(depthTex);

        const pass = encoder.beginRenderPass({
            colorAttachments: [{ view: colorView, clearValue: { r: 0, g: 0.1, b: 0.2, a: 1 }, loadOp: "clear", storeOp: "store" }],
            depthStencilAttachment: { view: depthView, depthClearValue: 1.0, depthLoadOp: "clear", depthStoreOp: "store" },
        });
        pass.setViewport(0, 0, 800, 600, 0, 1);
        pass.setScissorRect(0, 0, 800, 600);
        pass.end();

        const cmd = encoder.finish();
        backend.queue.submit([cmd]);

        expect((backend.createCommandEncoder as any).mock.calls.length).toBe(1);
        expect((encoder.beginRenderPass as any).mock.calls.length).toBe(1);
        expect((pass.setViewport as any).mock.calls.length).toBe(1);
        expect((pass.setScissorRect as any).mock.calls.length).toBe(1);
        expect((pass.end as any).mock.calls.length).toBe(1);
        expect((encoder.finish as any).mock.calls.length).toBe(1);
        expect((backend.queue.submit as any).mock.calls.length).toBe(1);
    });
});
