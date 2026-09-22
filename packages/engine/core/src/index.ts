// ─────────────────────────────────────────────────────────────────────────────
// @downdraft/engine — public API barrel
//
// Re-exports from sub-barrels (ecs, render, assets, material, module, scene,
// physics, util) plus remaining direct exports for modules without a sub-barrel.
// ─────────────────────────────────────────────────────────────────────────────

/// <reference path="./webgpu-destroy-augmentation.d.ts" />

import pkg from "../../package.json" with { type: "json" };

// Sub-barrel re-exports — these aggregate all items from their respective domains.
export * from "./assets";
export * from "./ecs";
export * from "./library";
export * from "./material";
export * from "./module";
export * from "./physics";
export * from "./plugin";
export * from "./render";
export * from "./scene";
export * from "./util";

// ─────────────────────────────────────────────────────────────────────────────
// Engine version — single source of truth for the engine's semver.
// Used by the feature log, save headers (via features.saves.engineVersion
// default), and any code that needs to report the running engine version.
// Sourced from package.json so it can never drift from the published version.
// ─────────────────────────────────────────────────────────────────────────────
export const ENGINE_VERSION: string = pkg.version;

// ─────────────────────────────────────────────────────────────────────────────
// Worker (task-worker lives outside ecs/)
// ─────────────────────────────────────────────────────────────────────────────
export { hasTask, registerTask, unregisterTask } from "./worker/task-worker";

// ─────────────────────────────────────────────────────────────────────────────
// Change Detection
// ─────────────────────────────────────────────────────────────────────────────
export { ChangeTracker } from "./change-detection/tracker";

// ─────────────────────────────────────────────────────────────────────────────
// Engine Types (math, identifiers, enums, message protocols)
// ─────────────────────────────────────────────────────────────────────────────
export { EntityFlags } from "./types/engine-types";
export type { DbRequest, DbResponse, EntityData, MainToSimMessage, PlayerState, RendererToSimMessage, SimToMainKind, SimToMainMessage, SimToRendererMessage } from "./types/engine-types";

// ─────────────────────────────────────────────────────────────────────────────
// SAB
// ─────────────────────────────────────────────────────────────────────────────
export { CoreInputChannel } from "./sab/core-input-channel";
export { InputSABChannel } from "./sab/input";
export { createMultiInputChannel, DEFAULT_KEY_BITFIELD_COUNT, DEFAULT_MAX_PLAYERS, MultiInputChannel } from "./sab/multi-input-channel";
export type { MultiInputChannelInstance, MultiInputChannelOptions } from "./sab/multi-input-channel";

// Game Input SAB Channel
export { INP, INP_FLAG, INP_HDR, INPUT_MAGIC, INPUT_VERSION, InputBufferReader, InputBufferWriter, InputChannel, KEY, MAX_INPUT_PLAYERS } from "./sab/game-input";

// Sim SAB Channel
export { allocateInputBuffer, allocateSimBuffer, ENT, MAX_ENTITIES, MAX_PLAYERS, PLR, PLR_FLAG, SIM_ENTITY_SLOT_SIZE, SIM_HDR, SIM_MAGIC, SIM_PLAYER_SLOT_SIZE, SIM_VERSION, SimBufferReader, SimBufferWriter, SimChannel } from "./sab/sim-channel";
export type { PhysicsTimingData } from "./sab/sim-channel";

// SAB Framework
export { defineChannel, defineManifest } from "./sab/define";
export { isDebug, resetWarnings, ValidationError as SABValidationError, setDebug, warnOnce } from "./sab/errors";
export type {
    ChannelDef,
    ChannelInstance,
    ChannelLayout,
    ChannelMode,
    ChannelReader,
    ChannelWriter,
    FieldDef,
    FieldType,
    GridLayerDef,
    HeaderDef,
    ManifestInstance,
    SlotAccessor,
    SlotSectionDef
} from "./sab/types";

// ─────────────────────────────────────────────────────────────────────────────
// Worker
// ─────────────────────────────────────────────────────────────────────────────
export { BaseWorkerHost } from "./worker/base-worker-host";
export { BufferSyncHost, BufferSyncWorker, isBufferSyncMessage } from "./worker/buffer-sync";
export type { BufferRegion, BufferSyncConfig, BufferSyncMessage, BufferSyncRegions, SeqField } from "./worker/buffer-sync";
export { CrashRecoveryManager, DEFAULT_RECOVERY_CONFIG } from "./worker/crash-recovery";
export type { CrashRecoveryConfig, RecoveryState, SimWorkerLike } from "./worker/crash-recovery";
export { EntitySimWorkerHost } from "./worker/entity-sim-worker-host";
export type { EntitySimApi, EntitySimHostOptions } from "./worker/entity-sim-worker-host";
export { exposeProfilingApi, InstrumentedWorkerHost } from "./worker/instrumented-worker-host";
export type { InstrumentedWorkerHostOptions } from "./worker/instrumented-worker-host";
export { expose, exposeEvents, getWorkerHost, wrap } from "./worker/rpc";
export type { ExposeOptions, HostMessageHandler, WorkerApi, WorkerEventEmitter, WorkerHost, WorkerProxy } from "./worker/rpc";
export { createSimWorker } from "./worker/sim-worker-base";
export type { CreateSimWorkerOptions, SimAfterTicksContext, SimTickContext, SimWorkerControl, SimWorkerStats } from "./worker/sim-worker-base";
export { RawInputRegionWriter, SimWorkerHost } from "./worker/sim-worker-host";
export type { SimInputWriter, SimWorkerControlApi, SimWorkerSaveApi } from "./worker/sim-worker-host";
export { createTaskWorker, PortChannel, TaskPool } from "./worker/task-pool";
export type { JobMessage, JobResultMessage, TaskFn, TaskPoolOptions } from "./worker/task-pool";

// SAB polyfill (for Android WebView — no-op on desktop/Electron)
export { usingRealSAB } from "./sab/sab-polyfill";

// ─────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────
export { InputContextRouter } from "./input/context";
export { createDomInputHandler } from "./input/dom-handler";
export type { DomInjectedFrame, DomInputHandler, DomInputOptions } from "./input/dom-handler";
export { LocalPlayerManager } from "./input/local-player-manager";
export type { DeviceConnectCallback, DeviceDisconnectCallback, InputDevice } from "./input/local-player-manager";
export { InputMapping } from "./input/mapping";
export { createMultiInputBridge, createMultiInputWriter, MultiInputSABBridge, MultiInputSABWriter } from "./input/multi-sab-bridge";
export { MultiInputState } from "./input/multi-state";
export { InputSABBridge } from "./input/sab-bridge";
export { InputContext, InputState } from "./input/state";
export type { XRControllerState } from "./input/state";

// ─────────────────────────────────────────────────────────────────────────────
// Platform
// ─────────────────────────────────────────────────────────────────────────────
export { VirtualFS } from "./platform/fs";
export { HDRManager } from "./platform/hdr";
export type { HDRConfig, HDRMode } from "./platform/hdr";
export { getDpr, HiDPIManager } from "./platform/hidpi";
export { Lifecycle } from "./platform/lifecycle";
export { RPC } from "./platform/rpc";
export type { RPCHandler, RPCMessage, RPCMessageType } from "./platform/rpc";
export { hasHMR, isBrowser, isBun, isDev, isDevMode, isElectron } from "./platform/runtime";
export { HighResTimer } from "./platform/time";
export { WindowManager } from "./platform/window";
export type { WindowConfig, WindowState } from "./platform/window";

// ─────────────────────────────────────────────────────────────────────────────
// Mesh
// ─────────────────────────────────────────────────────────────────────────────
export { MeshBuilder } from "./mesh/builder";
export type { MeshData } from "./mesh/builder";
export { BSPNode, csgIntersect, csgSubtract, csgUnion } from "./mesh/csg";
export type { CSGOperation, CSGPolygon, Vec3 as CSGVec3 } from "./mesh/csg";
export {
    createGreasedLine, createGreasedLineMeshData
} from "./mesh/greased-line";
export type { GreasedLineData, GreasedLineOptions, GreasedLinePoint } from "./mesh/greased-line";
export { cone, cylinder, disc, lathe, ribbon, tessellatedPlane, torus, tube } from "./mesh/parametric";
export type { TubePathPoint } from "./mesh/parametric";
export { gpuVertexFormat, PBR_VERTEX_LAYOUT, SKINNED_VERTEX_LAYOUT, STANDARD_VERTEX_LAYOUT, vertexFormatSize, wgslVertexFormat } from "./mesh/vertex-layout";
export type { VertexAttribute, VertexAttributeFormat, VertexLayout } from "./mesh/vertex-layout";

// ─────────────────────────────────────────────────────────────────────────────
// Telemetry
// ─────────────────────────────────────────────────────────────────────────────
export { TelemetryCollector } from "./telemetry/collector";
export type { DrawStats, FrameTelemetry, PassTiming, ResourceEntry, ResourceStats, SnapshotDiff, SystemTiming, TelemetrySnapshot, ThreadMetrics } from "./telemetry/collector";
export { DebugOverlay, DEFAULT_DEBUG_OVERLAY_CONFIG } from "./telemetry/debug-overlay";
export type { DebugOverlayConfig } from "./telemetry/debug-overlay";
export { DEFAULT_GC_CONTROLLER_CONFIG, GCController } from "./telemetry/gc-controller";
export type { GCControllerConfig, GCControllerStats, GCIntervalStats, GCInvocationRecord, GCOverallStats } from "./telemetry/gc-controller";
export { startGCProfiler } from "./telemetry/gc-profiler";
export type { GCProfilerHandle, GCStats } from "./telemetry/gc-profiler";
export { GCTracker } from "./telemetry/gc-tracker";
export { GPUProfiler } from "./telemetry/gpu-profiler";
export type { FrameGraphData, FrameGraphEdge, FrameGraphNode, FrameGraphValidation, GPUAdapterInfo, GPUErrors, GPUInfo, PassTrackerStats, PostProcessInfo } from "./telemetry/gpu-profiler";
export { GPUResourceTracker } from "./telemetry/gpu-resource-tracker";
export type { GPUResourceStats, TrackedResource } from "./telemetry/gpu-resource-tracker";
export { GPUTimer } from "./telemetry/gpu-timer";
export { GPUTimerPool } from "./telemetry/gpu-timer-pool";
export { DEFAULT_PROFILER_CONFIG, ProfilerOverlay } from "./telemetry/profiler-overlay";
export type { ProfilerOverlayConfig } from "./telemetry/profiler-overlay";
export { TelemetryReporter } from "./telemetry/reporter";

// ─────────────────────────────────────────────────────────────────────────────
// Profiling (in-game declarative profiling system)
//
// The full profiling API is available via the `@downdraft/engine/profiling`
// subpath. Here we re-export the most commonly used items for convenience.
// Workers import the prelude via `import "@downdraft/engine/profiling/worker-prelude"`.
// ─────────────────────────────────────────────────────────────────────────────
export {
    DEFAULT_RENDERER_WARNING_RULES, DEFAULT_WORKER_WARNING_RULES, EventLoopMonitor,
    TaskLatencyHistogram,
    TraceEventWriter, WarningEngine
} from "./profiling";
export type {
    AutoTraceConfig, EventLoopSnapshot,
    IopsRecordSnapshot, ProfilingSABLayout,
    ProfilingSnapshot,
    SlotSnapshot,
    ThreadMetricsSnapshot, TracePreset,
    TraceSource, WarningCallback,
    WarningContext,
    WarningRecordData, WarningRecordSnapshot, WarningRule
} from "./profiling";

// ─────────────────────────────────────────────────────────────────────────────
// Debug Draw
// ─────────────────────────────────────────────────────────────────────────────
export { DebugLines } from "./debug-draw/lines";
export { DebugPoints } from "./debug-draw/points";
export { DebugDrawQueue } from "./debug-draw/queue";
export type { DebugLine, DebugPoint, DebugText } from "./debug-draw/queue";
export { DebugTextRenderer } from "./debug-draw/text";

// ─────────────────────────────────────────────────────────────────────────────
// Builder
// ─────────────────────────────────────────────────────────────────────────────
export { Builder, getBuilderConfig } from "./builder/builder";
export type { BuilderConfig, BuilderMode } from "./builder/builder";

// ─────────────────────────────────────────────────────────────────────────────
// Scripting
// ─────────────────────────────────────────────────────────────────────────────
export { createScriptBinding } from "./scripting/binding";
export type { ScriptBinding } from "./scripting/binding";
export { HotReloader } from "./scripting/hot-reload";
export { ScriptingSystem } from "./scripting/script";
export type { ScriptContext, ScriptHandle, ScriptModule } from "./scripting/script";

// ─────────────────────────────────────────────────────────────────────────────
// Save (legacy ECS serializer)
// ─────────────────────────────────────────────────────────────────────────────
export { SaveSystem } from "./save/migrate";
export { CURRENT_SCHEMA_VERSION, SchemaRegistry } from "./save/schema";
export { Serializer } from "./save/serializer";
export type { SaveData } from "./save/serializer";

// Save (new persistence system)
export {
    decodeHeader,
    encodeHeader,
    engineVersionString, HEADER_SIZE, packEngineVersion,
    readHeaderFromFile, SAVE_FORMAT_VERSION,
    SAVE_MAGIC, unpackEngineVersion, XXH128_SIZE
} from "./save/binary-format";
export type { SaveHeader } from "./save/binary-format";
export { MigrationRegistryImpl } from "./save/migration-registry";
export type {
    ComponentMigration,
    ComponentSection,
    IMigrationRegistry,
    IRendererStateProvider,
    ISaveStore,
    LoadOptions,
    LoadResult,
    SaveGenerationInfo,
    SaveMeta,
    SaveOptions,
    SaveResult,
    SaveSlotInfo,
    SaveState,
    SaveStateBuilder,
    SaveWarning,
    SaveWarningKind
} from "./save/persist-types";

// Grid save system factory — eliminates duplicated save-system boilerplate
export { createGameSaveSystem } from "./save/game-save-system";
export type { GameSaveSystem, GameSaveSystemOptions } from "./save/game-save-system";
export { createGridSaveSystem } from "./save/grid-save-system";
export type { GridSaveSystem, GridSaveSystemOptions, SaveListEntry } from "./save/grid-save-system";

// ─────────────────────────────────────────────────────────────────────────────
// Animation
// ─────────────────────────────────────────────────────────────────────────────
export * from "./animation";

// ─────────────────────────────────────────────────────────────────────────────
// Mesh Skinning
// ─────────────────────────────────────────────────────────────────────────────
export { BoneTransforms, buildSkinnedMeshFromGLTF, createSkinMatricesBuffer, MAX_BONES, SkinnedMesh } from "./mesh/skinning";
export type { BoneTransformData, SkinnedMeshData } from "./mesh/skinning";

// ─────────────────────────────────────────────────────────────────────────────
// Audio
// ─────────────────────────────────────────────────────────────────────────────
export { AudioEngine } from "./audio/engine";
export { DEFAULT_AUDIO_CONFIG } from "./audio/interface";
export type { AudioBackend, AudioBackendConfig, AudioBufferDesc, AudioChannel, AudioChannelConfig, AudioEffectDesc, AudioEffectType, AudioFormat, AudioListenerState, AudioSourceHandle } from "./audio/interface";
export { AudioListener, createAudioListener, listenerToState } from "./audio/listener";
export type { AudioListenerData } from "./audio/listener";
export { AudioMixer } from "./audio/mixer";
export type { MixerChannelState } from "./audio/mixer";
export { audioBackendRegistry } from "./audio/registry";
export { AudioSABChannel, AudioSABChannelDef } from "./audio/sab";
export type { AudioSABData } from "./audio/sab";
export { AudioSource, createAmbientAudioSource, createAudioSource, createSpatialAudioSource } from "./audio/source";
export type { AudioSourceData } from "./audio/source";

// ─────────────────────────────────────────────────────────────────────────────
// Particles
// ─────────────────────────────────────────────────────────────────────────────
export * from "./particles";

// ─────────────────────────────────────────────────────────────────────────────
// UI (imui)
// ─────────────────────────────────────────────────────────────────────────────
export * from "./imui";

// ─────────────────────────────────────────────────────────────────────────────
// Math
// ─────────────────────────────────────────────────────────────────────────────
export { composeMat4Into, invertMat4, invertMat4Into, lookAtMat4Into, multiplyMat4Into, perspectiveMat4Into, transformMat4Vec4 } from "./math/mat4";
export { PerlinNoise2D } from "./math/perlin-noise-2d";
export { PerlinNoise3D } from "./math/perlin-noise-3d";
export { eulerXYZToQuat, quatMul } from "./math/quat";
export { createRng, mulberry32, type RngFn } from "./math/rng";
export { fastCos, fastSin } from "./math/trig";
export { fbm2D, hash2, smoothstep, valueNoise2D } from "./math/value-noise";

// ─────────────────────────────────────────────────────────────────────────────
// Stores
// ─────────────────────────────────────────────────────────────────────────────
export { createBaseGameStoreState } from "./stores/game-store";
export type { BaseGameStoreState } from "./stores/game-store";
export { useHotReloadStore } from "./stores/hot-reload-store";
export type { ReloadEntry } from "./stores/hot-reload-store";

// ─────────────────────────────────────────────────────────────────────────────
// Sim Types (generic interfaces for plugin systems)
// ─────────────────────────────────────────────────────────────────────────────
export type { EntityId, IHotReloadable, InputReaderLike, ISimulation, IWorkerManager, PlayerId, Quat, SimEntityLike, SimPlayerLike, SimulationContext, Transform, Vec2, Vec3, Vec4 } from "./sim/types";

// Sim Worker Loop (reusable setTimeout-based loop for Web Workers)
export { SimWorkerLoop } from "./sim/worker-loop";
export type { SimWorkerLoopConfig, SimWorkerLoopStats } from "./sim/worker-loop";

// Hot-Reload Pipeline (framework-owned hot-reload lifecycle)
export { HotReloadPipeline } from "./sim/hot-reload-pipeline";
export { SimStateHelper } from "./sim/sim-state-helper";
export { TransientStateRegistry } from "./sim/transient-state-registry";

// ─────────────────────────────────────────────────────────────────────────────
// Safety utilities (path validation, safe JSON parse, bounds checking)
// ─────────────────────────────────────────────────────────────────────────────
export {
    assertBounds,
    assertCount,
    assertFinite,
    assertPositive,
    clamp,
    clampSafeInt, MAX_ARRAY_LENGTH, MAX_DECOMPRESS_SIZE, MAX_FACE_COUNT, MAX_FETCH_SIZE, MAX_MIP_LEVELS, MAX_NODE_DEPTH, MAX_TEXTURE_DIM, MAX_VERTEX_COUNT
} from "./safety/bounds";
export { safeJsonParse, safeJsonParseWithSchema, sanitizeObject } from "./safety/json";
export { confinePath, isPathSafe, sanitizeUri } from "./safety/path";

