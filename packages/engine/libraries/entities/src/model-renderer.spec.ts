// ModelRenderer hot-path tests — batched uniform writes + CPU frustum culling.
// Runs fully on a mock GPUDevice: no native lib or real adapter required.
import { beforeAll, describe, expect, it } from "bun:test";

(globalThis as unknown as { GPUBufferUsage: unknown }).GPUBufferUsage = {
  UNIFORM: 0x40, COPY_DST: 0x08, VERTEX: 0x20, INDEX: 0x10, STORAGE: 0x80,
};
(globalThis as unknown as { GPUShaderStage: unknown }).GPUShaderStage = {
  VERTEX: 1, FRAGMENT: 2, COMPUTE: 4,
};

interface WriteCall { buffer: unknown; offset: number; data: ArrayBufferView }

function createMockDevice() {
  const writes: WriteCall[] = [];
  const device = {
    queue: {
      writeBuffer(buffer: unknown, offset: number, data: ArrayBufferView) {
        writes.push({ buffer, offset, data });
      },
      submit() {},
    },
    createBuffer: (desc: Record<string, unknown>) => ({ desc }),
    createBindGroupLayout: () => ({}),
    createBindGroup: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({}),
    createShaderModule: () => ({
      getCompilationInfo: async () => ({ messages: [] }),
    }),
  };
  return { device, writes };
}

function createMockPass() {
  const draws: number[] = [];
  const pass = {
    setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer() {},
    drawIndexed(count: number) { draws.push(count); },
    end() {},
  };
  return { pass, draws };
}

// Stride-6 source mesh (pos3 + normal3): a 2×2 quad at z=0.
function makeMesh(vertexOffsetX = 0, materialIndex = 0, skinned = false) {
  const vertices = new Float32Array([
    -1 + vertexOffsetX, -1, 0, 0, 0, 1,
    1 + vertexOffsetX, -1, 0, 0, 0, 1,
    1 + vertexOffsetX, 1, 0, 0, 0, 1,
    -1 + vertexOffsetX, 1, 0, 0, 0, 1,
  ]);
  const mesh: Record<string, unknown> = {
    vertices,
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    vertexCount: 4,
    indexCount: 6,
    uvs: null,
    colors: null,
    materialIndex,
  };
  if (skinned) {
    mesh.joints = new Uint8Array(16); // 4 joints × 4 verts
    mesh.weights = new Float32Array(16).fill(0.25);
  }
  return mesh;
}

const CAMERA = {
  position: [0, 0, 5] as [number, number, number],
  target: [0, 0, 0] as [number, number, number],
  up: [0, 1, 0] as [number, number, number],
  fov: 60, near: 0.1, far: 100, aspect: 1,
};
const IDENTITY_ROT: [number, number, number, number] = [0, 0, 0, 1];
const UNIT_SCALE: [number, number, number] = [1, 1, 1];
const UNIFORM_BUFFER_SIZE = 4096 * 256;

let ModelRenderer: typeof import("./model-renderer").ModelRenderer;
beforeAll(async () => {
  ({ ModelRenderer } = await import("./model-renderer"));
});

function uniformWrites(writes: WriteCall[]) {
  return writes.filter(
    (w) => (w.buffer as { desc: { size: number } }).desc.size === UNIFORM_BUFFER_SIZE,
  );
}

describe("ModelRenderer batched uniforms + frustum culling", () => {
  it("flushes all per-mesh uniforms with a single writeBuffer", async () => {
    const { device, writes } = createMockDevice();
    const renderer = new ModelRenderer(device as never, "rgba8unorm");
    await renderer.init();
    writes.length = 0;

    // Three meshes, distinct material slots via a stub bindless manager.
    let nextMat = 0;
    renderer.setBindlessDeps({
      registry: { defaultWhiteHandle: 0, defaultNormalHandle: 0 },
      materialManager: { registerMaterial: () => ++nextMat },
      bindGroupLayout: {},
    } as never);
    renderer.uploadModel("node", [makeMesh(0, 0), makeMesh(0, 1), makeMesh(0, 2)] as never);
    writes.length = 0;

    renderer.beginFrame(CAMERA);
    const { pass, draws } = createMockPass();
    renderer.render(pass as never, "node", [0, 0, 0], IDENTITY_ROT, UNIT_SCALE);

    expect(draws.length).toBe(3);
    const uw = uniformWrites(writes);
    expect(uw.length).toBe(1);
    expect(uw[0].offset).toBe(0);
    expect(uw[0].data.byteLength).toBe(3 * 256);
    // Per-mesh materialIndex at u32 slot 32 of each 64-float block. Index 1
    // is the default material registered by setBindlessDeps, so the three
    // mesh materials land at 2, 3, 4.
    const u32 = new Uint32Array(uw[0].data.buffer, uw[0].data.byteOffset, uw[0].data.byteLength / 4);
    expect(u32[32]).toBe(2);
    expect(u32[64 + 32]).toBe(3);
    expect(u32[128 + 32]).toBe(4);
  });

  it("culls nodes fully outside the camera frustum", async () => {
    const { device, writes } = createMockDevice();
    const renderer = new ModelRenderer(device as never, "rgba8unorm");
    await renderer.init();
    renderer.uploadModel("node", [makeMesh()] as never);
    writes.length = 0;

    renderer.beginFrame(CAMERA);
    const { pass, draws } = createMockPass();
    // Camera looks down -Z from z=5; a node at z=+10 is behind it.
    renderer.render(pass as never, "node", [0, 0, 10], IDENTITY_ROT, UNIT_SCALE);
    expect(draws.length).toBe(0);
    expect(uniformWrites(writes).length).toBe(0);

    // Same node in front of the camera draws.
    renderer.render(pass as never, "node", [0, 0, 0], IDENTITY_ROT, UNIT_SCALE);
    expect(draws.length).toBe(1);
  });

  it("scaled bounds reach into the frustum — transform is applied before culling", async () => {
    const { device } = createMockDevice();
    const renderer = new ModelRenderer(device as never, "rgba8unorm");
    await renderer.init();
    renderer.uploadModel("node", [makeMesh()] as never);

    renderer.beginFrame(CAMERA);
    const { pass, draws } = createMockPass();
    // x=10 is outside the frustum laterally at unit scale…
    renderer.render(pass as never, "node", [10, 0, 0], IDENTITY_ROT, UNIT_SCALE);
    expect(draws.length).toBe(0);
    // …but a 20× x-scale widens the world AABB across the frustum planes.
    renderer.render(pass as never, "node", [10, 0, 0], IDENTITY_ROT, [20, 1, 1]);
    expect(draws.length).toBe(1);
  });

  it("never culls skinned models", async () => {
    const { device } = createMockDevice();
    const renderer = new ModelRenderer(device as never, "rgba8unorm");
    await renderer.init();
    renderer.uploadModel("node", [makeMesh(0, 0, true)] as never);

    renderer.beginFrame(CAMERA);
    const { pass, draws } = createMockPass();
    renderer.render(pass as never, "node", [0, 0, 10], IDENTITY_ROT, UNIT_SCALE);
    expect(draws.length).toBe(1);
  });

  it("setFrustumCullingEnabled(false) disables the early-out", async () => {
    const { device } = createMockDevice();
    const renderer = new ModelRenderer(device as never, "rgba8unorm");
    await renderer.init();
    renderer.uploadModel("node", [makeMesh()] as never);
    renderer.setFrustumCullingEnabled(false);

    renderer.beginFrame(CAMERA);
    const { pass, draws } = createMockPass();
    renderer.render(pass as never, "node", [0, 0, 10], IDENTITY_ROT, UNIT_SCALE);
    expect(draws.length).toBe(1);
  });

  it("drops stale bounds after updateVertexBuffer so deformed meshes still draw", async () => {
    const { device } = createMockDevice();
    const renderer = new ModelRenderer(device as never, "rgba8unorm");
    await renderer.init();
    renderer.uploadModel("node", [makeMesh()] as never);
    // Deform: stride-11 interleaved data moves the quad far behind the camera.
    renderer.updateVertexBuffer("node", 0, new Float32Array(4 * 11));

    renderer.beginFrame(CAMERA);
    const { pass, draws } = createMockPass();
    renderer.render(pass as never, "node", [0, 0, 10], IDENTITY_ROT, UNIT_SCALE);
    expect(draws.length).toBe(1); // bounds dropped → never culled
  });

  it("renderDepth culls against the light frustum, not the camera", async () => {
    const { device } = createMockDevice();
    const renderer = new ModelRenderer(device as never, "rgba8unorm");
    await renderer.init();
    renderer.uploadModel("node", [makeMesh()] as never);
    renderer.beginFrame(CAMERA);
    const { pass, draws } = createMockPass();

    // Light VP = camera VP — node at origin is visible to both.
    const { calculateViewProj } = await import("@downdraft/engine");
    const lightVp = calculateViewProj(CAMERA);
    renderer.renderDepth(pass as never, lightVp, "node", [0, 0, 0], IDENTITY_ROT, UNIT_SCALE);
    expect(draws.length).toBe(1);

    // Node behind the light is skipped by the depth pass.
    draws.length = 0;
    renderer.renderDepth(pass as never, lightVp, "node", [0, 0, 10], IDENTITY_ROT, UNIT_SCALE);
    expect(draws.length).toBe(0);
  });

  it("batches renderMask writes the same way", async () => {
    const { device, writes } = createMockDevice();
    const renderer = new ModelRenderer(device as never, "rgba8unorm");
    await renderer.init();
    renderer.uploadModel("node", [makeMesh(0, 0), makeMesh(0, 1)] as never);
    writes.length = 0;

    renderer.beginFrame(CAMERA);
    const { pass, draws } = createMockPass();
    renderer.renderMask(pass as never, "node", [0, 0, 0], IDENTITY_ROT, UNIT_SCALE);
    expect(draws.length).toBe(2);
    expect(uniformWrites(writes).length).toBe(1);
  });

  it("instanced render writes one buffer at the instance base offset", async () => {
    const { device, writes } = createMockDevice();
    const renderer = new ModelRenderer(device as never, "rgba8unorm");
    await renderer.init();
    renderer.uploadModel("node", [makeMesh(0, 0), makeMesh(0, 1)] as never);
    const inst = renderer.allocateInstance("node");
    expect(inst).toBe(1);
    writes.length = 0;

    renderer.beginFrame(CAMERA);
    const { pass, draws } = createMockPass();
    renderer.render(pass as never, "node", [0, 0, 0], IDENTITY_ROT, UNIT_SCALE, 1);
    expect(draws.length).toBe(2);
    const uw = uniformWrites(writes);
    expect(uw.length).toBe(1);
    expect(uw[0].offset).toBe(2 * 256); // instance base = after mesh0+mesh1 slots
  });
});
