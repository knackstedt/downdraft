import { STANDARD_VERTEX_LAYOUT, type VertexLayout } from "./vertex-layout.ts";

export interface MeshData {
  vertices: Float32Array;
  indices: Uint16Array | Uint32Array;
  layout: VertexLayout;
  vertexCount: number;
  indexCount: number;
}

export class MeshBuilder {
  private vertices: number[] = [];
  private indices: number[] = [];
  private layout: VertexLayout;

  constructor(layout: VertexLayout = STANDARD_VERTEX_LAYOUT) {
    this.layout = layout;
  }

  addVertex(
    pos: [number, number, number],
    normal: [number, number, number] = [0, 1, 0],
    uv: [number, number] = [0, 0],
    color: [number, number, number, number] = [1, 1, 1, 1],
  ): number {
    const idx = this.vertices.length / (this.layout.stride / 4);
    this.vertices.push(
      pos[0], pos[1], pos[2],
      normal[0], normal[1], normal[2],
      uv[0], uv[1],
      color[0], color[1], color[2], color[3],
    );
    return idx;
  }

  addTriangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  addQuad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, b, c, a, c, d);
  }

  build(): MeshData {
    const vertices = new Float32Array(this.vertices);
    const indexCount = this.indices.length;
    const indices = indexCount > 65535
      ? new Uint32Array(this.indices)
      : new Uint16Array(this.indices);
    return {
      vertices,
      indices,
      layout: this.layout,
      vertexCount: vertices.length / (this.layout.stride / 4),
      indexCount,
    };
  }

  static cube(size: number = 1): MeshData {
    const builder = new MeshBuilder();
    const half = size / 2;

    const faces: Array<{
      normal: [number, number, number];
      positions: [[number, number, number], [number, number, number], [number, number, number], [number, number, number]];
    }> = [
      {
        normal: [0, 1, 0],
        positions: [[-half, half, -half], [half, half, -half], [half, half, half], [-half, half, half]],
      },
      {
        normal: [0, -1, 0],
        positions: [[-half, -half, -half], [-half, -half, half], [half, -half, half], [half, -half, -half]],
      },
      {
        normal: [1, 0, 0],
        positions: [[half, -half, -half], [half, -half, half], [half, half, half], [half, half, -half]],
      },
      {
        normal: [-1, 0, 0],
        positions: [[-half, -half, -half], [-half, half, -half], [-half, half, half], [-half, -half, half]],
      },
      {
        normal: [0, 0, 1],
        positions: [[-half, -half, half], [-half, half, half], [half, half, half], [half, -half, half]],
      },
      {
        normal: [0, 0, -1],
        positions: [[-half, -half, -half], [half, -half, -half], [half, half, -half], [-half, half, -half]],
      },
    ];

    const uvs: [[number, number], [number, number], [number, number], [number, number]] = [
      [0, 0], [1, 0], [1, 1], [0, 1],
    ];

    for (let f = 0; f < faces.length; f++) {
      const face = faces[f];
      const color: [number, number, number, number] = [
        0.5 + face.normal[0] * 0.5,
        0.5 + face.normal[1] * 0.5,
        0.5 + face.normal[2] * 0.5,
        1,
      ];
      const base = builder.addVertex(face.positions[0], face.normal, uvs[0], color);
      const v1 = builder.addVertex(face.positions[1], face.normal, uvs[1], color);
      const v2 = builder.addVertex(face.positions[2], face.normal, uvs[2], color);
      const v3 = builder.addVertex(face.positions[3], face.normal, uvs[3], color);
      builder.addQuad(base, v1, v2, v3);
    }

    return builder.build();
  }

  static plane(width: number = 1, depth: number = 1, segments: number = 1): MeshData {
    const builder = new MeshBuilder();
    const hw = width / 2;
    const hd = depth / 2;
    const sw = width / segments;
    const sd = depth / segments;

    for (let z = 0; z <= segments; z++) {
      for (let x = 0; x <= segments; x++) {
        const px = -hw + x * sw;
        const pz = -hd + z * sd;
        const u = x / segments;
        const v = z / segments;
        builder.addVertex([px, 0, pz], [0, 1, 0], [u, v]);
      }
    }

    for (let z = 0; z < segments; z++) {
      for (let x = 0; x < segments; x++) {
        const a = z * (segments + 1) + x;
        const b = a + 1;
        const c = a + (segments + 1);
        const d = c + 1;
        builder.addQuad(a, b, d, c);
      }
    }

    return builder.build();
  }

  static sphere(radius: number = 0.5, widthSegments: number = 16, heightSegments: number = 12): MeshData {
    const builder = new MeshBuilder();

    for (let y = 0; y <= heightSegments; y++) {
      const v = y / heightSegments;
      const phi = v * Math.PI;
      for (let x = 0; x <= widthSegments; x++) {
        const u = x / widthSegments;
        const theta = u * Math.PI * 2;
        const sinPhi = Math.sin(phi);
        const px = radius * sinPhi * Math.cos(theta);
        const py = radius * Math.cos(phi);
        const pz = radius * sinPhi * Math.sin(theta);
        const nx = px / radius;
        const ny = py / radius;
        const nz = pz / radius;
        builder.addVertex([px, py, pz], [nx, ny, nz], [u, v]);
      }
    }

    for (let y = 0; y < heightSegments; y++) {
      for (let x = 0; x < widthSegments; x++) {
        const a = y * (widthSegments + 1) + x;
        const b = a + 1;
        const c = a + (widthSegments + 1);
        const d = c + 1;
        builder.addQuad(a, b, d, c);
      }
    }

    return builder.build();
  }
}
