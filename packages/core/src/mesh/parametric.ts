import { MeshBuilder, type MeshData } from "./builder.ts";

export function cylinder(
  radiusTop: number = 0.5,
  radiusBottom: number = 0.5,
  height: number = 1,
  radialSegments: number = 16,
  heightSegments: number = 1,
): MeshData {
  const builder = new MeshBuilder();
  const half = height / 2;

  for (let y = 0; y <= heightSegments; y++) {
    const v = y / heightSegments;
    const yf = -half + v * height;
    const r = radiusBottom + (radiusTop - radiusBottom) * v;

    for (let x = 0; x <= radialSegments; x++) {
      const u = x / radialSegments;
      const theta = u * Math.PI * 2;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const px = r * cos;
      const pz = r * sin;

      const dr = radiusTop - radiusBottom;
      const ny = Math.cos(Math.atan2(dr, height));
      const nr = Math.sin(Math.atan2(dr, height));
      const nx = nr * cos;
      const nz = nr * sin;

      builder.addVertex([px, yf, pz], [nx, ny, nz], [u, v]);
    }
  }

  for (let y = 0; y < heightSegments; y++) {
    for (let x = 0; x < radialSegments; x++) {
      const a = y * (radialSegments + 1) + x;
      const b = a + 1;
      const c = a + (radialSegments + 1);
      const d = c + 1;
      builder.addQuad(a, b, d, c);
    }
  }

  const sideVertexCount = (heightSegments + 1) * (radialSegments + 1);

  if (radiusBottom > 0) {
    const baseStart = sideVertexCount;
    for (let x = 0; x <= radialSegments; x++) {
      const u = x / radialSegments;
      const theta = u * Math.PI * 2;
      builder.addVertex(
        [radiusBottom * Math.cos(theta), -half, radiusBottom * Math.sin(theta)],
        [0, -1, 0],
        [u, 1],
      );
    }
    const centerBottom = builder.addVertex([0, -half, 0], [0, -1, 0], [0.5, 0]);
    for (let x = 0; x < radialSegments; x++) {
      const a = baseStart + x;
      const b = baseStart + x + 1;
      builder.addTriangle(centerBottom, a, b);
    }
  }

  if (radiusTop > 0) {
    const topStart = sideVertexCount + (radiusBottom > 0 ? radialSegments + 2 : 0);
    for (let x = 0; x <= radialSegments; x++) {
      const u = x / radialSegments;
      const theta = u * Math.PI * 2;
      builder.addVertex(
        [radiusTop * Math.cos(theta), half, radiusTop * Math.sin(theta)],
        [0, 1, 0],
        [u, 0],
      );
    }
    const centerTop = builder.addVertex([0, half, 0], [0, 1, 0], [0.5, 1]);
    for (let x = 0; x < radialSegments; x++) {
      const a = topStart + x;
      const b = topStart + x + 1;
      builder.addTriangle(centerTop, b, a);
    }
  }

  return builder.build();
}

export function cone(
  radius: number = 0.5,
  height: number = 1,
  radialSegments: number = 16,
): MeshData {
  return cylinder(0, radius, height, radialSegments, 1);
}

export function torus(
  radius: number = 0.5,
  tube: number = 0.15,
  radialSegments: number = 16,
  tubularSegments: number = 32,
): MeshData {
  const builder = new MeshBuilder();

  for (let j = 0; j <= radialSegments; j++) {
    const v = j / radialSegments;
    const phi = v * Math.PI * 2;
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);

    for (let i = 0; i <= tubularSegments; i++) {
      const u = i / tubularSegments;
      const theta = u * Math.PI * 2;
      const cosTheta = Math.cos(theta);
      const sinTheta = Math.sin(theta);

      const cx = (radius + tube * cosPhi) * cosTheta;
      const cy = tube * sinPhi;
      const cz = (radius + tube * cosPhi) * sinTheta;

      const nx = cosPhi * cosTheta;
      const ny = sinPhi;
      const nz = cosPhi * sinTheta;

      builder.addVertex([cx, cy, cz], [nx, ny, nz], [u, v]);
    }
  }

  for (let j = 0; j < radialSegments; j++) {
    for (let i = 0; i < tubularSegments; i++) {
      const a = j * (tubularSegments + 1) + i;
      const b = a + 1;
      const c = a + (tubularSegments + 1);
      const d = c + 1;
      builder.addQuad(a, b, d, c);
    }
  }

  return builder.build();
}

export function disc(
  radius: number = 0.5,
  tessellation: number = 16,
  side: "top" | "bottom" | "double" = "top",
): MeshData {
  const builder = new MeshBuilder();
  const normal: [number, number, number] = side === "bottom" ? [0, -1, 0] : [0, 1, 0];

  const center = builder.addVertex([0, 0, 0], normal, [0.5, 0.5]);

  for (let i = 0; i <= tessellation; i++) {
    const u = i / tessellation;
    const theta = u * Math.PI * 2;
    builder.addVertex(
      [radius * Math.cos(theta), 0, radius * Math.sin(theta)],
      normal,
      [0.5 + 0.5 * Math.cos(theta), 0.5 + 0.5 * Math.sin(theta)],
    );
  }

  for (let i = 0; i < tessellation; i++) {
    const a = center;
    const b = 1 + i;
    const c = 1 + i + 1;
    if (side === "bottom") {
      builder.addTriangle(a, c, b);
    } else {
      builder.addTriangle(a, b, c);
    }
  }

  if (side === "double") {
    const bottomStart = 1 + (tessellation + 1) + 1;
    const centerBottom = builder.addVertex([0, 0, 0], [0, -1, 0], [0.5, 0.5]);
    for (let i = 0; i <= tessellation; i++) {
      const u = i / tessellation;
      const theta = u * Math.PI * 2;
      builder.addVertex(
        [radius * Math.cos(theta), 0, radius * Math.sin(theta)],
        [0, -1, 0],
        [0.5 + 0.5 * Math.cos(theta), 0.5 + 0.5 * Math.sin(theta)],
      );
    }
    for (let i = 0; i < tessellation; i++) {
      builder.addTriangle(centerBottom, bottomStart + 1 + i + 1, bottomStart + 1 + i);
    }
  }

  return builder.build();
}

export function ribbon(
  paths: [number, number, number][][],
  closeArray: boolean = false,
  closePath: boolean = false,
): MeshData {
  const builder = new MeshBuilder();
  const pathCount = paths.length;
  const pointCount = paths[0].length;

  for (let p = 0; p < pathCount; p++) {
    for (let i = 0; i < pointCount; i++) {
      const pos = paths[p][i];
      const u = i / (pointCount - 1);
      const v = p / (pathCount - 1);
      builder.addVertex(pos, [0, 1, 0], [u, v]);
    }
  }

  for (let p = 0; p < pathCount - 1; p++) {
    for (let i = 0; i < pointCount - 1; i++) {
      const a = p * pointCount + i;
      const b = a + 1;
      const c = a + pointCount;
      const d = c + 1;
      builder.addQuad(a, b, d, c);
    }
  }

  if (closeArray) {
    for (let i = 0; i < pointCount - 1; i++) {
      const a = (pathCount - 1) * pointCount + i;
      const b = a + 1;
      const c = i;
      const d = c + 1;
      builder.addQuad(a, b, d, c);
    }
  }

  if (closePath) {
    for (let p = 0; p < pathCount - 1; p++) {
      const a = p * pointCount + pointCount - 1;
      const b = p * pointCount;
      const c = a + pointCount;
      const d = c - pointCount + 1;
      builder.addQuad(a, b, d, c);
    }
  }

  return builder.build();
}

export interface TubePathPoint {
  position: [number, number, number];
  tangent?: [number, number, number];
  normal?: [number, number, number];
}

export function tube(
  path: TubePathPoint[],
  radius: number = 0.1,
  tessellation: number = 8,
  cap: boolean = true,
): MeshData {
  const builder = new MeshBuilder();
  const segments = path.length;
  if (segments < 2) return builder.build();

  const tangents: [number, number, number][] = [];
  const normals: [number, number, number][] = [];
  const binormals: [number, number, number][] = [];

  for (let i = 0; i < segments; i++) {
    let tx: number, ty: number, tz: number;
    if (i === 0) {
      tx = path[1].position[0] - path[0].position[0];
      ty = path[1].position[1] - path[0].position[1];
      tz = path[1].position[2] - path[0].position[2];
    } else if (i === segments - 1) {
      tx = path[i].position[0] - path[i - 1].position[0];
      ty = path[i].position[1] - path[i - 1].position[1];
      tz = path[i].position[2] - path[i - 1].position[2];
    } else {
      tx = path[i + 1].position[0] - path[i - 1].position[0];
      ty = path[i + 1].position[1] - path[i - 1].position[1];
      tz = path[i + 1].position[2] - path[i - 1].position[2];
    }
    const len = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
    tx /= len; ty /= len; tz /= len;
    tangents.push([tx, ty, tz]);
  }

  let nx = 0, ny = 0, nz = 1;
  const t0 = tangents[0];
  if (Math.abs(t0[0]) > 0.001 || Math.abs(t0[2]) > 0.001) {
    nx = -t0[2];
    nz = t0[0];
    const nlen = Math.sqrt(nx * nx + nz * nz);
    nx /= nlen; nz /= nlen;
    ny = 0;
  } else {
    nx = 1; ny = 0; nz = 0;
  }
  normals.push([nx, ny, nz]);

  for (let i = 1; i < segments; i++) {
    const t = tangents[i];
    const prev = normals[i - 1];
    const bx = prev[1] * t[2] - prev[2] * t[1];
    const by = prev[2] * t[0] - prev[0] * t[2];
    const bz = prev[0] * t[1] - prev[1] * t[0];
    const blen = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
    const bnx = bx / blen, bny = by / blen, bnz = bz / blen;
    binormals.push([bnx, bny, bnz]);

    const nx2 = bny * t[2] - bnz * t[1];
    const ny2 = bnz * t[0] - bnx * t[2];
    const nz2 = bnx * t[1] - bny * t[0];
    const nlen = Math.sqrt(nx2 * nx2 + ny2 * ny2 + nz2 * nz2) || 1;
    normals.push([nx2 / nlen, ny2 / nlen, nz2 / nlen]);
  }
  binormals.push([0, 0, 0]);
  const lastB = binormals[binormals.length - 2];
  const lastT = tangents[tangents.length - 1];
  binormals[binormals.length - 1] = [
    normals[normals.length - 1][1] * lastT[2] - normals[normals.length - 1][2] * lastT[1],
    normals[normals.length - 1][2] * lastT[0] - normals[normals.length - 1][0] * lastT[2],
    normals[normals.length - 1][0] * lastT[1] - normals[normals.length - 1][1] * lastT[0],
  ];

  for (let i = 0; i < segments; i++) {
    const pos = path[i].position;
    const n = normals[i];
    const b = binormals[i];
    for (let j = 0; j <= tessellation; j++) {
      const u = j / tessellation;
      const theta = u * Math.PI * 2;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const px = pos[0] + radius * (cos * n[0] + sin * b[0]);
      const py = pos[1] + radius * (cos * n[1] + sin * b[1]);
      const pz = pos[2] + radius * (cos * n[2] + sin * b[2]);
      const nx2 = cos * n[0] + sin * b[0];
      const ny2 = cos * n[1] + sin * b[1];
      const nz2 = cos * n[2] + sin * b[2];
      const v = i / (segments - 1);
      builder.addVertex([px, py, pz], [nx2, ny2, nz2], [u, v]);
    }
  }

  for (let i = 0; i < segments - 1; i++) {
    for (let j = 0; j < tessellation; j++) {
      const a = i * (tessellation + 1) + j;
      const b = a + 1;
      const c = a + (tessellation + 1);
      const d = c + 1;
      builder.addQuad(a, b, d, c);
    }
  }

  if (cap) {
    const sideVertexCount = segments * (tessellation + 1);

    const startCapStart = sideVertexCount;
    const capCenter0 = builder.addVertex(path[0].position, tangents[0], [0.5, 0]);
    for (let j = 0; j <= tessellation; j++) {
      const u = j / tessellation;
      const theta = u * Math.PI * 2;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const n = normals[0];
      const b = binormals[0];
      builder.addVertex(
        [
          path[0].position[0] + radius * (cos * n[0] + sin * b[0]),
          path[0].position[1] + radius * (cos * n[1] + sin * b[1]),
          path[0].position[2] + radius * (cos * n[2] + sin * b[2]),
        ],
        tangents[0],
        [0.5 + 0.5 * cos, 0.5 + 0.5 * sin],
      );
    }
    for (let j = 0; j < tessellation; j++) {
      builder.addTriangle(capCenter0, startCapStart + 1 + j, startCapStart + 1 + j + 1);
    }

    const endCapStart = sideVertexCount + 1 + (tessellation + 1);
    const capCenter1 = builder.addVertex(path[segments - 1].position, [
      -tangents[segments - 1][0],
      -tangents[segments - 1][1],
      -tangents[segments - 1][2],
    ], [0.5, 1]);
    const lastN = normals[segments - 1];
    const lastB = binormals[segments - 1];
    for (let j = 0; j <= tessellation; j++) {
      const u = j / tessellation;
      const theta = u * Math.PI * 2;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      builder.addVertex(
        [
          path[segments - 1].position[0] + radius * (cos * lastN[0] + sin * lastB[0]),
          path[segments - 1].position[1] + radius * (cos * lastN[1] + sin * lastB[1]),
          path[segments - 1].position[2] + radius * (cos * lastN[2] + sin * lastB[2]),
        ],
        [-tangents[segments - 1][0], -tangents[segments - 1][1], -tangents[segments - 1][2]],
        [0.5 + 0.5 * cos, 0.5 + 0.5 * sin],
      );
    }
    for (let j = 0; j < tessellation; j++) {
      builder.addTriangle(capCenter1, endCapStart + 1 + j + 1, endCapStart + 1 + j);
    }
  }

  return builder.build();
}

export function lathe(
  points: [number, number][],
  segments: number = 16,
  radius: number = 1,
): MeshData {
  const builder = new MeshBuilder();
  const pointCount = points.length;

  for (let s = 0; s <= segments; s++) {
    const u = s / segments;
    const theta = u * Math.PI * 2;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);

    for (let p = 0; p < pointCount; p++) {
      const [r, y] = points[p];
      const rr = r * radius;
      const px = rr * cos;
      const pz = rr * sin;

      let nx = 0, ny = 0;
      if (p > 0 && p < pointCount - 1) {
        const dr = points[p + 1][0] - points[p - 1][0];
        const dy = points[p + 1][1] - points[p - 1][1];
        const len = Math.sqrt(dr * dr + dy * dy) || 1;
        nx = dy / len;
        ny = -dr / len;
      } else if (p === 0 && pointCount > 1) {
        const dr = points[1][0] - points[0][0];
        const dy = points[1][1] - points[0][1];
        const len = Math.sqrt(dr * dr + dy * dy) || 1;
        nx = dy / len;
        ny = -dr / len;
      } else if (p === pointCount - 1 && pointCount > 1) {
        const dr = points[p][0] - points[p - 1][0];
        const dy = points[p][1] - points[p - 1][1];
        const len = Math.sqrt(dr * dr + dy * dy) || 1;
        nx = dy / len;
        ny = -dr / len;
      }

      const v = p / (pointCount - 1);
      builder.addVertex([px, y, pz], [nx * cos, ny, nx * sin], [u, v]);
    }
  }

  for (let s = 0; s < segments; s++) {
    for (let p = 0; p < pointCount - 1; p++) {
      const a = s * pointCount + p;
      const b = a + 1;
      const c = a + pointCount;
      const d = c + 1;
      builder.addQuad(a, b, d, c);
    }
  }

  return builder.build();
}

export function tessellatedPlane(
  width: number = 1,
  height: number = 1,
  subdivisionsX: number = 1,
  subdivisionsY: number = 1,
): MeshData {
  const builder = new MeshBuilder();
  const hw = width / 2;
  const hh = height / 2;
  const sw = width / subdivisionsX;
  const sh = height / subdivisionsY;

  for (let y = 0; y <= subdivisionsY; y++) {
    for (let x = 0; x <= subdivisionsX; x++) {
      const px = -hw + x * sw;
      const py = -hh + y * sh;
      const u = x / subdivisionsX;
      const v = y / subdivisionsY;
      builder.addVertex([px, 0, py], [0, 1, 0], [u, v]);
    }
  }

  for (let y = 0; y < subdivisionsY; y++) {
    for (let x = 0; x < subdivisionsX; x++) {
      const a = y * (subdivisionsX + 1) + x;
      const b = a + 1;
      const c = a + (subdivisionsX + 1);
      const d = c + 1;
      builder.addQuad(a, b, d, c);
    }
  }

  return builder.build();
}
