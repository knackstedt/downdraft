import { type MeshData } from "./builder.ts";

export interface Mesh {
  data: MeshData;
  name: string;
}

export function createMesh(name: string, data: MeshData): Mesh {
  return { name, data };
}

export { MeshBuilder, type MeshData } from "./builder.ts";
export {
    createGreasedLine, createGreasedLineMeshData, type GreasedLineData, type GreasedLineOptions, type GreasedLinePoint
} from "./greased-line.ts";
export { cone, cylinder, disc, lathe, ribbon, tessellatedPlane, torus, tube, type TubePathPoint } from "./parametric.ts";

