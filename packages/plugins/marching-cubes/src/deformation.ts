import type { MCMesh, DensityField, MCChunkConfig } from "./generator.ts";

export interface DeformationConfig {
  radius: number;
  strength: number;
  falloff: number;
}

export function applyDeformation(
  field: DensityField,
  deformPos: [number, number, number],
  config: DeformationConfig,
): DensityField {
  const [dx, dy, dz] = deformPos;
  const r = config.radius;
  const strength = config.strength;
  const falloff = config.falloff;

  return (x: number, y: number, z: number) => {
    const distSq = (x - dx) ** 2 + (y - dy) ** 2 + (z - dz) ** 2;
    if (distSq > r * r) return field(x, y, z);
    const dist = Math.sqrt(distSq);
    const t = 1 - (dist / r) ** falloff;
    return field(x, y, z) + strength * t;
  };
}

export function applyMultipleDeformations(
  field: DensityField,
  deformations: Array<{ pos: [number, number, number]; config: DeformationConfig }>,
): DensityField {
  let result = field;
  for (const def of deformations) {
    result = applyDeformation(result, def.pos, def.config);
  }
  return result;
}

export function deformChunk(
  mesh: MCMesh,
  deformPos: [number, number, number],
  config: DeformationConfig,
): MCMesh {
  const [dx, dy, dz] = deformPos;
  const r = config.radius;
  const strength = config.strength;
  const falloff = config.falloff;

  const vertices = new Float32Array(mesh.vertices);
  for (let i = 0; i < mesh.vertexCount; i++) {
    const offset = i * 3;
    const vx = vertices[offset];
    const vy = vertices[offset + 1];
    const vz = vertices[offset + 2];
    const distSq = (vx - dx) ** 2 + (vy - dy) ** 2 + (vz - dz) ** 2;
    if (distSq > r * r) continue;
    const dist = Math.sqrt(distSq);
    const t = 1 - (dist / r) ** falloff;
    vertices[offset + 1] += strength * t;
  }

  return { ...mesh, vertices };
}
