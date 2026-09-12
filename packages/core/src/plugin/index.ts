// Plugin sub-barrel — re-exports all plugin-related items.
export {
    makeNativeContext,
    makeScriptContext,
    type NativePluginContext,
    type PhysicsDesc,
    type PluginContextBacking,
    type PluginEntry,
    type PluginEventBus, type PluginEventCatalog, type PluginEventHandler, type PluginHostCalls, type PluginLogger,
    type PluginRegisterFn,
    type PluginStateStore,
    type PluginTickApi,
    type ScriptPluginContext, type SpawnedProp, type SpawnPropDesc
} from "./context";
export {
    pluginInfoFromManifest,
    type PluginInfo,
    type PluginStatus
} from "./diagnostics";
export {
    createAssetLoader,
    createMapLoader,
    createMaterialShaderLoader,
    createPhysicsLoader,
    createPostfxShaderLoader,
    registerAllExtensionLoaders,
    type AssetRegistry,
    type ExtensionLoaderHost,
    type MapRegistry,
    type PhysicsRegistry,
    type ShaderRegistry
} from "./extension-loaders";
export {
    PluginHost,
    type ExtensionLoader,
    type PluginHostOptions,
    type PluginLoader,
    type PluginSource
} from "./host";
export { AssetPluginLoader, type AssetPluginLoaderOptions } from "./loader-asset";
export { QuickjsPluginLoader } from "./loader-quickjs";
export {
    InlineWasmPluginLoader,
    WasmPluginLoader
} from "./loader-wasm";
export { InlinePluginLoader, WorkerPluginLoader } from "./loader-worker";
export {
    flattenExtensions,
    validatePluginManifest,
    type AssetPluginManifest,
    type ModAssetExtension,
    type ModExtensionBucket,
    type ModExtensionDispatch,
    type ModExtensions,
    type ModLogic,
    type ModMapExtension,
    type ModPhysicsExtension,
    type ModSetting,
    type ModShaderMaterialExtension,
    type ModShaderPostfxExtension,
    type PluginFormat,
    type PluginManifest,
    type PluginManifestValidation,
    type PluginPermission, type PluginThread, type PluginTier
} from "./manifest";
export { MaterialRegistry, type RegisteredMaterial } from "./material-registry";
export { createPluginMcpTools } from "./mcp-tools";
export {
    BASELINE_GLOBALS,
    computeGlobalAllowlist,
    PERMISSION_GLOBALS,
    resolvePermissions,
    TIER_ALLOWED,
    type PermissionGrant
} from "./permissions";
export { createQuickjsBridge, getQuickJS, type QuickjsBridge, type QuickjsBridgeOptions } from "./quickjs-bridge";
export { PluginRegistry } from "./registry";
export { restrictGlobals } from "./sandbox-shim";
export {
    readBytesFromMemory,
    readStringFromMemory, WASM_PLUGIN_ABI_VERSION, writeBytesToMemory,
    writeStringToMemory,
    type WasmPluginExports,
    type WasmPluginImports
} from "./wasm-abi";
export {
    WorkshopFetcher,
    type WorkshopFetchResult,
    type WorkshopOptions,
    type WorkshopSource
} from "./workshop";

