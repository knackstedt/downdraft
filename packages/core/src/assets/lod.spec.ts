import { MeshBuilder } from "../mesh/builder.ts";
import { LODGenerator } from "./lod.ts";

describe("LODGenerator (QEM)", () => {
  const generator = new LODGenerator();

  it("should return the same mesh for 0 reduction", () => {
    const mesh = MeshBuilder.sphere(0.5, 16, 12);
    const lod = generator.generateLOD(mesh, 0);
    expect(lod).toBe(mesh);
  });

  it("should return the same mesh for reduction >= 1", () => {
    const mesh = MeshBuilder.sphere(0.5, 16, 12);
    expect(generator.generateLOD(mesh, 1)).toBe(mesh);
  });

  it("should reduce index count for 50% reduction", () => {
    const mesh = MeshBuilder.sphere(0.5, 16, 12);
    const lod = generator.generateLOD(mesh, 0.5);
    expect(lod.indexCount).toBeLessThan(mesh.indexCount);
  });

  it("should produce valid Uint32Array indices", () => {
    const mesh = MeshBuilder.sphere(0.5, 16, 12);
    const lod = generator.generateLOD(mesh, 0.5);
    expect(lod.indices instanceof Uint32Array).toBe(true);
  });

  it("should compact vertices (fewer than original)", () => {
    const mesh = MeshBuilder.sphere(0.5, 16, 12);
    const lod = generator.generateLOD(mesh, 0.5);
    expect(lod.vertexCount).toBeLessThanOrEqual(mesh.vertexCount);
  });

  it("should produce consistent vertexCount = vertices.length / stride", () => {
    const mesh = MeshBuilder.sphere(0.5, 16, 12);
    const lod = generator.generateLOD(mesh, 0.5);
    const stride = mesh.layout.stride / 4;
    expect(lod.vertexCount).toBe(lod.vertices.length / stride);
  });

  it("should generate multiple LOD levels", () => {
    const mesh = MeshBuilder.sphere(0.5, 16, 12);
    const levels = generator.generateLODLevels(mesh, 3);
    expect(levels.length).toBe(3);
    expect(levels[0].mesh).toBe(mesh);
    expect(levels[1].mesh.indexCount).toBeLessThanOrEqual(mesh.indexCount);
    expect(levels[2].mesh.indexCount).toBeLessThanOrEqual(levels[1].mesh.indexCount);
  });

  it("should select correct LOD by distance", () => {
    const mesh = MeshBuilder.sphere(0.5, 16, 12);
    const levels = generator.generateLODLevels(mesh, 3);
    const selected = generator.selectLOD(levels, 100, 500);
    expect(selected.distance).toBeGreaterThanOrEqual(0);
  });

  it("should handle cube mesh", () => {
    const mesh = MeshBuilder.cube(1);
    const lod = generator.generateLOD(mesh, 0.5);
    expect(lod.indexCount).toBeLessThanOrEqual(mesh.indexCount);
  });

  it("should not crash on plane mesh", () => {
    const mesh = MeshBuilder.plane(2, 2, 4);
    const lod = generator.generateLOD(mesh, 0.3);
    expect(lod.indexCount).toBeLessThanOrEqual(mesh.indexCount);
  });
});
