// ============================================================================
// ComputeProfile — configures the ComputeGraphCompiler for a specific
// compute workload type. Simpler than ShaderGraphProfile: no vertex layout,
// no output formats, no blend. Just chunks + workgroup size.
// ============================================================================

export interface ComputeProfile {
  name: string;
  /** WGSL chunks to inject at the top of the shader (e.g. noise functions). */
  chunks: string[];
  /** `@workgroup_size(x, y, z)` — threads per workgroup. */
  workgroupSize: [number, number, number];
}

// --- Built-in compute profiles ---

/** General-purpose 1D compute — 64 threads per workgroup along X. */
export const SIMPLE_COMPUTE_PROFILE: ComputeProfile = {
  name: "simple-compute",
  chunks: [],
  workgroupSize: [64, 1, 1],
};

/** Particle simulation — 64 threads, includes hash/random helpers. */
export const PARTICLE_COMPUTE_PROFILE: ComputeProfile = {
  name: "particle-compute",
  chunks: [],
  workgroupSize: [64, 1, 1],
};

/** 2D texture/image processing — 8x8 threads per workgroup. */
export const TEXTURE_COMPUTE_PROFILE: ComputeProfile = {
  name: "texture-compute",
  chunks: [],
  workgroupSize: [8, 8, 1],
};

/** 3D volumetric compute — 4x4x4 threads per workgroup. */
export const VOLUMETRIC_COMPUTE_PROFILE: ComputeProfile = {
  name: "volumetric-compute",
  chunks: [],
  workgroupSize: [4, 4, 4],
};

export const COMPUTE_PROFILE_REGISTRY: Record<string, ComputeProfile> = {
  "simple-compute": SIMPLE_COMPUTE_PROFILE,
  "particle-compute": PARTICLE_COMPUTE_PROFILE,
  "texture-compute": TEXTURE_COMPUTE_PROFILE,
  "volumetric-compute": VOLUMETRIC_COMPUTE_PROFILE,
};

export function getComputeProfile(name: string): ComputeProfile | undefined {
  return COMPUTE_PROFILE_REGISTRY[name];
}
