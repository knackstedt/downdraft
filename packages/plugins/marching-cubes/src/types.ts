export interface VoxelField {
  data: Float32Array;
  dimX: number;
  dimY: number;
  dimZ: number;
  voxelSize: number;
  originX: number;
  originY: number;
  originZ: number;
  isoLevel: number;
  radius: number;
}

export interface ExtractedMesh {
  verts: Float32Array;
  indices: Uint16Array | Uint32Array;
  useUint32: boolean;
}
