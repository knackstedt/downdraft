import { type MeshData } from "./builder";

export interface Mesh {
  data: MeshData;
  name: string;
}

export function createMesh(name: string, data: MeshData): Mesh {
  return { name, data };
}

export { MeshBuilder, type MeshData } from "./builder";
export {
    createGreasedLine, createGreasedLineMeshData, type GreasedLineData, type GreasedLineOptions, type GreasedLinePoint
} from "./greased-line";
export { cone, cylinder, disc, lathe, ribbon, tessellatedPlane, torus, tube, type TubePathPoint } from "./parametric";

