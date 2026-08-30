// Plugin sub-barrel — re-exports all plugin-related items.
export {
    makeNativeContext,
    makeScriptContext,
    type NativePluginContext,
    type PluginContextBacking,
    type PluginEntry,
    type PluginEventBus, type PluginEventCatalog, type PluginEventHandler, type PluginLogger,
    type PluginRegisterFn,
    type PluginStateStore,
    type PluginTickApi,
    type ScriptPluginContext
} from "./context";
export {
    pluginInfoFromManifest,
    type PluginInfo,
    type PluginStatus
} from "./diagnostics";
export {
    PluginHost,
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
    validatePluginManifest,
    type AssetPluginManifest,
    type PluginFormat,
    type PluginManifest,
    type PluginManifestValidation,
    type PluginPermission, type PluginThread, type PluginTier
} from "./manifest";
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

