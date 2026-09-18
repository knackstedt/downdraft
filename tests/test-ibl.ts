// IBL System Tests — shader chunk generation, bind group layout, and integration validation.
// Run: bun tests/test-ibl.ts

// ─── GPU Global Polyfills ───────────────────────────────────────────────────
// Bun doesn't have WebGPU globals; polyfill the ones used at module-level in imported files.
const GPU_SHADER_STAGE = { VERTEX: 0x1, FRAGMENT: 0x8, COMPUTE: 0x2 } as const;
const GPU_BUFFER_USAGE = { UNIFORM: 0x40, STORAGE: 0x80, COPY_DST: 0x8, COPY_SRC: 0x4, MAP_READ: 0x1, INDEX: 0x10, VERTEX: 0x20 } as const;
const GPU_TEXTURE_USAGE = { TEXTURE_BINDING: 0x8, COPY_DST: 0x4, COPY_SRC: 0x1, RENDER_ATTACHMENT: 0x10, STORAGE_BINDING: 0x100 } as const;

(globalThis as any).GPUShaderStage = GPU_SHADER_STAGE;
(globalThis as any).GPUBufferUsage = GPU_BUFFER_USAGE;
(globalThis as any).GPUTextureUsage = GPU_TEXTURE_USAGE;

// ─── Shader Chunk Generation Tests ─────────────────────────────────────────

async function testShaderChunkWithLUT() {
  const { createIBLShaderChunk } = await import("../packages/engine/core/src/render/ibl-bind-group");
  const chunk = createIBLShaderChunk(2, true);

  assert(chunk.includes("@group(2) @binding(0)"), "IBL chunk: should have irradianceMap at group 2 binding 0");
  assert(chunk.includes("@group(2) @binding(1)"), "IBL chunk: should have prefilterMap at group 2 binding 1");
  assert(chunk.includes("@group(2) @binding(2)"), "IBL chunk: should have brdfLUT at group 2 binding 2");
  assert(chunk.includes("@group(2) @binding(3)"), "IBL chunk: should have irradianceSampler at group 2 binding 3");
  assert(chunk.includes("@group(2) @binding(4)"), "IBL chunk: should have prefilterSampler at group 2 binding 4");
  assert(chunk.includes("@group(2) @binding(5)"), "IBL chunk: should have brdfSampler at group 2 binding 5");
  assert(chunk.includes("@group(2) @binding(6)"), "IBL chunk: should have iblUniforms at group 2 binding 6");

  assert(chunk.includes("var irradianceMap: texture_cube<f32>"), "IBL chunk: irradianceMap should be texture_cube");
  assert(chunk.includes("var prefilterMap: texture_cube<f32>"), "IBL chunk: prefilterMap should be texture_cube");
  assert(chunk.includes("var brdfLUT: texture_2d<f32>"), "IBL chunk: brdfLUT should be texture_2d");
  assert(chunk.includes("var<uniform> iblUniforms: IBLUniforms"), "IBL chunk: should have IBLUniforms uniform");

  assert(chunk.includes("fn getIBLDiffuse"), "IBL chunk: should declare getIBLDiffuse function");
  assert(chunk.includes("fn getIBLSpecular"), "IBL chunk: should declare getIBLSpecular function");
  assert(chunk.includes("textureSample(irradianceMap"), "IBL chunk: getIBLDiffuse should sample irradianceMap");
  assert(chunk.includes("textureSampleLevel(prefilterMap"), "IBL chunk: getIBLSpecular should sample prefilterMap with lod");
  assert(chunk.includes("textureSample(brdfLUT"), "IBL chunk: getIBLSpecular should sample brdfLUT");

  assert(chunk.includes("struct IBLUniforms"), "IBL chunk: should declare IBLUniforms struct");
  assert(chunk.includes("maxMipLevel: f32"), "IBL chunk: IBLUniforms should have maxMipLevel field");

  console.log("✓ Shader chunk with LUT: 7 bindings, correct types, functions present");
}

async function testShaderChunkWithoutLUT() {
  const { createIBLShaderChunk } = await import("../packages/engine/core/src/render/ibl-bind-group");
  const chunk = createIBLShaderChunk(1, false);

  assert(chunk.includes("@group(1) @binding(0)"), "IBL chunk (no LUT): should have irradianceMap at group 1 binding 0");
  assert(chunk.includes("@group(1) @binding(1)"), "IBL chunk (no LUT): should have prefilterMap at group 1 binding 1");
  assert(chunk.includes("@group(1) @binding(2)"), "IBL chunk (no LUT): should have irradianceSampler at group 1 binding 2");
  assert(chunk.includes("@group(1) @binding(3)"), "IBL chunk (no LUT): should have prefilterSampler at group 1 binding 3");
  assert(chunk.includes("@group(1) @binding(4)"), "IBL chunk (no LUT): should have iblUniforms at group 1 binding 4");

  assert(!chunk.includes("@binding(5)"), "IBL chunk (no LUT): should not have binding 5");
  assert(!chunk.includes("@binding(6)"), "IBL chunk (no LUT): should not have binding 6");
  assert(!chunk.includes("brdfLUT"), "IBL chunk (no LUT): should not reference brdfLUT");
  assert(!chunk.includes("brdfSampler"), "IBL chunk (no LUT): should not reference brdfSampler");

  assert(chunk.includes("fn getIBLDiffuse"), "IBL chunk (no LUT): should still declare getIBLDiffuse");
  assert(chunk.includes("fn getIBLSpecular"), "IBL chunk (no LUT): should still declare getIBLSpecular");
  assert(!chunk.includes("textureSample(brdfLUT"), "IBL chunk (no LUT): getIBLSpecular should not sample brdfLUT");

  console.log("✓ Shader chunk without LUT: 5 bindings, no LUT references, functions present");
}

async function testShaderChunkDifferentGroups() {
  const { createIBLShaderChunk } = await import("../packages/engine/core/src/render/ibl-bind-group");

  for (const g of [0, 1, 2, 3, 4]) {
    const chunk = createIBLShaderChunk(g, true);
    assert(chunk.includes(`@group(${g}) @binding(0)`), `IBL chunk group ${g}: should have @group(${g})`);
    assert(!chunk.includes(`@group(${g + 1})`), `IBL chunk group ${g}: should not reference group ${g + 1}`);
  }

  console.log("✓ Shader chunk groups: all group indices 0-4 produce correct @group(N) annotations");
}

async function testIBLShaderChunkConstant() {
  const { IBL_SHADER_CHUNK, createIBLShaderChunk } = await import("../packages/engine/core/src/render/ibl-bind-group");
  const expected = createIBLShaderChunk(2, true);
  assert(IBL_SHADER_CHUNK === expected, "IBL_SHADER_CHUNK constant should equal createIBLShaderChunk(2, true)");
  assert(IBL_SHADER_CHUNK.includes("@group(2)"), "IBL_SHADER_CHUNK should use group 2");

  console.log("✓ IBL_SHADER_CHUNK constant: matches createIBLShaderChunk(2, true)");
}

// ─── Entity Shader Integration Tests ───────────────────────────────────────

async function testEntityShaderPBRBindings() {
  const { PBR_BINDINGS } = await import("../games/to-the-ocean/src/engine/shaders/entity-shaders");
  assert(PBR_BINDINGS.includes("@group(2) @binding(0)"), "Entity PBR_BINDINGS: should use group 2 binding 0");
  assert(PBR_BINDINGS.includes("irradianceMap"), "Entity PBR_BINDINGS: should declare irradianceMap");
  assert(PBR_BINDINGS.includes("prefilterMap"), "Entity PBR_BINDINGS: should declare prefilterMap");
  assert(PBR_BINDINGS.includes("brdfLUT"), "Entity PBR_BINDINGS: should declare brdfLUT (includeBRDFLUT=true)");
  assert(PBR_BINDINGS.includes("getIBLDiffuse"), "Entity PBR_BINDINGS: should include getIBLDiffuse function");
  assert(PBR_BINDINGS.includes("getIBLSpecular"), "Entity PBR_BINDINGS: should include getIBLSpecular function");

  console.log("✓ Entity shader PBR_BINDINGS: group 2, all IBL resources and functions present");
}

async function testEntityShaderIBLUsage() {
  const { LIGHTING_FN, INSTANCED_ENTITY_WGSL } = await import("../games/to-the-ocean/src/engine/shaders/entity-shaders");

  assert(LIGHTING_FN.includes("getIBLDiffuse(N)"), "entityLighting: should call getIBLDiffuse(N)");
  assert(LIGHTING_FN.includes("getIBLSpecular(N, R, roughness)"), "entityLighting: should call getIBLSpecular(N, R, roughness)");
  assert(LIGHTING_FN.includes("fresnelSchlickRoughness"), "entityLighting: should use fresnelSchlickRoughness for IBL");
  assert(!LIGHTING_FN.includes("hemiAmbient"), "entityLighting: should not use old hemiAmbient");

  assert(INSTANCED_ENTITY_WGSL.includes("getIBLDiffuse(N)"), "instancedEntityLighting: should call getIBLDiffuse(N)");
  assert(INSTANCED_ENTITY_WGSL.includes("getIBLSpecular(N, R, roughness)"), "instancedEntityLighting: should call getIBLSpecular");
  assert(INSTANCED_ENTITY_WGSL.includes("fresnelSchlickRoughness"), "instancedEntityLighting: should use fresnelSchlickRoughness");

  console.log("✓ Entity shader IBL usage: getIBLDiffuse/getIBLSpecular called in entityLighting and instancedEntityLighting");
}

async function testEntityShaderIslandLighting() {
  const { ISLAND_WGSL } = await import("../games/to-the-ocean/src/engine/shaders/entity-shaders");

  assert(ISLAND_WGSL.includes("getIBLDiffuse(perturbedN)"), "islandLighting: should call getIBLDiffuse(perturbedN)");
  assert(ISLAND_WGSL.includes("getIBLSpecular(perturbedN, R, roughness)"), "islandLighting: should call getIBLSpecular(perturbedN, R, roughness)");
  assert(ISLAND_WGSL.includes("fresnelSchlickRoughness"), "islandLighting: should use fresnelSchlickRoughness");
  assert(ISLAND_WGSL.includes("skyTint"), "islandLighting: should still define skyTint for wet surface reflections");

  console.log("✓ Island shader IBL usage: getIBLDiffuse/getIBLSpecular with perturbedN, skyTint preserved");
}

// ─── Deferred Lighting Integration Tests ───────────────────────────────────

async function testDeferredLightingShader() {
  const module = await import("../packages/engine/core/src/render/passes/deferred-lighting");
  assert(typeof module.DeferredLightingPass === "function", "DeferredLightingPass: should be a class");

  console.log("✓ Deferred lighting: DeferredLightingPass exported correctly");
}

// ─── IBLSystem Options Tests ───────────────────────────────────────────────

async function testIBLSystemOptions() {
  const { IBLSystem } = await import("../packages/engine/core/src/render/ibl");
  assert(typeof IBLSystem === "function", "IBLSystem: should be a class");

  console.log("✓ IBLSystem: exported correctly, is a class");
}

// ─── CubemapCapturePass Tests ──────────────────────────────────────────────

async function testCubemapCapturePass() {
  const { CubemapCapturePass } = await import("../packages/engine/core/src/render/passes/cubemap-capture");
  assert(typeof CubemapCapturePass === "function", "CubemapCapturePass: should be a class");

  console.log("✓ CubemapCapturePass: exported correctly, is a class");
}

// ─── Core Index Export Tests ───────────────────────────────────────────────

async function testCoreExports() {
  const coreModule = await import("../packages/engine/core/src/index");

  assert(typeof coreModule.createIBLShaderChunk === "function", "Core index: should export createIBLShaderChunk");
  assert(typeof coreModule.IBL_SHADER_CHUNK === "string", "Core index: should export IBL_SHADER_CHUNK");
  assert(typeof coreModule.IBLBindGroup === "function", "Core index: should export IBLBindGroup");
  assert(typeof coreModule.IBLSystem === "function", "Core index: should export IBLSystem");
  assert(typeof coreModule.CubemapCapturePass === "function", "Core index: should export CubemapCapturePass");
  assert(typeof coreModule.DeferredLightingPass === "function", "Core index: should export DeferredLightingPass");

  console.log("✓ Core exports: createIBLShaderChunk, IBL_SHADER_CHUNK, IBLBindGroup, IBLSystem, CubemapCapturePass, DeferredLightingPass");
}

// ─── WGSL Validity Tests ───────────────────────────────────────────────────

async function testWGSLValidity() {
  const { createIBLShaderChunk } = await import("../packages/engine/core/src/render/ibl-bind-group");

  const chunk = createIBLShaderChunk(2, true);

  assert(chunk.includes("texture_cube<f32>"), "WGSL: should use texture_cube<f32> for cubemaps");
  assert(chunk.includes("texture_2d<f32>"), "WGSL: should use texture_2d<f32> for BRDF LUT");
  assert(chunk.includes("sampler"), "WGSL: should declare samplers");
  assert(chunk.includes("textureSample("), "WGSL: should use textureSample for filtered sampling");
  assert(chunk.includes("textureSampleLevel("), "WGSL: should use textureSampleLevel for lod-controlled sampling");

  assert(chunk.includes("iblUniforms.maxMipLevel"), "WGSL: getIBLSpecular should reference iblUniforms.maxMipLevel for lod");
  assert(chunk.includes("roughness * iblUniforms.maxMipLevel"), "WGSL: lod should be roughness * maxMipLevel");

  const noLutChunk = createIBLShaderChunk(1, false);
  assert(noLutChunk.includes("textureSampleLevel(prefilterMap"), "WGSL (no LUT): should still use textureSampleLevel for prefilter");
  assert(!noLutChunk.includes("brdfLUT"), "WGSL (no LUT): should not reference brdfLUT");

  console.log("✓ WGSL validity: correct texture types, sampling functions, and lod calculation");
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  IBL System Tests");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const tests: { name: string; fn: () => Promise<void> }[] = [
    // Shader chunk generation
    { name: "Shader Chunk With LUT", fn: testShaderChunkWithLUT },
    { name: "Shader Chunk Without LUT", fn: testShaderChunkWithoutLUT },
    { name: "Shader Chunk Different Groups", fn: testShaderChunkDifferentGroups },
    { name: "IBL_SHADER_CHUNK Constant", fn: testIBLShaderChunkConstant },
    // Entity shader integration
    { name: "Entity Shader PBR Bindings", fn: testEntityShaderPBRBindings },
    { name: "Entity Shader IBL Usage", fn: testEntityShaderIBLUsage },
    { name: "Entity Shader Island Lighting", fn: testEntityShaderIslandLighting },
    // Deferred lighting integration
    { name: "Deferred Lighting Shader", fn: testDeferredLightingShader },
    // IBLSystem and CubemapCapturePass
    { name: "IBLSystem Options", fn: testIBLSystemOptions },
    { name: "CubemapCapturePass", fn: testCubemapCapturePass },
    // Core exports
    { name: "Core Exports", fn: testCoreExports },
    // WGSL validity
    { name: "WGSL Validity", fn: testWGSLValidity },
  ];

  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const test of tests) {
    try {
      await test.fn();
      passed++;
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`  ✗ ${test.name}: ${msg}`);
      console.log(`  ✗ ${test.name}: ${msg}`);
    }
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed, ${tests.length} total`);
  if (failures.length > 0) {
    console.log("\n  Failures:");
    for (const f of failures) console.log(f);
  }
  console.log("═══════════════════════════════════════════════════════════════");

  if (failed > 0) process.exit(1);
  process.exit(0);
}

main();
