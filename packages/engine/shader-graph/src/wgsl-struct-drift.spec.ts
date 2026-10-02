// ============================================================================
// wgsl-struct-drift.spec.ts — repo-wide drift test
//
// Validates that external .wgsl files (imported via ?raw) match their typed
// WgslStruct definitions. This catches the "MUST match" comments problem:
// when a WGSL struct is edited in a .wgsl file but the TS-side struct
// definition (used for typed buffer writes) is not updated, the drift test
// fails.
//
// The struct definitions are re-declared here (not imported from the library
// packages) because:
// 1. bun test resolves relative imports but not tsconfig path mappings.
// 2. The drift test should be self-contained — if the library's struct
//    definition drifts from the .wgsl file, the test catches it regardless
//    of whether the library exports the struct.
// 3. The test struct definitions are checked against both the .wgsl files
//    AND the library's struct definitions (via a separate tsc-checked file).
// ============================================================================

import { describe, expect, it } from "bun:test";
import type { WgslStruct } from "./wgsl-struct";
import { wgsl } from "./wgsl-struct";
import { compareStruct, parseWgslStructs } from "./wgsl-struct-validator";

// ─── .wgsl file imports (resolved via workspace package links) ──────────────
import CLOUD_WGSL from "@downdraft/engine/libraries/weatherfx/shaders/cloud.wgsl?raw" with { type: "text" };
import PARTICLE_COMPUTE_WGSL from "@downdraft/engine/libraries/weatherfx/shaders/particle-compute.wgsl?raw" with { type: "text" };
import PARTICLE_RENDER_WGSL from "@downdraft/engine/libraries/weatherfx/shaders/particle-render.wgsl?raw" with { type: "text" };

// ─── Struct definitions (must match the library definitions exactly) ────────
// These mirror the definitions in:
//   - packages/engine/libraries/weatherfx/src/cloud-system.ts (CloudUniformsStruct, PerLayerUniformsStruct)
//   - packages/engine/libraries/weatherfx/src/particle-system.ts (SimParamsStruct, RenderUniformsStruct)
//   - packages/engine/libraries/postfx/src/pixelation.ts (PostProcessUniformsStruct)

const CloudUniformsStruct = wgsl.struct("CloudUniforms", {
  viewProj: wgsl.mat4x4f,
  cameraPos: wgsl.vec3f,
  timeOfDay: wgsl.f32,
  weatherType: wgsl.u32,
  sunDir: wgsl.vec3f,
  sunIntensity: wgsl.f32,
  moonDir: wgsl.vec3f,
  moonIntensity: wgsl.f32,
  time: wgsl.f32,
  weatherBlend: wgsl.f32,
  fogColor: wgsl.vec3f,
  fogDensity: wgsl.f32,
});

const PerLayerUniformsStruct = wgsl.struct("PerLayerUniforms", {
  layerPos: wgsl.vec3f,
  _pad: wgsl.f32,
});

const SimParamsStruct = wgsl.struct("SimParams", {
  deltaTime: wgsl.f32,
  time: wgsl.f32,
  spawnCount: wgsl.f32,
  maxParticles: wgsl.f32,
  cursor: wgsl.f32,
  weatherType: wgsl.f32,
  isSnow: wgsl.f32,
  _pad0: wgsl.f32,
  cameraPos: wgsl.vec3f,
  collisionRadius: wgsl.f32,
  spawnSpread: wgsl.f32,
  spawnHeight: wgsl.f32,
  baseVelY: wgsl.f32,
  particleSize: wgsl.f32,
  lifetime: wgsl.f32,
  colorR: wgsl.f32,
  colorG: wgsl.f32,
  colorB: wgsl.f32,
  windX: wgsl.f32,
  windZ: wgsl.f32,
  _pad1: wgsl.f32,
  _pad2: wgsl.f32,
  voxelOrigin: wgsl.vec3f,
  voxelSize: wgsl.f32,
  voxelDimX: wgsl.f32,
  voxelDimY: wgsl.f32,
  voxelDimZ: wgsl.f32,
  voxelCount: wgsl.f32,
  isoLevel: wgsl.f32,
  seed: wgsl.f32,
});

const RenderUniformsStruct = wgsl.struct("RenderUniforms", {
  viewProj: wgsl.mat4x4f,
  cameraPos: wgsl.vec3f,
  time: wgsl.f32,
  particleCount: wgsl.f32,
  weatherType: wgsl.f32,
  aspect: wgsl.f32,
  focalLength: wgsl.f32,
  cullDistance: wgsl.f32,
});

// ─── Helper ─────────────────────────────────────────────────────────────────
function expectNoDrift(wgslSource: string, def: WgslStruct): void {
  const parsed = parseWgslStructs(wgslSource);
  const match = parsed.find((s) => s.name === def.name);
  expect(match).toBeDefined();
  if (!match) return;
  const result = compareStruct(match, def);
  if (result.errors.length > 0) {
    // Fail with a detailed error message listing all mismatches.
    expect(result.errors, `Struct "${def.name}" drift:\n${result.errors.map((e) => `  - ${e}`).join("\n")}`).toEqual([]);
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("WGSL struct drift: weatherfx", () => {
  it("CloudUniforms matches cloud.wgsl", () => {
    expectNoDrift(CLOUD_WGSL, CloudUniformsStruct);
  });
  it("PerLayerUniforms matches cloud.wgsl", () => {
    expectNoDrift(CLOUD_WGSL, PerLayerUniformsStruct);
  });
  it("SimParams matches particle-compute.wgsl", () => {
    expectNoDrift(PARTICLE_COMPUTE_WGSL, SimParamsStruct);
  });
  it("RenderUniforms matches particle-render.wgsl", () => {
    expectNoDrift(PARTICLE_RENDER_WGSL, RenderUniformsStruct);
  });
});

