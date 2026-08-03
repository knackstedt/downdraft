// ============================================================================
// TerrainConfig — all configurable parameters for volumetric island terrain
// Single source of truth for voxel resolution, generation params, and limits.
// ============================================================================

export const TERRAIN_CONFIG = {
  // --- Voxel grid ---
  voxelSize: 5.5,            // world units per voxel (the "minimum poly size")
  isoLevel: 0.0,             // density threshold for surface (positive = solid)
  maxVoxelMemory: 160_000_000, // max bytes per island voxel field (safety cap)

  // --- Island shape (asymmetric shield volcano) ---
  blobCount: 5,              // number of overlapping radial blobs per island
  blobMinRadius: 0.35,       // min blob radius (fraction of island radius)
  blobMaxRadius: 0.55,       // max blob radius (fraction of island radius)
  blobMinStrength: 0.6,      // min blob density contribution
  blobMaxStrength: 0.9,      // max blob density contribution
  blobSmoothUnionK: 0.8,     // smooth union blend factor (0=hard, 1=very soft)
  blobEdgeExtend: 0.25,      // how far blob falloff extends past nominal radius
  blobSpread: 0.4,           // max offset of blobs from center (wider = more irregular)

  // --- Asymmetric cliff direction ---
  cliffSideRadius: 0.5,      // radius multiplier on cliff side (steeper dropoff)
  gentleSideRadius: 1.25,    // radius multiplier on gentle slope side
  cliffDepthFactor: 0.25,    // underwater depth multiplier on cliff side
  plateauSharpness: 0.6,     // falloff exponent (lower = flatter plateau top)

  // --- Height modulation ---
  heightNoiseScale: 2.0,     // fBm frequency for terrain height variation
  heightNoiseOctaves: 2,     // fBm octaves
  heightNoiseAmplitude: 0.03,// height variation as fraction of peak height
  peakHeight: 0.08,          // above-water peak height in unit space (upper bound)
  depthHeight: 0.15,         // below-water depth — shallow shelf, not spherical
  yExtentMultiplier: 2.0,    // voxel field Y half-extent = (peakHeight+depthHeight)*radius*this
                             // must cover cliff-side amplification + smooth union + cliff bands

  // --- Beach layer ---
  beachThreshold: 0.03,      // |y| range around water level for beach flattening
  beachGradientScale: 0.4,    // flatten density gradient in beach zone (lower = flatter)
  beachSandColor: [0.76, 0.70, 0.50] as [number, number, number],

  // --- Sand visual effects (procedural, in WGSL fragment shader) ---
  // These values mirror the hardcoded constants in ISLAND_WGSL's sandSparkle()
  // and islandLighting(). Documented here for future tuning — if dynamic
  // uniform control is needed, add these to IslandUniforms struct.
  sandVisual: {
    sparkleIntensity: 0.8,       // overall sparkle brightness multiplier
    sparkleScale: 120.0,         // grain frequency (higher = finer grains)
    sparkleSharpness: 80.0,      // specular power (higher = tighter dots)
    sparkleSamples: 6,           // number of grain samples per pixel
    wetSandZoneWidth: 0.02,      // unit-space Y range for wet sand transition
    wetSandRoughness: 0.25,      // roughness of wet sand
    wetSandDarken: 0.55,         // albedo multiplier for wet sand
    wetSandFresnelStrength: 0.4, // sky reflection blend strength at grazing angles
    colorVariation: 0.06,        // albedo noise amplitude (±3% warm/cool)
  },

  // --- Cliff bands ---
  cliffGradientThreshold: 1.2, // density gradient magnitude above which = cliff
  cliffNoiseScale: 5.0,        // noise frequency for cliff zone placement
  cliffNoiseThreshold: 0.55,    // noise value above which cliffs appear
  cliffColor: [0.42, 0.40, 0.36] as [number, number, number],

  // --- Cave carving ---
  caveEnabled: true,
  caveNoiseScale: 4.0,       // 3D noise frequency for cave tunnels
  caveNoiseOctaves: 3,       // fBm octaves for caves
  caveThreshold: 0.15,       // noise value above which terrain is carved (inside solid)
  caveMinDepth: 0.02,        // caves only below this height (fraction of peak) — no surface caves
  caveMaxRadius: 0.3,        // max cave radius as fraction of island radius

  // --- Terrain type colors ---
  grassColor: [0.3, 0.5, 0.2] as [number, number, number],
  forestColor: [0.22, 0.38, 0.14] as [number, number, number],
  rockColor: [0.4, 0.38, 0.35] as [number, number, number],
  deepUnderwaterColor: [0.08, 0.07, 0.06] as [number, number, number],
  shallowUnderwaterColor: [0.16, 0.14, 0.11] as [number, number, number],
  shorelineColor: [0.35, 0.32, 0.25] as [number, number, number],

  // --- Deformation ---
  deformBatchThreshold: 8,  // coalesce this many deformations before mesh rebuild

  // --- Chunked voxel storage ---
  chunkSize: 32,                // voxels per chunk edge (must be power of 2)
  chunkBits: 5,                 // log2(chunkSize) — for fast bit-shift division
  chunkMask: 31,                // chunkSize - 1 — for fast modulo
  physVoxelSizeMultiplier: 2.5,  // physics voxels are 10× coarser than render voxels (keeps physics ~5.0 world units)

  // --- Sparse surface storage ---
  sparseEnabled: true,          // classify chunks as FullSolid/FullEmpty/Full to skip non-surface chunks
  sparseSolidMargin: 0.05,      // density margin: if all samples > isoLevel + this → FullSolid; if all < isoLevel - this → FullEmpty
  sparseSampleStride: 8,        // voxel stride for pre-allocation density sampling (8 = 4³=64 samples per 32³ chunk)

  // --- Distance-based LOD (Phase 3) ---
  // Distant islands use coarser voxels to reduce memory and generation time.
  // Values are in world-space units (same as voxelSize above).
  // 0 means "use base voxelSize" (closest LOD).
  // LOD only goes coarser than base — never finer (finer than base is too expensive).
  terrainLOD: [
    { maxDistance: 15,  voxelSize: 0,    },  // close: use base voxelSize (2.5m)
    { maxDistance: 25,  voxelSize: .5,  },  // medium: 2× coarser
    { maxDistance: 50,  voxelSize: 1.0,  },  // medium: 2× coarser
    { maxDistance: 150,  voxelSize: 5.0,  },  // medium: 2× coarser
    { maxDistance: 350,  voxelSize: 10.0,  },  // medium: 2× coarser
    { maxDistance: 700,  voxelSize: 20.0, },  // far: 4× coarser
  ] as readonly { maxDistance: number; voxelSize: number }[],

  // --- On-demand chunk generation (Phase 4) ---
  chunkGenTimeBudgetMs: 8,     // max time per tick for batch chunk generation in sim worker
  chunkGenMaxPerTick: 4,       // max chunks to generate per tick even if time budget remains

  // --- Lazy physics field generation ---
  physFieldGenTimeBudgetMs: 8, // max time per tick for physics voxel field generation
  physFieldGenMaxPerTick: 1,   // max islands to generate physics fields for per tick

  // --- Chunked mesh streaming ---
  chunkStreamEnabled: true,     // enable sub-chunk streaming for large islands
  chunkStreamThreshold: 12_000_000, // islands with voxel fields larger than this get chunked
  chunkSubdivisions: 3,         // split each axis into this many sub-chunks (3 = 3x3x3 = 27 chunks)
  streamTimeBudgetMs: 32,       // max time per frame for streaming chunk mesh generation
  streamMaxChunksPerFrame: 16,  // max chunks to generate per frame even if time budget remains

  // --- Port terrain (flat plateau with beach transition and optional caves) ---
  portVoxelSize: 3.0,           // coarser voxels for ports (flat terrain, less detail needed)
  // Keep below dock/pier deck (structure mesh owns walkable floor). Beach lip only.
  portPeakHeight: 0.008,
  portDepthHeight: 0.12,        // underwater shelf depth
  portBeachThreshold: 0.04,     // wider beach zone for smooth shoreline transition
  portBeachGradientScale: 0.5,  // gentle beach slope
  portBlobCount: 3,             // fewer blobs — roughly circular/elliptical plateau
  portBlobMinRadius: 0.5,       // large overlapping blobs for flat top
  portBlobMaxRadius: 0.7,
  portBlobMinStrength: 0.7,
  portBlobMaxStrength: 0.9,
  portBlobSpread: 0.2,          // low spread = more circular
  portBlobSmoothUnionK: 0.5,
  portCaveEnabled: true,        // caves/tunnels under port for secret areas
  portCaveNoiseScale: 5.0,
  portCaveThreshold: 0.25,      // higher threshold = fewer/smaller caves than islands
  portCaveMinDepth: 0.3,        // caves only deep underwater (well below dock)

  // --- Mesh extraction algorithm ---
  useSurfaceNets: true,         // true = Surface Nets (smoother, fewer vertices)
  useMarchingTetrahedra: false, // true = Marching Tetrahedra, false = Marching Cubes
                                 // Priority: useSurfaceNets > useMarchingTetrahedra > MC
  surfaceNetsSmooth: true,      // Surface Nets: true = smooth interpolation, false = snap to voxel grid (blocky)
} as const;
