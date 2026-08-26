// ─────────────────────────────────────────────────────────────────────────────
// @downdraft/core — public API barrel
//
// Re-exports from sub-barrels (ecs, render, assets, material, plugin, scene,
// physics, util) plus remaining direct exports for modules without a sub-barrel.
// ─────────────────────────────────────────────────────────────────────────────

// Sub-barrel re-exports — these aggregate all items from their respective domains.
export * from "./assets";
export * from "./ecs";
export * from "./material";
export * from "./physics";
export * from "./plugin";
export * from "./render";
export * from "./scene";
export * from "./util";

// ─────────────────────────────────────────────────────────────────────────────
// Engine version — single source of truth for the engine's semver.
// Used by the feature log, save headers (via features.saves.engineVersion
// default), and any code that needs to report the running engine version.
// Bump this in lockstep with the root package.json "version" field.
// ─────────────────────────────────────────────────────────────────────────────
export const ENGINE_VERSION = "0.1.0";

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
export type { DbRequest, DbResponse, EntityData, MainToSimMessage, PlayerState, RendererToSimMessage, SimToMainMessage, SimToRendererMessage } from "./types/engine-types";

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
export { CrashRecoveryManager, DEFAULT_RECOVERY_CONFIG } from "./worker/crash-recovery";
export type { CrashRecoveryConfig, RecoveryState, SimWorkerLike } from "./worker/crash-recovery";
export { expose, exposeEvents, getWorkerHost, wrap } from "./worker/rpc";
export type { ExposeOptions, HostMessageHandler, WorkerApi, WorkerEventEmitter, WorkerHost, WorkerProxy } from "./worker/rpc";
export { createSimWorker } from "./worker/sim-worker-base";
export type { CreateSimWorkerOptions, SimAfterTicksContext, SimTickContext, SimWorkerControl, SimWorkerStats } from "./worker/sim-worker-base";

// ─────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────
export { InputContextRouter } from "./input/context";
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
export { HiDPIManager } from "./platform/hidpi";
export { Lifecycle } from "./platform/lifecycle";
export { RPC } from "./platform/rpc";
export type { RPCHandler, RPCMessage, RPCMessageType } from "./platform/rpc";
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
export { createGridSaveSystem } from "./save/grid-save-system";
export type { GridSaveSystem, GridSaveSystemOptions, SaveListEntry } from "./save/grid-save-system";

// ─────────────────────────────────────────────────────────────────────────────
// Animation
// ─────────────────────────────────────────────────────────────────────────────
export { createAnimationEventTrack, getEventsInRange } from "./animation/animation-event";
export type { AnimationEvent, AnimationEventTrack } from "./animation/animation-event";
export { BoneMaskPreset, buildBoneMask, buildCustomBoneMask, registerCustomMask } from "./animation/bone-mask";
export { AnimationClip, buildAnimationClipFromGLTF } from "./animation/clip";
export type { AnimationClipData, KeyframeTrack, TrackPath } from "./animation/clip";
export { DEFAULT_MIXAMO_CONFIG, MixamoRetargeter } from "./animation/mixamo";
export type { MixamoRetargetConfig } from "./animation/mixamo";
export { buildMorphTargetData, createMorphTargetTrack, findMorphKeyframeIndex, sampleMorphWeight } from "./animation/morph-target";
export type { MorphTarget, MorphTargetData, MorphTargetTrack } from "./animation/morph-target";
export { AnimationPlayer, MAX_MORPH_TARGETS } from "./animation/player";
export type { LayerBlendMode, PlayOptions } from "./animation/player";
export { buildRetargetMapping, retargetClip } from "./animation/retarget";
export type { BoneMapping, RetargetMapping } from "./animation/retarget";
export { buildSkeletonFromGLTF, Skeleton } from "./animation/skeleton";
export type { Bone, GLTFSkin, SkeletonData } from "./animation/skeleton";
export { SkeletonAnimator, skinDataToSkeletonData } from "./animation/skeleton-animator";
export type { AnimationChannel, AnimationData, AnimState, BoneData, SkinData } from "./animation/skeleton-animator";
export { AnimationStateMachine } from "./animation/state-machine";
export type { AnimationState, AnimationTransition, BlendTree, BlendTree1D, BlendTree2D } from "./animation/state-machine";

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
export { ParticleComputePass } from "./particles/compute-pass";
export type { ParticleComputeParams } from "./particles/compute-pass";
export { createExplosionEmitter, createFireEmitter, createParticleEmitter, createSmokeEmitter, createSparkEmitter, ParticleEmitter } from "./particles/emitter";
export type { EmitterShape, ParticleEmitterData } from "./particles/emitter";
export { createParticleGPUData, packParticleBuffer, PARTICLE_STRIDE } from "./particles/particle-data";
export type { ParticleGPUData } from "./particles/particle-data";
export { ParticleRenderPass } from "./particles/render-pass";
export { ParticleSimulator } from "./particles/simulator";
export { DEFAULT_PARTICLE_CONFIG, ParticleSystem } from "./particles/system";
export type { ParticleSystemConfig } from "./particles/system";

// ─────────────────────────────────────────────────────────────────────────────
// UI Panels
// ─────────────────────────────────────────────────────────────────────────────
export { InspectorPanel } from "./ui/inspector";
export type { InspectorComponent, InspectorField, InspectorState } from "./ui/inspector";
export { SceneTreePanel } from "./ui/scene-tree";
export type { SceneTreeNode, SceneTreeState } from "./ui/scene-tree";

// UI Rendering System
export { Easing, UIAnimationManager, UILerpController, UIPropertyTween } from "./ui/animation";
export type { EasingFunction, UIAnimationConfig } from "./ui/animation";
export { UIButton, UIElement, UIImage, UILine, UIPanel, UIRoot, UIText } from "./ui/element";
export type { UICallbacks, UIColor, UIDrawable, UIHorizontalAlign, UILayoutMode, UIStyle, UIVerticalAlign } from "./ui/element";
export { UIInputRouter } from "./ui/input";
export { LayoutEngine } from "./ui/layout";
export { UIRenderer } from "./ui/renderer";
export { UIScrollPanel } from "./ui/scroll";
export { TextAtlasCache } from "./ui/text-cache";
export type { TextCacheEntry, TextRenderOptions } from "./ui/text-cache";
export { UIModal, UIProgressBar, UISlider, UITabBar, UITextInput, UIToggle } from "./ui/widgets";

// ─────────────────────────────────────────────────────────────────────────────
// Math
// ─────────────────────────────────────────────────────────────────────────────
export { composeMat4Into, invertMat4, multiplyMat4Into } from "./math/mat4";
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

