import { MeshBuilder, type MeshData } from "../../mesh/builder";

export interface DecalProjector {
  position: [number, number, number];
  direction: [number, number, number];
  up: [number, number, number];
  width: number;
  height: number;
  depth: number;
}

export function createDecalMesh(projector: DecalProjector): MeshData {
  const builder = new MeshBuilder();
  const hw = projector.width / 2;
  const hh = projector.height / 2;
  const hd = projector.depth / 2;

  const dir = normalize(projector.direction);
  const up = normalize(projector.up);
  const right = normalize(cross(dir, up));
  const trueUp = cross(right, dir);

  const cx = projector.position[0];
  const cy = projector.position[1];
  const cz = projector.position[2];

  const corners: [number, number, number][] = [
    [cx + (-hw * right[0] - hh * trueUp[0] - hd * dir[0]), cy + (-hw * right[1] - hh * trueUp[1] - hd * dir[1]), cz + (-hw * right[2] - hh * trueUp[2] - hd * dir[2])],
    [cx + ( hw * right[0] - hh * trueUp[0] - hd * dir[0]), cy + ( hw * right[1] - hh * trueUp[1] - hd * dir[1]), cz + ( hw * right[2] - hh * trueUp[2] - hd * dir[2])],
    [cx + ( hw * right[0] + hh * trueUp[0] - hd * dir[0]), cy + ( hw * right[1] + hh * trueUp[1] - hd * dir[1]), cz + ( hw * right[2] + hh * trueUp[2] - hd * dir[2])],
    [cx + (-hw * right[0] + hh * trueUp[0] - hd * dir[0]), cy + (-hw * right[1] + hh * trueUp[1] - hd * dir[1]), cz + (-hw * right[2] + hh * trueUp[2] - hd * dir[2])],
    [cx + (-hw * right[0] - hh * trueUp[0] + hd * dir[0]), cy + (-hw * right[1] - hh * trueUp[1] + hd * dir[1]), cz + (-hw * right[2] - hh * trueUp[2] + hd * dir[2])],
    [cx + ( hw * right[0] - hh * trueUp[0] + hd * dir[0]), cy + ( hw * right[1] - hh * trueUp[1] + hd * dir[1]), cz + ( hw * right[2] - hh * trueUp[2] + hd * dir[2])],
    [cx + ( hw * right[0] + hh * trueUp[0] + hd * dir[0]), cy + ( hw * right[1] + hh * trueUp[1] + hd * dir[1]), cz + ( hw * right[2] + hh * trueUp[2] + hd * dir[2])],
    [cx + (-hw * right[0] + hh * trueUp[0] + hd * dir[0]), cy + (-hw * right[1] + hh * trueUp[1] + hd * dir[1]), cz + (-hw * right[2] + hh * trueUp[2] + hd * dir[2])],
  ];

  const uvs: [[number, number], [number, number], [number, number], [number, number]] = [
    [0, 0], [1, 0], [1, 1], [0, 1],
  ];

  const faces: Array<{ indices: [number, number, number, number]; normal: [number, number, number] }> = [
    { indices: [0, 3, 2, 1], normal: [-dir[0], -dir[1], -dir[2]] },
    { indices: [4, 5, 6, 7], normal: dir },
    { indices: [0, 1, 5, 4], normal: [-right[0], -right[1], -right[2]] },
    { indices: [1, 2, 6, 5], normal: [trueUp[0], trueUp[1], trueUp[2]] },
    { indices: [2, 3, 7, 6], normal: right },
    { indices: [3, 0, 4, 7], normal: [-trueUp[0], -trueUp[1], -trueUp[2]] },
  ];

  faces.forEach((face) => {
    const base = builder.addVertex(corners[face.indices[0]], face.normal, uvs[0]);
    const v1 = builder.addVertex(corners[face.indices[1]], face.normal, uvs[1]);
    const v2 = builder.addVertex(corners[face.indices[2]], face.normal, uvs[2]);
    const v3 = builder.addVertex(corners[face.indices[3]], face.normal, uvs[3]);
    builder.addQuad(base, v1, v2, v3);
  });

  return builder.build();
}

export function computeDecalViewMatrix(projector: DecalProjector): number[] {
  const dir = normalize(projector.direction);
  const up = normalize(projector.up);
  const right = normalize(cross(dir, up));
  const trueUp = cross(right, dir);

  const px = projector.position[0];
  const py = projector.position[1];
  const pz = projector.position[2];

  const tx = -(right[0] * px + right[1] * py + right[2] * pz);
  const ty = -(trueUp[0] * px + trueUp[1] * py + trueUp[2] * pz);
  const tz = -(dir[0] * px + dir[1] * py + dir[2] * pz);

  return [
    right[0], trueUp[0], -dir[0], 0,
    right[1], trueUp[1], -dir[1], 0,
    right[2], trueUp[2], -dir[2], 0,
    tx, ty, tz, 1,
  ];
}

export function computeDecalProjectionMatrix(projector: DecalProjector): number[] {
  const hw = projector.width / 2;
  const hh = projector.height / 2;
  const hd = projector.depth / 2;
  const near = 0;
  const far = projector.depth;

  const l = -hw, r = hw, b = -hh, t = hh, n = near, f = far;
  return [
    2 / (r - l), 0, 0, 0,
    0, 2 / (t - b), 0, 0,
    0, 0, -2 / (f - n), 0,
    -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1,
  ];
}

function normalize(v: [number, number, number]): [number, number, number] {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
