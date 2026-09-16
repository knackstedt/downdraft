// @downdraft/library-sand — reusable falling-sand simulation primitives.
//
// Extracted from a game so multiple games share the same material definitions,
// cell packing, and SandWorld simulation.
// Games keep their own SharedArrayBuffer/worker wiring but import the core
// sim types and the SandWorld class from here.

export {
    FLAG_ANCHORED,
    FLAG_POPPED,
    FLAG_SPARK,
    FLAG_UPDATED,
    FLAG_UPDATED_BIT,
    pack,
    packCell,
    SHADE_MASK,
    unpack,
    type Cell
} from "./cell";

export { SandRNG } from "./rng";

export {
    DEFAULT_GRAVITY,
    DEFAULT_TEMP,
    FIELD
} from "./fields";

export { FluidGrid } from "./fluid-grid";

export { PARTICLE_BYTES, PARTICLE_FLOATS, PARTICLE_TYPES, ParticleSystem, type Particle } from "./particles";

export {
    buildMaterialProps,
    buildPalette,
    PALETTE_SIZE,
    SHADES_PER_MATERIAL
} from "./palette";

export {
    getMaterialColor,
    IS_COLD,
    IS_FIRE,
    IS_HOT,
    MAT_CLIMBABLE,
    MAT_DENSITY,
    MAT_FLAGS,
    MAT_FLAMMABLE,
    MAT_GAS,
    MAT_GRAVITY,
    MAT_GRAVITY_DIR,
    MAT_LIFETIME,
    MAT_LIQUID,
    MAT_MAGNETIC,
    MAT_SOLID,
    Material,
    MATERIALS,
    MAX_MATERIAL
} from "./materials";
export type { MaterialDef } from "./materials";

export { SandStepPool, type SandStepPoolOptions } from "./sand-step-pool";
export { GRAVEL_DISTURB_SETTLE_TICKS, GRAVEL_SETTLE_TICKS, SandWorld } from "./sand-world";

// Generic grid-based SharedArrayBuffer framework for sand/grid games
export {
    allocateGridSimBuffer,
    computeGridSimOffsets,
    GridSimBufferReader,
    GridSimBufferWriter,
    type GridSimBufferLayout,
    type GridSimBufferOffsets
} from "./grid-sim-buffer";

export { computeGridDims, type ComputeGridDimsOptions } from "./grid-dims";

export { SandLib, SandWorldTok } from "./library";
export type { SandLibConfig } from "./library";
export { SandGridPass } from "./render/sand-grid-pass";
export type { SandGridPassConfig } from "./render/sand-grid-pass";

