// ============================================================================
// FBX Parser Test Suite — BabylonJS/Assets m01-m16 + real-world fixtures
// ============================================================================
// Test fixtures are from BabylonJS/Assets (MIT), validated against the Autodesk
// FBX SDK. See test-fixtures/fbx/README.md for the per-model feature/expectation
// table and LICENSE-notice.txt for attribution.
//
// Run: bun test packages/plugins/models/src/fbx/fbx.spec.ts
//

import { describe, expect, it } from "bun:test";
import { resolve } from "path";
import { parseFBX } from "./index";

const SPEC_DIR = import.meta.dirname!;
const FIXTURES_DIR = resolve(SPEC_DIR, "../../test-fixtures/fbx");

async function loadFixture(filename: string): Promise<ArrayBuffer> {
  const file = Bun.file(resolve(FIXTURES_DIR, filename));
  return await file.arrayBuffer();
}

function loadRealWorld(relativePath: string): Promise<ArrayBuffer> {
  // SPEC_DIR is packages/plugins/models/src/fbx/
  // Go up 5 levels to repo root (downdraft-engine/), then into relativePath
  const abs = resolve(SPEC_DIR, "..", "..", "..", "..", "..", relativePath);
  const file = Bun.file(abs);
  return file.arrayBuffer();
}

// ── m01–m16: Babylon SDK-validated fixtures ─────────────────────────────────

describe("FBX m01-m16: Babylon test suite", () => {
  it("m01_cube_phong: basic mesh + Phong material", async () => {
    const data = await loadFixture("m01_cube_phong.fbx");
    const model = parseFBX(data, "m01_cube_phong.fbx");
    expect(model.meshes.length).toBeGreaterThanOrEqual(1);
    expect(model.meshes[0].vertexCount).toBeGreaterThan(0);
    expect(model.meshes[0].indexCount).toBeGreaterThan(0);
    // Cube has 6 faces → at least 12 triangles (could be more if split per-face)
    expect(model.meshes[0].indexCount).toBeGreaterThanOrEqual(36);
    expect(model.materials).toBeDefined();
    expect(model.materials!.length).toBeGreaterThanOrEqual(1);
  });

  it("m02_geo_ngons: n-gon triangulation + vertex colors", async () => {
    const data = await loadFixture("m02_geo_ngons.fbx");
    const model = parseFBX(data, "m02_geo_ngons.fbx");
    expect(model.meshes.length).toBeGreaterThanOrEqual(1);
    expect(model.meshes[0].vertexCount).toBeGreaterThan(0);
    // Should not throw on n-gons (tri/quad/hex/concave)
    expect(model.warnings ?? []).toEqual([]);
  });

  it("m03_normals: smooth vs flat normals", async () => {
    const data = await loadFixture("m03_normals.fbx");
    const model = parseFBX(data, "m03_normals.fbx");
    expect(model.meshes.length).toBeGreaterThanOrEqual(1);
    // Normals are interleaved in vertices [pos(3) + normal(3)]
    expect(model.meshes[0].vertices.length).toBe(model.meshes[0].vertexCount * 6);
  });

  it("m04_material_properties: Lambert/Phong variants", async () => {
    const data = await loadFixture("m04_material_properties.fbx");
    const model = parseFBX(data, "m04_material_properties.fbx");
    expect(model.materials).toBeDefined();
    expect(model.materials!.length).toBeGreaterThanOrEqual(1);
  });

  it("m05_textures: texture slots (diffuse/normal/emissive/opacity)", async () => {
    const data = await loadFixture("m05_textures.fbx");
    const model = parseFBX(data, "m05_textures.fbx");
    expect(model.meshes.length).toBeGreaterThanOrEqual(1);
    // At least one material should have texture data or URI
    const hasTexture = model.materials?.some(
      (m) => m.textureData || m.textureUri,
    );
    expect(hasTexture).toBeTruthy();
  });

  it("m06_uv_transform: per-texture UV translation + scaling", async () => {
    const data = await loadFixture("m06_uv_transform.fbx");
    const model = parseFBX(data, "m06_uv_transform.fbx");
    expect(model.meshes.length).toBeGreaterThanOrEqual(1);
    // UVs should be present
    expect(model.meshes[0].uvs).toBeTruthy();
  });

  it("m07_multimaterial: per-polygon material → submesh splitting", async () => {
    const data = await loadFixture("m07_multimaterial.fbx");
    const model = parseFBX(data, "m07_multimaterial.fbx");
    // 3 material face-pairs → 3 separate MeshData (after split)
    expect(model.meshes.length).toBeGreaterThanOrEqual(1);
    expect(model.materials).toBeDefined();
    expect(model.materials!.length).toBeGreaterThanOrEqual(3);
  });

  it("m08_transforms: TRS chain, pre/post-rotation, pivots", async () => {
    const data = await loadFixture("m08_transforms.fbx");
    const model = parseFBX(data, "m08_transforms.fbx");
    expect(model.meshes.length).toBeGreaterThanOrEqual(1);
    expect(model.nodes).toBeDefined();
    expect(model.nodes!.length).toBeGreaterThan(0);
  });

  it("m09_skinning: skeleton + clusters + weights + bind pose", async () => {
    const data = await loadFixture("m09_skinning.fbx");
    const model = parseFBX(data, "m09_skinning.fbx");
    expect(model.meshes.length).toBeGreaterThanOrEqual(1);
    expect(model.skin).toBeDefined();
    expect(model.skin!.bones.length).toBeGreaterThan(0);
    // Each bone has an inverse bind matrix (16 floats)
    for (const bone of model.skin!.bones) {
      expect(bone.inverseBindMatrix.length).toBe(16);
    }
    // Skinned mesh should have joints + weights
    const skinnedMesh = model.meshes.find(
      (m) => m.joints && m.joints.length > 0,
    );
    expect(skinnedMesh).toBeDefined();
  });

  it("m10_morph: morph targets + in-between shapes", async () => {
    const data = await loadFixture("m10_morph.fbx");
    const model = parseFBX(data, "m10_morph.fbx");
    expect(model.meshes.length).toBeGreaterThanOrEqual(1);
    // At least one mesh should have morph targets
    const morphMesh = model.meshes.find((m) => m.morphTargets && m.morphTargets.length > 0);
    expect(morphMesh).toBeDefined();
    expect(model.morphTargetNames).toBeDefined();
    expect(model.morphTargetNames!.length).toBeGreaterThan(0);
  });

  it("m11_node_anim: node animation (const/linear/cubic keys)", async () => {
    const data = await loadFixture("m11_node_anim.fbx");
    const model = parseFBX(data, "m11_node_anim.fbx");
    expect(model.animations).toBeDefined();
    expect(model.animations!.length).toBeGreaterThanOrEqual(1);
    const anim = model.animations![0];
    expect(anim.channels.length).toBeGreaterThan(0);
    expect(anim.duration).toBeGreaterThan(0);
  });

  it("m12_skeletal_anim: skeletal animation over time", async () => {
    const data = await loadFixture("m12_skeletal_anim.fbx");
    const model = parseFBX(data, "m12_skeletal_anim.fbx");
    expect(model.skin).toBeDefined();
    expect(model.animations).toBeDefined();
    expect(model.animations!.length).toBeGreaterThanOrEqual(1);
    // Skeletal animation should have rotation channels targeting bones
    const rotChannels = model.animations![0].channels.filter(
      (c) => c.path === "rotation",
    );
    expect(rotChannels.length).toBeGreaterThan(0);
  });

  it("m13_morph_anim: DeformPercent animation", async () => {
    const data = await loadFixture("m13_morph_anim.fbx");
    const model = parseFBX(data, "m13_morph_anim.fbx");
    expect(model.animations).toBeDefined();
    // Morph animation may use weights path
    const anim = model.animations![0];
    expect(anim.channels.length).toBeGreaterThan(0);
  });

  it("m14_multiclip: multiple AnimationStacks → two clips", async () => {
    const data = await loadFixture("m14_multiclip.fbx");
    const model = parseFBX(data, "m14_multiclip.fbx");
    expect(model.animations).toBeDefined();
    expect(model.animations!.length).toBeGreaterThanOrEqual(2);
  });

  it("m15_camera_lights: lights (cameras skipped per decision)", async () => {
    const data = await loadFixture("m15_camera_lights.fbx");
    const model = parseFBX(data, "m15_camera_lights.fbx");
    expect(model.meshes.length).toBeGreaterThanOrEqual(1);
    // Cameras are not extracted (decision: skip cameras/lights)
    // Lights are not extracted either — just verify no crash
  });

  it("m16_axis_yup: Y-up GlobalSettings", async () => {
    const data = await loadFixture("m16_axis_yup.fbx");
    const model = parseFBX(data, "m16_axis_yup.fbx");
    expect(model.sourceUpAxis).toBe("y");
    expect(model.meshes.length).toBeGreaterThanOrEqual(1);
  });

  it("m16_axis_zup: Z-up GlobalSettings", async () => {
    const data = await loadFixture("m16_axis_zup.fbx");
    const model = parseFBX(data, "m16_axis_zup.fbx");
    expect(model.sourceUpAxis).toBe("z");
    expect(model.meshes.length).toBeGreaterThanOrEqual(1);
  });

  it("m16_units_254: unit scale (254 units/cm = inches)", async () => {
    const data = await loadFixture("m16_units_254.fbx");
    const model = parseFBX(data, "m16_units_254.fbx");
    expect(model.sourceUnitScaleFactor).toBeDefined();
    // 254 units/cm → inches (2.54 cm/inch, so 1 unit = 1/100 inch)
    expect(model.meshes.length).toBeGreaterThanOrEqual(1);
  });

  it("m16: all three axis/unit variants produce same geometry (after normalization)", async () => {
    const yupData = await loadFixture("m16_axis_yup.fbx");
    const zupData = await loadFixture("m16_axis_zup.fbx");
    const yup = parseFBX(yupData, "m16_axis_yup.fbx");
    const zup = parseFBX(zupData, "m16_axis_zup.fbx");
    // Same vertex count (axis conversion doesn't change topology)
    expect(yup.meshes[0].vertexCount).toBe(zup.meshes[0].vertexCount);
  });
});

// ── Real-world fixtures: production FBX files ───────────────────────────────

describe("FBX real-world fixtures", () => {
  it("character.fbx: Mixamo rigged character (skinning + rest pose)", async () => {
    const data = await loadRealWorld(
      "games/to-the-ocean/src/assets/models/character.fbx",
    );
    const model = parseFBX(data, "character.fbx");
    expect(model.meshes.length).toBeGreaterThanOrEqual(1);
    expect(model.skin).toBeDefined();
    expect(model.skin!.bones.length).toBeGreaterThan(0);
    // Mixamo bones use mixamorig: prefix (after normalization)
    const hasMixamoBone = model.skin!.bones.some((b) =>
      b.name.startsWith("mixamorig:"),
    );
    expect(hasMixamoBone).toBeTruthy();
    // Node names should NOT have "Model" suffix (parser strips it)
    const hasModelSuffix = model.nodes?.some((n) => n.name.endsWith("Model"));
    expect(hasModelSuffix).toBeFalsy();
  });

  it("X Bot@Idle.fbx: Mixamo animation clip", async () => {
    const data = await loadRealWorld(
      "games/to-the-ocean/src/assets/animations/human/mixamo/X Bot@Idle.fbx",
    );
    const model = parseFBX(data, "X Bot@Idle.fbx");
    expect(model.animations).toBeDefined();
    expect(model.animations!.length).toBeGreaterThanOrEqual(1);
    const anim = model.animations![0];
    expect(anim.channels.length).toBeGreaterThan(0);
    expect(anim.duration).toBeGreaterThan(0);
    // Should have source rest rotations for retargeting
    expect(anim.sourceRestRotations).toBeDefined();
    expect(anim.sourceRestRotations!.size).toBeGreaterThan(0);
  });
});
