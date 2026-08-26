// Comprehensive loader tests for all asset pipeline formats.
// Run: bun tests/test-loaders.ts

import { readFileSync } from "fs";
import { join } from "path";

const FIXTURES = join(import.meta.dir, "fixtures");

// ─── Texture Loaders ───────────────────────────────────────────────────────

// DDS
async function testDDS() {
  const { parseDDS } = await import("../packages/core/src/assets/loader-dds");
  const data = readFileSync(join(FIXTURES, "textures", "test_rgba8.dds")).buffer as ArrayBuffer;
  const result = parseDDS(data);
  if (!result) throw new Error("DDS: parseDDS returned null");
  assert(result.width === 4, `DDS: expected width=4, got ${result.width}`);
  assert(result.height === 4, `DDS: expected height=4, got ${result.height}`);
  assert(result.mipLevels >= 1, `DDS: expected mipLevels>=1, got ${result.mipLevels}`);
  assert(!result.isHDR, "DDS: should not be HDR");
  assert(result.data.length > 0, "DDS: data should not be empty");
  console.log(`✓ DDS: ${result.width}x${result.height}, format=${result.format}, mipLevels=${result.mipLevels}, data=${result.data.length} bytes`);
}

// KTX2
async function testKTX2() {
  const { parseKTX2FromBuffer } = await import("../packages/core/src/assets/loader-texture");
  const data = readFileSync(join(FIXTURES, "textures", "test_rgba8.ktx2")).buffer as ArrayBuffer;
  const result = parseKTX2FromBuffer(data);
  if (!result) throw new Error("KTX2: parseKTX2FromBuffer returned null");
  assert(result.width === 4, `KTX2: expected width=4, got ${result.width}`);
  assert(result.height === 4, `KTX2: expected height=4, got ${result.height}`);
  assert(result.mipLevels >= 1, `KTX2: expected mipLevels>=1, got ${result.mipLevels}`);
  assert(!result.isHDR, "KTX2: should not be HDR");
  assert(result.data.length > 0, "KTX2: data should not be empty");
  console.log(`✓ KTX2: ${result.width}x${result.height}, format=${result.format}, mipLevels=${result.mipLevels}, data=${result.data.length} bytes`);
}

// HDR
async function testHDR() {
  const { parseHDR } = await import("../packages/core/src/assets/loader-hdr");
  const data = readFileSync(join(FIXTURES, "textures", "studio_small_08_1k.hdr")).buffer as ArrayBuffer;
  const result = parseHDR(data);
  if (!result) throw new Error("HDR: parseHDR returned null");
  assert(result.width > 0, `HDR: expected width>0, got ${result.width}`);
  assert(result.height > 0, `HDR: expected height>0, got ${result.height}`);
  assert(result.isHDR, "HDR: should be HDR");
  assert(result.data.length > 0, "HDR: data should not be empty");
  console.log(`✓ HDR: ${result.width}x${result.height}, format=${result.format}, isHDR=${result.isHDR}, data=${result.data.length} bytes`);
}

// ─── Model Loaders ─────────────────────────────────────────────────────────

// OBJ
async function testOBJ() {
  const { parseOBJ } = await import("@downdraft/library-models");
  const data = readFileSync(join(FIXTURES, "models", "cube.obj")).buffer as ArrayBuffer;
  const result = parseOBJ(data, "cube");
  assert(result.meshes.length > 0, `OBJ: expected meshes>0, got ${result.meshes.length}`);
  const mesh = result.meshes[0];
  assert(mesh.vertexCount > 0, `OBJ: expected vertexCount>0, got ${mesh.vertexCount}`);
  assert(mesh.indexCount > 0, `OBJ: expected indexCount>0, got ${mesh.indexCount}`);
  assert(mesh.vertices.length > 0, "OBJ: vertices buffer should not be empty");
  assert(mesh.indices.length > 0, "OBJ: indices buffer should not be empty");
  console.log(`✓ OBJ: meshes=${result.meshes.length}, verts=${mesh.vertexCount}, indices=${mesh.indexCount}, format=${result.format}`);
}

// GLB (glTF Binary)
async function testGLB() {
  const { parseGLTF } = await import("@downdraft/library-models");
  const data = readFileSync(join(FIXTURES, "models", "Box.glb")).buffer as ArrayBuffer;
  const result = await parseGLTF(data, "Box", true);
  assert(result.meshes.length > 0, `GLB: expected meshes>0, got ${result.meshes.length}`);
  const mesh = result.meshes[0];
  assert(mesh.vertexCount > 0, `GLB: expected vertexCount>0, got ${mesh.vertexCount}`);
  assert(mesh.indexCount > 0, `GLB: expected indexCount>0, got ${mesh.indexCount}`);
  console.log(`✓ GLB: meshes=${result.meshes.length}, verts=${mesh.vertexCount}, indices=${mesh.indexCount}, format=${result.format}`);
}

// STL
async function testSTL() {
  const { parseSTL } = await import("@downdraft/library-models");
  const data = readFileSync(join(FIXTURES, "models", "cube.stl")).buffer as ArrayBuffer;
  const result = parseSTL(data, "cube");
  assert(result.meshes.length > 0, `STL: expected meshes>0, got ${result.meshes.length}`);
  const mesh = result.meshes[0];
  assert(mesh.vertexCount > 0, `STL: expected vertexCount>0, got ${mesh.vertexCount}`);
  assert(mesh.indexCount > 0, `STL: expected indexCount>0, got ${mesh.indexCount}`);
  console.log(`✓ STL: meshes=${result.meshes.length}, verts=${mesh.vertexCount}, indices=${mesh.indexCount}, format=${result.format}`);
}

// DAE (Collada) — skipped in Bun (requires DOMParser)
async function testDAE() {
  console.log("  ⊘ DAE: skipped (DOMParser not available in Bun runtime)");
}

// PLY (ASCII)
async function testPLYASCII() {
  const { parsePLY } = await import("@downdraft/library-models");
  const data = readFileSync(join(FIXTURES, "models", "tetra.ply")).buffer as ArrayBuffer;
  const result = parsePLY(data, "tetra");
  assert(result.meshes.length > 0, `PLY ASCII: expected meshes>0, got ${result.meshes.length}`);
  const mesh = result.meshes[0];
  assert(mesh.vertexCount === 4, `PLY ASCII: expected vertexCount=4, got ${mesh.vertexCount}`);
  assert(mesh.indexCount > 0, `PLY ASCII: expected indexCount>0, got ${mesh.indexCount}`);
  assert(mesh.vertices.length === 4 * 6, `PLY ASCII: expected vertices.length=24, got ${mesh.vertices.length}`);
  console.log(`✓ PLY (ASCII): meshes=${result.meshes.length}, verts=${mesh.vertexCount}, indices=${mesh.indexCount}, format=${result.format}`);
}

// PLY (Binary)
async function testPLYBinary() {
  const { parsePLY } = await import("@downdraft/library-models");
  const data = readFileSync(join(FIXTURES, "models", "tetra_binary.ply")).buffer as ArrayBuffer;
  const result = parsePLY(data, "tetra_binary");
  assert(result.meshes.length > 0, `PLY Binary: expected meshes>0, got ${result.meshes.length}`);
  const mesh = result.meshes[0];
  assert(mesh.vertexCount === 4, `PLY Binary: expected vertexCount=4, got ${mesh.vertexCount}`);
  assert(mesh.indexCount > 0, `PLY Binary: expected indexCount>0, got ${mesh.indexCount}`);
  console.log(`✓ PLY (Binary): meshes=${result.meshes.length}, verts=${mesh.vertexCount}, indices=${mesh.indexCount}, format=${result.format}`);
}

// 3DS
async function test3DS() {
  const { parse3DS } = await import("@downdraft/library-models");
  const data = readFileSync(join(FIXTURES, "models", "triangle.3ds")).buffer as ArrayBuffer;
  const result = parse3DS(data, "triangle");
  assert(result.meshes.length > 0, `3DS: expected meshes>0, got ${result.meshes.length}`);
  const mesh = result.meshes[0];
  assert(mesh.vertexCount === 3, `3DS: expected vertexCount=3, got ${mesh.vertexCount}`);
  assert(mesh.indexCount === 3, `3DS: expected indexCount=3, got ${mesh.indexCount}`);
  // Check Z-up to Y-up conversion: original (0,0,0) should stay (0,0,0)
  const v0x = mesh.vertices[0], v0y = mesh.vertices[1], v0z = mesh.vertices[2];
  assert(v0x === 0 && v0y === 0 && v0z === 0, `3DS: vertex 0 should be origin, got (${v0x},${v0y},${v0z})`);
  // Original (1,0,0) → Y-up: (1,0,0) → (x,z,-y) = (1,0,0)
  const v1x = mesh.vertices[6], v1y = mesh.vertices[7], v1z = mesh.vertices[8];
  assert(v1x === 1, `3DS: vertex 1 x should be 1, got ${v1x}`);
  // Original (0,1,0) → Y-up: (0,1,0) → (0,0,-1)
  const v2x = mesh.vertices[12], v2y = mesh.vertices[13], v2z = mesh.vertices[14];
  assert(v2x === 0 && v2y === 0 && v2z === -1, `3DS: vertex 2 should be (0,0,-1) after Z-up→Y-up, got (${v2x},${v2y},${v2z})`);
  console.log(`✓ 3DS: meshes=${result.meshes.length}, verts=${mesh.vertexCount}, indices=${mesh.indexCount}, format=${result.format}`);
}

// glTF extensions
async function testGLTFExtensions() {
  const { getSupportedExtensions, isExtensionSupported, processMaterialExtensions } = await import("@downdraft/library-models");
  const supported = getSupportedExtensions();
  assert(supported.length >= 5, `glTF ext: expected >=5 supported, got ${supported.length}`);
  assert(isExtensionSupported("KHR_materials_unlit"), "glTF ext: KHR_materials_unlit should be supported");
  assert(!isExtensionSupported("KHR_nonexistent"), "glTF ext: KHR_nonexistent should not be supported");

  // Test unlit material extension
  const unlitMat = processMaterialExtensions(
    { name: "test", baseColor: [1, 0, 0, 1], metallic: 0.5, roughness: 0.5 },
    { KHR_materials_unlit: {} },
  );
  assert(unlitMat.metallic === 0, `glTF ext: unlit metallic should be 0, got ${unlitMat.metallic}`);
  assert(unlitMat.roughness === 1, `glTF ext: unlit roughness should be 1, got ${unlitMat.roughness}`);

  // Test emissive strength
  const emissiveMat = processMaterialExtensions(
    { name: "test", baseColor: [1, 1, 1, 1], metallic: 0, roughness: 1, emissiveColor: [0.5, 0.5, 0.5] },
    { KHR_materials_emissive_strength: { emissiveStrength: 2.0 } },
  );
  assert(emissiveMat.emissiveColor?.[0] === 1.0, `glTF ext: emissive R should be 1.0, got ${emissiveMat.emissiveColor?.[0]}`);

  console.log(`✓ glTF Extensions: ${supported.length} supported, unlit + emissive_strength verified`);
}

// ─── Format Detection ──────────────────────────────────────────────────────

async function testFormatDetection() {
  const { detectFormat } = await import("@downdraft/library-models");
  assert(detectFormat("model.obj") === "obj", "detectFormat: .obj should detect obj");
  assert(detectFormat("model.gltf") === "gltf", "detectFormat: .gltf should detect gltf");
  assert(detectFormat("model.glb") === "glb", "detectFormat: .glb should detect glb");
  assert(detectFormat("model.fbx") === "fbx", "detectFormat: .fbx should detect fbx");
  assert(detectFormat("model.dae") === "dae", "detectFormat: .dae should detect dae");
  assert(detectFormat("model.stl") === "stl", "detectFormat: .stl should detect stl");
  assert(detectFormat("model.ply") === "ply", "detectFormat: .ply should detect ply");
  assert(detectFormat("model.3ds") === "3ds", "detectFormat: .3ds should detect 3ds");
  assert(detectFormat("model.unknown") === null, "detectFormat: .unknown should return null");
  console.log("✓ Format Detection: all 8 formats + null case verified");
}

// ─── Texture Format Detection ──────────────────────────────────────────────

async function testTextureFormatDetection() {
  const { detectTextureFormat } = await import("../packages/core/src/assets/loader-texture");
  assert(detectTextureFormat("tex.png") === "png", "detectTextureFormat: .png");
  assert(detectTextureFormat("tex.webp") === "webp", "detectTextureFormat: .webp");
  assert(detectTextureFormat("tex.ktx2") === "ktx2", "detectTextureFormat: .ktx2");
  assert(detectTextureFormat("tex.dds") === "dds", "detectTextureFormat: .dds");
  assert(detectTextureFormat("tex.hdr") === "hdr", "detectTextureFormat: .hdr");
  assert(detectTextureFormat("tex.exr") === "exr", "detectTextureFormat: .exr");
  assert(detectTextureFormat("tex.xyz") === "unknown", "detectTextureFormat: .xyz should be unknown");
  console.log("✓ Texture Format Detection: all 6 formats + unknown case verified");
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Asset Pipeline Loader Tests");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const tests: { name: string; fn: () => Promise<void> }[] = [
    // Texture loaders
    { name: "DDS", fn: testDDS },
    { name: "KTX2", fn: testKTX2 },
    { name: "HDR", fn: testHDR },
    // Model loaders
    { name: "OBJ", fn: testOBJ },
    { name: "GLB", fn: testGLB },
    { name: "STL", fn: testSTL },
    { name: "DAE", fn: testDAE },
    { name: "PLY (ASCII)", fn: testPLYASCII },
    { name: "PLY (Binary)", fn: testPLYBinary },
    { name: "3DS", fn: test3DS },
    // Extensions
    { name: "glTF Extensions", fn: testGLTFExtensions },
    // Format detection
    { name: "Model Format Detection", fn: testFormatDetection },
    { name: "Texture Format Detection", fn: testTextureFormatDetection },
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
}

main();
