import { MeshBuilder } from "./builder.ts";

describe("MeshBuilder", () => {
  it("should build a cube with 24 vertices and 36 indices", () => {
    const mesh = MeshBuilder.cube(1);
    expect(mesh.vertexCount).toBe(24);
    expect(mesh.indexCount).toBe(36);
  });

  it("should build a plane with correct vertex count", () => {
    const mesh = MeshBuilder.plane(2, 2, 1);
    expect(mesh.vertexCount).toBe(4);
    expect(mesh.indexCount).toBe(6);
  });

  it("should build a sphere with correct vertex count", () => {
    const mesh = MeshBuilder.sphere(0.5, 16, 12);
    expect(mesh.vertexCount).toBe((16 + 1) * (12 + 1));
  });

  it("should use Uint16Array for small meshes", () => {
    const mesh = MeshBuilder.cube(1);
    expect(mesh.indices instanceof Uint16Array).toBe(true);
  });

  it("should use Uint32Array for large meshes", () => {
    const builder = new MeshBuilder();
    for (let i = 0; i < 70000; i++) {
      builder.addVertex([0, 0, 0]);
    }
    // Add enough indices to exceed Uint16 range
    for (let i = 0; i < 65536; i++) {
      builder.addTriangle(0, 1, 2);
    }
    const mesh = builder.build();
    expect(mesh.indices instanceof Uint32Array).toBe(true);
  });
});
