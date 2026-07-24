import { MeshBuilder, type MeshData } from "./builder.ts";

export interface Mesh {
  data: MeshData;
  name: string;
}

export function createMesh(name: string, data: MeshData): Mesh {
  return { name, data };
}

export { MeshBuilder, type MeshData } from "./builder.ts";
