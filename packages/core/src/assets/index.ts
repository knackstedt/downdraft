// Assets sub-barrel — re-exports all asset-related items.
export { GPUResourceCache } from "./cache";
export type { GPUCacheEntry } from "./cache";
export { EquirectToCubemapConverter } from "./cubemap-converter";
export type { EquirectToCubemapOptions } from "./cubemap-converter";
export { EnvironmentManager } from "./environment-manager";
export type { EnvironmentManagerOptions, EnvironmentMap } from "./environment-manager";
export { AssetImporter } from "./importer";
export type { ImportOptions, ImportResult } from "./importer";
export { IrradianceGenerator } from "./irradiance-generator";
export type { IrradianceOptions } from "./irradiance-generator";
export { detectAudioFormat, loadAudioFile, loadAudioFromBuffer, registerAudioLoader } from "./loader-audio";
export { createEquirectangularGPUTexture, createGPUCubemap, loadCubemapFromDirectory, loadCubemapFromFiles } from "./loader-cubemap";
export type { CubemapData, CubemapFaceData } from "./loader-cubemap";
export { loadDDSFromBuffer, loadDDSTexture, parseDDS } from "./loader-dds";
export { loadEXRTexture, loadHDRFile, loadHDRTexture, parseEXR, parseHDR } from "./loader-hdr";
export { GLBLoader } from "./loader-mesh";
export type { GLTFAccessor, GLTFBuffer, GLTFBufferView, GLTFDocument, GLTFMesh, GLTFNode, GLTFPrimitive } from "./loader-mesh";
export { ShaderLoader } from "./loader-shader";
export type { ShaderSource } from "./loader-shader";
export { createGPUTextureFromData, createSampler, detectTextureFormat, loadKTX2Texture, loadTexture, loadTextureFromImage, parseKTX2FromBuffer } from "./loader-texture";
export type { TextureData, TextureFormat } from "./loader-texture";
export { LODGenerator } from "./lod";
export type { LODConfig, LODLevel } from "./lod";
export { AssetManager } from "./manager";
export type {
    AssetDestructor,
    AssetLoadProgress,
    AssetManagerOptions,
    AssetPriority,
    AssetRef,
    ProgressCallback,
    SearchPath
} from "./manager";
export { bridgeMaterial, bridgeMaterials } from "./material-bridge";
export type { BridgedMaterial } from "./material-bridge";
export { importMaterial, importModel, importSingleMesh } from "./model-importer";
export type { ImportedModel, ImportModelOptions } from "./model-importer";
export { destroyGPUMesh, uploadMeshesToGPU, uploadMeshToGPU } from "./model-to-gpu";
export type { GPUMesh } from "./model-to-gpu";
export { convertPluginMesh, convertPluginModel } from "./model-to-mesh";
export type { PluginMaterialData, PluginMeshData, PluginModelData, TargetLayout } from "./model-to-mesh";
// Model normalization — transform math for import-time correction
export {
    applyRootRotation, applyRootScale, applyUnitScale, applyUpAxisConversion, autoFit, centerToOrigin, computeBounds, isExtremeScale, maxDimension
} from "./model-normalizer";
export type { Bounds } from "./model-normalizer";
// Import settings — per-model normalization configuration
export { createDefaultImportSettings, mergeImportSettings } from "./import-settings";
export type { ImportSettings, SettingsSource, UnitSystem, UpAxis } from "./import-settings";
// Import cache — caches resolved ImportSettings keyed by model path
export { isCacheEntryValid, MemoryImportCache } from "./import-cache";
export type { CacheEntry, ImportCache } from "./import-cache";
export { PrefilteredSpecularGenerator } from "./prefilter-generator";
export type { PrefilterOptions } from "./prefilter-generator";

// Blob Storage & Asset Manifest
export { makeBlobUri, parseBlobUri } from "./blob-store";
export type {
    BlobGetOptions,
    BlobListOptions,
    BlobListResult,
    BlobObject,
    BlobPutOptions,
    BlobStore,
    BlobStoreConfig
} from "./blob-store";
export {
    createEmptyManifest, DEFAULT_CACHE_DIR,
    MANIFEST_FILENAME, packCacheKey,
    validateManifest
} from "./manifest";
export type { AssetManifest, AssetPackEntry } from "./manifest";
