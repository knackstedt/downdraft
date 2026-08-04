import type { MeshData } from "./builder";

export interface GreasedLinePoint {
  position: [number, number, number];
  color?: [number, number, number, number];
  width?: number;
}

export interface GreasedLineOptions {
  width?: number;
  perVertexWidth?: boolean;
  perVertexColor?: boolean;
  dashEnabled?: boolean;
  dashSize?: number;
  gapSize?: number;
}

export interface GreasedLineData {
  vertices: Float32Array;
  indices: Uint16Array | Uint32Array;
  vertexCount: number;
  indexCount: number;
  pointCount: number;
  hasPerVertexWidth: boolean;
  hasPerVertexColor: boolean;
  hasDash: boolean;
}

const STRIDE = 12;

export function createGreasedLine(
  points: GreasedLinePoint[],
  options: GreasedLineOptions = {},
): GreasedLineData {
  const defaultWidth = options.width ?? 1;
  const perVertexWidth = options.perVertexWidth ?? false;
  const perVertexColor = options.perVertexColor ?? false;
  const dashEnabled = options.dashEnabled ?? false;
  const dashSize = options.dashSize ?? 1;
  const gapSize = options.gapSize ?? 0.5;

  const pointCount = points.length;
  if (pointCount < 2) {
    return { vertices: new Float32Array(0), indices: new Uint16Array(0), vertexCount: 0, indexCount: 0, pointCount: 0, hasPerVertexWidth: perVertexWidth, hasPerVertexColor: perVertexColor, hasDash: dashEnabled };
  }

  const vertexCount = pointCount * 2;
  const vertices = new Float32Array(vertexCount * STRIDE);
  const indexCount = (pointCount - 1) * 6;
  const indices = indexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);

  let dashDist = 0;
  for (let i = 0; i < pointCount; i++) {
    const p = points[i];
    const width = perVertexWidth ? (p.width ?? defaultWidth) : defaultWidth;
    const color = perVertexColor ? (p.color ?? [1, 1, 1, 1]) : [1, 1, 1, 1];

    if (i > 0) {
      const prev = points[i - 1];
      const dx = p.position[0] - prev.position[0];
      const dy = p.position[1] - prev.position[1];
      const dz = p.position[2] - prev.position[2];
      dashDist += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    const dashU = dashEnabled ? dashDist / (dashSize + gapSize) : 0;

    const leftIdx = i * 2;
    const rightIdx = i * 2 + 1;

    const leftOff = leftIdx * STRIDE;
    vertices[leftOff + 0] = p.position[0];
    vertices[leftOff + 1] = p.position[1];
    vertices[leftOff + 2] = p.position[2];
    vertices[leftOff + 3] = -1;
    vertices[leftOff + 4] = width;
    vertices[leftOff + 5] = dashU;
    vertices[leftOff + 6] = 0;
    vertices[leftOff + 7] = color[0];
    vertices[leftOff + 8] = color[1];
    vertices[leftOff + 9] = color[2];
    vertices[leftOff + 10] = color[3];
    vertices[leftOff + 11] = i / (pointCount - 1);

    const rightOff = rightIdx * STRIDE;
    vertices[rightOff + 0] = p.position[0];
    vertices[rightOff + 1] = p.position[1];
    vertices[rightOff + 2] = p.position[2];
    vertices[rightOff + 3] = 1;
    vertices[rightOff + 4] = width;
    vertices[rightOff + 5] = dashU;
    vertices[rightOff + 6] = 1;
    vertices[rightOff + 7] = color[0];
    vertices[rightOff + 8] = color[1];
    vertices[rightOff + 9] = color[2];
    vertices[rightOff + 10] = color[3];
    vertices[rightOff + 11] = i / (pointCount - 1);
  }

  let idx = 0;
  for (let i = 0; i < pointCount - 1; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = (i + 1) * 2;
    const d = (i + 1) * 2 + 1;
    indices[idx++] = a;
    indices[idx++] = c;
    indices[idx++] = b;
    indices[idx++] = b;
    indices[idx++] = c;
    indices[idx++] = d;
  }

  return {
    vertices,
    indices,
    vertexCount,
    indexCount,
    pointCount,
    hasPerVertexWidth: perVertexWidth,
    hasPerVertexColor: perVertexColor,
    hasDash: dashEnabled,
  };
}

export function createGreasedLineMeshData(line: GreasedLineData): MeshData {
  return {
    vertices: line.vertices,
    indices: line.indices,
    layout: {
      attributes: [
        { name: "position", format: "float32x3", offset: 0 },
        { name: "sideOffset", format: "float32", offset: 12 },
        { name: "width", format: "float32", offset: 16 },
        { name: "dashU", format: "float32", offset: 20 },
        { name: "sideV", format: "float32", offset: 24 },
        { name: "color", format: "float32x4", offset: 28 },
        { name: "lineT", format: "float32", offset: 44 },
      ],
      stride: STRIDE * 4,
    },
    vertexCount: line.vertexCount,
    indexCount: line.indexCount,
  };
}
