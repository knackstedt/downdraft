// ============================================================================
// shader-sweep.spec.ts — naga validation for inline WGSL
//
// The .wgsl loader plugins (bun-preload, Vite wgslValidatePlugin) validate
// standalone shader files at import/build time — but most engine shaders are
// inline template literals in .ts files, which until now were only validated
// lazily at runtime via getCompilationInfo(). This spec instantiates every
// shader-owning pass against a shader-capturing mock device and runs each
// captured source through the native naga validator (dd_wgsl_validate), the
// same frontend wgpu uses — broken WGSL fails CI instead of shipping.
//
// Skips when the platform library is unavailable; DD_REQUIRE_GPU=1 (set by
// the native GPU CI job) turns the skip into a hard failure.
// ============================================================================

import { ComputeGraph } from "@downdraft/engine/shader-graph";
import { validateWgslNative } from "@downdraft/platform-native";
import { describe, expect, it } from "bun:test";
import { ParticleComputePass } from "../particles/compute-pass";
import { ParticleRenderPass } from "../particles/render-pass";
import { BindlessTextureRegistry } from "./bindless/texture-registry";
import { ClusterGrid } from "./lighting/cluster-grid";
import { DEFAULT_CLUSTER_CONFIG } from "./lighting/cluster-types";
import { CSMPass } from "./passes/csm";
import { DecalPass } from "./passes/decal-pass";
import { DeferredLightingPass } from "./passes/deferred-lighting";
import { DepthPrepass } from "./passes/depth-prepass";
import { GraphComputePass } from "./passes/graph-compute";
import { GreasedLinePass } from "./passes/greased-line-pass";
import { OpaquePass } from "./passes/opaque";
import { PointLightShadowPass } from "./passes/point-light-shadow";
import { ShadowPass } from "./passes/shadow";
import { SkinningComputePass } from "./passes/skinning";
import { SkyDomePass } from "./passes/sky-dome";
import { SkyboxPass } from "./passes/skybox";
import { SpotLightShadowPass } from "./passes/spot-light-shadow";
import { TerrainPass } from "./passes/terrain";
import { TransparentPass } from "./passes/transparent";
import { UnderwaterFogPass } from "./passes/underwater-fog";
import { WaterPass } from "./passes/water";
import { SkyboxRenderer } from "./skybox";

// WebGPU globals — full spec values; the passes read them during prepare().
const _g = globalThis as unknown as Record<string, unknown>;
_g.GPUTextureUsage = {
  COPY_SRC: 0x1, COPY_DST: 0x2, TEXTURE_BINDING: 0x4, STORAGE_BINDING: 0x8, RENDER_ATTACHMENT: 0x10,
};
_g.GPUBufferUsage = {
  MAP_READ: 0x1, MAP_WRITE: 0x2, COPY_SRC: 0x4, COPY_DST: 0x8, INDEX: 0x10,
  VERTEX: 0x20, UNIFORM: 0x40, STORAGE: 0x80, INDIRECT: 0x100, QUERY_RESOLVE: 0x200,
};
_g.GPUShaderStage = { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };
_g.GPUMapMode = { READ: 0x1, WRITE: 0x2 };
_g.GPULoadOp ??= { Load: "load" };

interface CapturedShader {
  origin: string;
  label: string;
  code: string;
}

const captured: CapturedShader[] = [];

/** Mock GPUDevice that records every createShaderModule descriptor. */
function captureDevice(): GPUDevice {
  return {
    createShaderModule: (d: GPUShaderModuleDescriptor) => {
      captured.push({ origin: "?", label: d.label ?? "unnamed", code: d.code });
      return { label: d.label };
    },
    createBuffer: () => ({ destroy() {}, getMappedRange: () => new ArrayBuffer(0), mapAsync: () => Promise.resolve(), unmap() {} }),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createSampler: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createBindGroup: () => ({}),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    queue: { writeBuffer() {}, submit() {}, onSubmittedWorkDone: () => Promise.resolve() },
    limits: {},
    features: new Set(),
  } as unknown as GPUDevice;
}

const device = captureDevice();

/** Run a capture step; tolerate post-module-creation throws from the mock. */
function collect(origin: string, fn: () => void): void {
  const start = captured.length;
  try {
    fn();
  } catch {
    // The mock device doesn't satisfy every code path — modules created
    // before the throw are still captured and validated.
  }
  for (let i = start; i < captured.length; i++) captured[i].origin = origin;
}

// Minimal MeshData stand-in for passes that gate shader creation on setMesh().
const mesh = {
  layout: { stride: 44 },
  vertices: new Float32Array(44),
  indices: new Uint32Array(3),
  indexCount: 3,
};

collect("ShadowPass", () => new ShadowPass(device).prepare(device));
collect("CSMPass", () => new CSMPass(device).prepare(device));
collect("PointLightShadowPass", () => new PointLightShadowPass(device).prepare(device));
collect("SpotLightShadowPass", () => new SpotLightShadowPass(device).prepare(device));
collect("DeferredLightingPass", () => new DeferredLightingPass(device, "bgra8unorm", 640, 480).prepare(device));
collect("DepthPrepass", () => new DepthPrepass(device).prepare(device));
collect("GreasedLinePass", () => new GreasedLinePass(device, "bgra8unorm").prepare(device));
collect("SkyDomePass", () => new SkyDomePass(device, "bgra8unorm").prepare(device));
collect("UnderwaterFogPass", () => new UnderwaterFogPass(device, "bgra8unorm").prepare(device));
collect("TransparentPass", () => new TransparentPass(device, "bgra8unorm").prepare(device));
collect("WaterPass", () => new WaterPass(device, "bgra8unorm").prepare(device));
collect("TerrainPass", () => new TerrainPass(device, "bgra8unorm").prepare(device));
collect("DecalPass", () => new DecalPass(device, "bgra8unorm").prepare(device));
collect("SkyboxPass", () => new SkyboxPass(device, "bgra8unorm").prepare(device));
collect("SkyboxRenderer", () => { const s = new SkyboxRenderer(device); (s as any).ensurePipeline(); });
collect("ParticleComputePass", () => new ParticleComputePass(64).prepare(device));
collect("ParticleRenderPass", () => new ParticleRenderPass("bgra8unorm").prepare(device));
collect("SkinningComputePass", () => new SkinningComputePass(device, 64).prepare(64));
collect("ClusterGrid", () => new ClusterGrid(DEFAULT_CLUSTER_CONFIG, device).prepare(device));
collect("BindlessTextureRegistry.mip", () => { const r = new BindlessTextureRegistry(device); (r as any).getMipPipeline("rgba8unorm"); });
collect("GraphComputePass", () => {
  const g = new ComputeGraph();
  g.addStorageBuffer({
    name: "data", binding: 0, group: 0, access: "read_write",
    structName: "Element", structFields: [{ name: "value", type: "f32" }], elementCount: 64,
  });
  g.addUniformBuffer({
    name: "params", binding: 1, group: 0,
    structName: "Params", structFields: [{ name: "scale", type: "f32" }],
  });
  g.addNode({ id: "gid", type: "global_id", inputs: {}, outputs: { value: "u32" }, properties: {} });
  g.addNode({ id: "load", type: "buffer_load", inputs: { index: "" }, outputs: { value: "f32" }, properties: { buffer: "data", field: "value" } });
  g.addNode({ id: "store", type: "buffer_store", inputs: { index: "", value: "" }, outputs: {}, properties: { buffer: "data", field: "value" } });
  g.connect("gid", "value", "load", "index");
  g.connect("gid", "value", "store", "index");
  g.connect("load", "value", "store", "value");
  g.setDispatchConfig({ workgroupSize: [64, 1, 1], dispatchCount: [1, 1, 1] });
  new GraphComputePass("sweep-compute", g).prepare(device);
});
collect("OpaquePass.gbuffer", () => {
  const p = new OpaquePass(device, "bgra8unorm", "gbuffer");
  p.setMesh(mesh as never);
  p.prepare(device);
});
collect("OpaquePass.simple", () => {
  const p = new OpaquePass(device, "bgra8unorm", "simple");
  p.setMesh(mesh as never);
  p.prepare(device);
});
collect("OpaquePass.pbr", () => {
  const p = new OpaquePass(device, "bgra8unorm");
  p.setMesh(mesh as never);
  (p as any).ensurePBRPipeline();
});

// Probe the validator once — a missing platform lib skips the whole sweep.
const probe = validateWgslNative("fn dd_probe() {}", "probe");
const validatorAvailable = probe !== null;

describe("inline WGSL sweep (naga)", () => {
  it("captured shaders from the engine render passes", () => {
    if (!validatorAvailable && (globalThis as any).process?.env?.DD_REQUIRE_GPU === "1") {
      throw new Error("dd_wgsl_validate unavailable — native platform lib required for this job");
    }
    if (!validatorAvailable) {
      console.log("  (skip) platform lib unavailable — dd_wgsl_validate not found");
      return;
    }
    expect(captured.length).toBeGreaterThan(15);
  });

  captured.forEach((s) => {
    it(`${s.origin} › ${s.label}`, () => {
      if (!validatorAvailable) return;
      const result = validateWgslNative(s.code, `${s.origin}:${s.label}`);
      expect(result).not.toBeNull();
      if (result && !result.ok) {
        throw new Error(`${s.origin}/${s.label}:\n${result.errors.join("\n")}\n--- source ---\n${s.code}`);
      }
    });
  });
});
