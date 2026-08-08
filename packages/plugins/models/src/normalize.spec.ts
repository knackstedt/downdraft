import { describe, expect, it } from "bun:test";
import { normalizeModel } from "./normalize";
import { createDefaultImportSettings } from "./sidecar/types";
import type { ModelData } from "./types";

function makeModelData(
  meshes: { vertices: number[]; vertexCount: number }[],
  opts?: Partial<ModelData>,
): ModelData {
  return {
    meshes: meshes.map((m) => ({
      vertices: new Float32Array(m.vertices),
      indices: new Uint16Array([0, 1, 2]),
      vertexCount: m.vertexCount,
      indexCount: 3,
      uvs: null,
      colors: null,
    })),
    name: "test",
    format: "fbx",
    ...opts,
  };
}

describe("normalizeModel", () => {
  it("applies Z-up to Y-up conversion", () => {
    const model = makeModelData([{ vertices: [1, 0, 0, 0, 0, 1], vertexCount: 1 }], {
      sourceUpAxis: "z",
      sourceUnits: "meters",
    });
    const settings = createDefaultImportSettings("z", "meters");
    normalizeModel(model, settings);
    // (1,0,0) Z-up → (1,0,0) Y-up (no change for x-axis)
    expect(model.meshes[0].vertices[0]).toBe(1);
    // But a Z-up point (0,0,1) → (0,1,0) in Y-up
    const model2 = makeModelData([{ vertices: [0, 0, 1, 0, 0, 1], vertexCount: 1 }], {
      sourceUpAxis: "z",
      sourceUnits: "meters",
    });
    normalizeModel(model2, settings);
    expect(model2.meshes[0].vertices[0]).toBe(0);
    expect(model2.meshes[0].vertices[1]).toBe(1); // z→y
    expect(model2.meshes[0].vertices[2] + 0).toBe(0); // -y→-0
  });

  it("applies unit conversion (cm to m)", () => {
    const model = makeModelData([{ vertices: [100, 200, 300, 0, 1, 0], vertexCount: 1 }], {
      sourceUpAxis: "y",
      sourceUnits: "centimeters",
    });
    const settings = createDefaultImportSettings("y", "centimeters");
    normalizeModel(model, settings);
    expect(model.meshes[0].vertices[0]).toBe(1);
    expect(model.meshes[0].vertices[1]).toBe(2);
    expect(model.meshes[0].vertices[2]).toBe(3);
  });

  it("computes bounds", () => {
    const model = makeModelData([{ vertices: [1, 2, 3, 0, 1, 0, -1, 0, 5, 0, 1, 0], vertexCount: 2 }], {
      sourceUpAxis: "y",
      sourceUnits: "meters",
    });
    const settings = createDefaultImportSettings("y", "meters");
    normalizeModel(model, settings);
    expect(model.bounds).toBeDefined();
    expect(model.bounds!.min).toEqual([-1, 0, 3]);
    expect(model.bounds!.max).toEqual([1, 2, 5]);
  });

  it("applies centerToOrigin", () => {
    const model = makeModelData([{ vertices: [2, 4, 6, 0, 1, 0, 0, 2, 4, 0, 1, 0], vertexCount: 2 }], {
      sourceUpAxis: "y",
      sourceUnits: "meters",
    });
    const settings = createDefaultImportSettings("y", "meters");
    settings.centerToOrigin = true;
    normalizeModel(model, settings);
    // Center = (1, 3, 5), so vertices are shifted
    expect(model.meshes[0].vertices[0]).toBe(1); // 2-1
    expect(model.meshes[0].vertices[1]).toBe(1); // 4-3
    expect(model.meshes[0].vertices[2]).toBe(1); // 6-5
  });

  it("applies autoFit", () => {
    const model = makeModelData([{ vertices: [0, 0, 0, 0, 1, 0, 10, 0, 0, 0, 1, 0], vertexCount: 2 }], {
      sourceUpAxis: "y",
      sourceUnits: "meters",
    });
    const settings = createDefaultImportSettings("y", "meters");
    settings.autoFit = 2.0;
    normalizeModel(model, settings);
    // maxDim = 10, scaleFactor = 2/10 = 0.2, so vertex at 10 → 2
    expect(model.meshes[0].vertices[6]).toBeCloseTo(2.0, 6);
  });

  it("applies user scale", () => {
    const model = makeModelData([{ vertices: [1, 2, 3, 0, 1, 0], vertexCount: 1 }], {
      sourceUpAxis: "y",
      sourceUnits: "meters",
    });
    const settings = createDefaultImportSettings("y", "meters");
    settings.scale = 2.0;
    normalizeModel(model, settings);
    expect(model.meshes[0].vertices[0]).toBe(2);
    expect(model.meshes[0].vertices[1]).toBe(4);
    expect(model.meshes[0].vertices[2]).toBe(6);
  });

  it("applies root rotation", () => {
    const model = makeModelData([{ vertices: [1, 0, 0, 0, 0, 1], vertexCount: 1 }], {
      sourceUpAxis: "y",
      sourceUnits: "meters",
    });
    const settings = createDefaultImportSettings("y", "meters");
    // 90° around Y
    const halfAngle = Math.PI / 4;
    settings.rotation = [0, Math.sin(halfAngle), 0, Math.cos(halfAngle)];
    normalizeModel(model, settings);
    // (1,0,0) rotated 90° around Y → (0, 0, -1)
    expect(model.meshes[0].vertices[0]).toBeCloseTo(0, 6);
    expect(model.meshes[0].vertices[2]).toBeCloseTo(-1, 6);
  });

  it("adds normalization warning for extreme scale", () => {
    const model = makeModelData([{ vertices: [0, 0, 0, 0, 1, 0, 200, 0, 0, 0, 1, 0], vertexCount: 2 }], {
      sourceUpAxis: "y",
      sourceUnits: "meters",
    });
    const settings = createDefaultImportSettings("y", "meters");
    normalizeModel(model, settings);
    expect(model.normalizationWarnings).toBeDefined();
    expect(model.normalizationWarnings!.length).toBeGreaterThan(0);
    expect(model.normalizationWarnings![0]).toContain("extreme scale");
  });

  it("does not add warning for normal scale", () => {
    const model = makeModelData([{ vertices: [1, 1, 1, 0, 1, 0], vertexCount: 1 }], {
      sourceUpAxis: "y",
      sourceUnits: "meters",
    });
    const settings = createDefaultImportSettings("y", "meters");
    normalizeModel(model, settings);
    expect(model.normalizationWarnings).toBeUndefined();
  });

  it("bakes node transforms when nodeTransforms is 'apply'", () => {
    const model = makeModelData([{ vertices: [1, 0, 0, 0, 1, 0], vertexCount: 1 }], {
      sourceUpAxis: "y",
      sourceUnits: "meters",
      nodes: [{ name: "root", mesh: 0, translation: [10, 0, 0] }],
    });
    const settings = createDefaultImportSettings("y", "meters");
    settings.nodeTransforms = "apply";
    normalizeModel(model, settings);
    // 1 + 10 = 11
    expect(model.meshes[0].vertices[0]).toBe(11);
  });

  it("skips node transform baking when nodeTransforms is 'ignore'", () => {
    const model = makeModelData([{ vertices: [1, 0, 0, 0, 1, 0], vertexCount: 1 }], {
      sourceUpAxis: "y",
      sourceUnits: "meters",
      nodes: [{ name: "root", mesh: 0, translation: [10, 0, 0] }],
    });
    const settings = createDefaultImportSettings("y", "meters");
    settings.nodeTransforms = "ignore";
    normalizeModel(model, settings);
    // Not baked — vertex stays at 1
    expect(model.meshes[0].vertices[0]).toBe(1);
  });
});
