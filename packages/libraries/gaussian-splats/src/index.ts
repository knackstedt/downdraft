export { GpuSplatSorter } from "./gpu-sort";
export type { GpuSplatSorterOptions } from "./gpu-sort";
export {
    getSplat, MAX_SH_DEGREE, parseGaussianSplatFile, parsePLY,
    parseSplat, SH_REST_COEFFS_MAX,
    SH_REST_COEFFS_PER_DEGREE
} from "./parser";
export type {
    GaussianSplat,
    GaussianSplatData,
    PLYHeader
} from "./parser";
export { GaussianSplatRenderer } from "./renderer";
export type { GaussianSplatRendererConfig } from "./renderer";
export {
    evalSHChannelCPU, packShCoeffs,
    SH_COEFFS_PER_CHANNEL, SH_COEFFS_TOTAL, SH_EVAL_WGSL
} from "./sh-eval";
export {
    filterByDistance, sortSplats
} from "./sorter";
export type { SortResult } from "./sorter";
export {
    DEFAULT_MAX_SPLATS_PER_TILE, DEFAULT_TILE_SIZE, TileRasterPipeline
} from "./tile-raster";
export type { TileRasterPipelineOptions } from "./tile-raster";

// Declarative library descriptor
export { GaussianSplatsLib, GaussianSplatsTok } from "./library";
export type { GaussianSplatsLibConfig } from "./library";

