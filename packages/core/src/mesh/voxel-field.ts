// ============================================================================
// Voxel Field — generic 3D density field for mesh extraction
// ============================================================================

export interface VoxelField {
  data: Float32Array;       // density values, indexed as data[x * dimY * dimZ + y * dimZ + z]
  dimX: number;             // grid size in X
  dimY: number;             // grid size in Y (height)
  dimZ: number;             // grid size in Z
  voxelSize: number;        // world units per voxel
  originX: number;          // world-space origin (center of first voxel)
  originY: number;
  originZ: number;
  isoLevel: number;         // surface threshold
  radius: number;           // island radius in world units (for unit-space conversion)
}

// Extracted mesh from marching cubes
export interface ExtractedMesh {
  verts: Float32Array;      // pos(3) + normal(3) + color(3) = 9 floats per vertex
  indices: Uint16Array | Uint32Array;  // triangle indices
  useUint32: boolean;       // whether indices are uint32
}
