// ECS
export { archetypeMatches, createArchetype, getArchetypeForComponents } from "./ecs/archetype";
export type { Archetype } from "./ecs/archetype";
export { Component, component, getComponentId, getComponentName } from "./ecs/component";
export type { ComponentDefinition, ComponentId, IComponent } from "./ecs/component";
export { entityEqual, entityToString, isAlive, ROOT_ENTITY } from "./ecs/entity";
export type { Entity, EntityMeta } from "./ecs/entity";
export { createEventChannel, EventBus } from "./ecs/events";
export type { EventChannel } from "./ecs/events";
export { Hierarchy } from "./ecs/hierarchy";
export { Query, query, queryChanged, queryExcluded, queryFromDefs } from "./ecs/query";
export type { QueryDescriptor } from "./ecs/query";
export { resourceToken } from "./ecs/resource";
export type { ResourceToken } from "./ecs/resource";
export { Schedule } from "./ecs/schedule";
export { Stage, system } from "./ecs/system";
export type { System, SystemContext, SystemFn } from "./ecs/system";
export { q, res, systemWithParams } from "./ecs/system-params";
export type { ParamSystemFn, QueryParam, Res, ResolvedParam, ResParam, SystemParam } from "./ecs/system-params";
export { World } from "./ecs/world";

// Job System
export { JobScheduler, parallelMap, WorkerPool } from "./ecs/job-system";
export type { BatchOptions, Job, JobResult, JobSchedulerOptions, WorkerPoolOptions } from "./ecs/job-system";
export { hasTask, registerTask, unregisterTask } from "./worker/task-worker";

// Change Detection
export { ChangeTracker } from "./change-detection/tracker";

// SAB
export { CoreInputChannel } from "./sab/core-input-channel";
export { InputSABChannel } from "./sab/input";
export { createMultiInputChannel, DEFAULT_KEY_BITFIELD_COUNT, DEFAULT_MAX_PLAYERS, MultiInputChannel } from "./sab/multi-input-channel";
export type { MultiInputChannelInstance, MultiInputChannelOptions } from "./sab/multi-input-channel";

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

// Worker
export { CrashRecoveryManager, DEFAULT_RECOVERY_CONFIG } from "./worker/crash-recovery";
export type { CrashRecoveryConfig, RecoveryState, SimWorkerLike } from "./worker/crash-recovery";
export { expose, exposeEvents, getWorkerHost, wrap } from "./worker/rpc";
export type { ExposeOptions, HostMessageHandler, WorkerApi, WorkerEventEmitter, WorkerHost, WorkerProxy } from "./worker/rpc";

// Input
export { InputContextRouter } from "./input/context";
export { LocalPlayerManager } from "./input/local-player-manager";
export type { DeviceConnectCallback, DeviceDisconnectCallback, InputDevice } from "./input/local-player-manager";
export { InputMapping } from "./input/mapping";
export { createMultiInputBridge, createMultiInputWriter, MultiInputSABBridge, MultiInputSABWriter } from "./input/multi-sab-bridge";
export { MultiInputState } from "./input/multi-state";
export { InputSABBridge } from "./input/sab-bridge";
export { InputContext, InputState } from "./input/state";
export type { XRControllerState } from "./input/state";

// Platform
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

// Render
export { BindGroupCache } from "./render/bind-group";
export { ArenaBuffer, RingBuffer } from "./render/buffer";
export { calculateViewProj, CameraMode, CameraSystem, dot3, invertMat4, normalize3, transformVec4 } from "./render/camera";
export type { CameraConfig, CameraState } from "./render/camera";
export { CanvasResizeWatcher } from "./render/canvas-resize-watcher";
export type { CanvasResizeHandler } from "./render/canvas-resize-watcher";
export { DEPTH_FORMAT, MSAA_SAMPLE_COUNT } from "./render/constants";
export { GPUDeviceManager } from "./render/device";
export { FrameGraph, TextureHandle } from "./render/frame-graph";
export type { ColorAttachmentDesc, DepthAttachmentDesc, FrameContext, TextureDesc } from "./render/frame-graph";
export { computeAABB, cullItems, Frustum, transformAABB } from "./render/frustum";
export type { AABB, CullableItem, FrustumPlane } from "./render/frustum";
export { G_BUFFER_FORMATS, GBuffer } from "./render/g-buffer";
export type { GBufferTextures, GBufferViews } from "./render/g-buffer";
export { GameRenderer } from "./render/game-renderer";
export type { CameraViewportInfo, CancelRAF, FrameCallbacks, GameRendererConfig, OffscreenMode, RAFSource, RenderTargetProvider } from "./render/game-renderer";
export { HDRSupport } from "./render/hdr";
export type { HDRConfig as RenderHDRConfig } from "./render/hdr";
export { MaterialHotReloader } from "./render/hot-reload";
export type { HotReloadCallback, WatchedMesh, WatchedShader, WatchedTexture } from "./render/hot-reload";
export { IBLSystem } from "./render/ibl";
export type { IBLSystemOptions } from "./render/ibl";
export { createIBLShaderChunk, IBL_SHADER_CHUNK, IBLBindGroup } from "./render/ibl-bind-group";
export type { IBLBindGroupOptions } from "./render/ibl-bind-group";
export { InputManager } from "./render/input-manager";
export type { RenderInputState } from "./render/input-manager";
export { createDefaultLightUniform, createDirectionalLight, createHemisphereLight, createPointLight, createRectAreaLight, createSpotLight, DEFAULT_SHADOW_SETTINGS, extractPointAndSpotLights, LightType, lightTypeToStorageType, MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS, packAllLightsToStorage, packLightToStorage, packLightUniform, packPointLights, packSpotLightsExtended } from "./render/lighting";
export type { DirectionalLight, HemisphereLight, Light, LightUniformData, PointLight, RectAreaLight, ShadowSettings, SpotLight } from "./render/lighting";
export { createLTCTextures, generateLTCLUTData, LTC_LUT_SIZE, LTC_SHADER_CHUNK } from "./render/lighting/area-light";
export type { AreaLightData, AreaLightShape, LTCTextureSet } from "./render/lighting/area-light";
export { ClusterGrid } from "./render/lighting/cluster-grid";
export { clusterIndex3D, computeClusterCount, computeClusterGridBufferSize, computeLightDataBufferSize, computeLightIndexListSize, DEFAULT_CLUSTER_CONFIG, depthSliceToNear, packClusterUniforms, packLightsArray, packLightToStorageBuffer, screenPosToClusterXY, worldDepthToSlice } from "./render/lighting/cluster-types";
export type { ClusterGridConfig, ClusterUniforms, GPULightData, LightShapeType } from "./render/lighting/cluster-types";
export { createIESGpuTexture, iesProfileToTextureData, parseIES } from "./render/lighting/ies-parser";
export type { IESLoadOptions, IESProfile } from "./render/lighting/ies-parser";
export { ClusterLightingPass } from "./render/passes/cluster-lighting-pass";
export { CSMPass, DEFAULT_CSM_SETTINGS } from "./render/passes/csm";
export type { CSMSettings } from "./render/passes/csm";
export { CubemapCapturePass } from "./render/passes/cubemap-capture";
export type { CubemapCaptureOptions } from "./render/passes/cubemap-capture";
export { DebugRenderPass } from "./render/passes/debug";
export { DeferredLightingPass } from "./render/passes/deferred-lighting";
export { DepthPrepass } from "./render/passes/depth-prepass";
export { Dome360Pass } from "./render/passes/dome-360";
export type { Dome360Config } from "./render/passes/dome-360";
export { DEFAULT_EDGES_SETTINGS, EdgesPass } from "./render/passes/edges";
export type { EdgesSettings } from "./render/passes/edges";
export { DEFAULT_FLUID_CONFIG, FluidRenderPass } from "./render/passes/fluid-render";
export type { FluidConfig } from "./render/passes/fluid-render";
export { DEFAULT_SPLAT_CONFIG, GAUSSIAN_SPLAT_SHADER, packSplatToVertexBuffer, parsePlySplatData, sortSplatsByDepth, SPLAT_FLOATS_PER_VERTEX } from "./render/passes/gaussian-splat";
export type { GaussianSplat, GaussianSplatConfig } from "./render/passes/gaussian-splat";
export { DEFAULT_RSM_CONFIG, packVPLsToBuffer, sampleRSMToVPLs, VPL_FLOATS, VPL_SIZE } from "./render/passes/gi-types";
export type { RSMConfig, VPLData } from "./render/passes/gi-types";
export { DEFAULT_GLOW_SETTINGS, GlowPass } from "./render/passes/glow";
export type { GlowSettings, GlowTarget } from "./render/passes/glow";
export { DEFAULT_GRAIN_SETTINGS, GrainPass } from "./render/passes/grain";
export type { GrainSettings } from "./render/passes/grain";
export { DEFAULT_HIGHLIGHT_SETTINGS, HighlightPass } from "./render/passes/highlight";
export type { HighlightSettings, HighlightTarget } from "./render/passes/highlight";
export { DEFAULT_LENS_FLARE_SETTINGS, LensFlarePass } from "./render/passes/lens-flare";
export type { LensFlareSettings } from "./render/passes/lens-flare";
export { LUT3DPass } from "./render/passes/lut3d";
export { DEFAULT_MOTION_BLUR_SETTINGS, MotionBlurPass } from "./render/passes/motion-blur";
export type { MotionBlurSettings } from "./render/passes/motion-blur";
export { OpaquePass } from "./render/passes/opaque";
export type { OpaquePassMode, PBRMaterialResources } from "./render/passes/opaque";
export { DEFAULT_OUTLINE_SETTINGS, OutlinePass } from "./render/passes/outline";
export type { OutlineSettings, OutlineTarget } from "./render/passes/outline";
export { MAX_POINT_LIGHT_SHADOWS, PointLightShadowPass } from "./render/passes/point-light-shadow";
export type { PointLightShadowData } from "./render/passes/point-light-shadow";
export { DEFAULT_POST_PROCESS_SETTINGS, PostProcessPass } from "./render/passes/post-process";
export type { PostProcessSettings } from "./render/passes/post-process";
export { PostProcessStack } from "./render/passes/post-process-stack";
export type { PostProcessStackOptions } from "./render/passes/post-process-stack";
export { createProceduralGpuTexture, DEFAULT_PROCEDURAL_CONFIG, generateProceduralTexture } from "./render/passes/procedural-texture";
export type { ProceduralTextureConfig, ProceduralTextureType } from "./render/passes/procedural-texture";
export type { ReflectionProbeConfig, ReflectionProbeData } from "./render/passes/reflection-probe";
export { RSMPass } from "./render/passes/rsm-pass";
export { layoutSDFText, parseSDFFont, SDF_TEXT_SHADER } from "./render/passes/sdf-text";
export type { SDFFontData, SDFGlyph } from "./render/passes/sdf-text";
export { ShadowPass } from "./render/passes/shadow";
export { ShadowMapSystem } from "./render/passes/shadow-map";
export type { ShadowMapOptions } from "./render/passes/shadow-map";
export { DEFAULT_SHARPEN_SETTINGS, SharpenPass } from "./render/passes/sharpen";
export type { SharpenSettings } from "./render/passes/sharpen";
export { SkyDomePass } from "./render/passes/sky-dome";
export type { SkyDomeUniforms } from "./render/passes/sky-dome";
export { SkyboxPass } from "./render/passes/skybox";
export { MAX_SPOT_LIGHT_SHADOWS, SpotLightShadowPass } from "./render/passes/spot-light-shadow";
export type { SpotLightShadowData } from "./render/passes/spot-light-shadow";
export { DEFAULT_SSAO_SETTINGS, SSAOPass } from "./render/passes/ssao";
export type { SSAOSettings } from "./render/passes/ssao";
export { DEFAULT_SSR_SETTINGS, SSRPass } from "./render/passes/ssr";
export type { SSRSettings } from "./render/passes/ssr";
export { TerrainPass } from "./render/passes/terrain";
export type { TerrainUniforms } from "./render/passes/terrain";
export { TransparentPass } from "./render/passes/transparent";
export type { TransparentRenderItem } from "./render/passes/transparent";
export { UICompositePass } from "./render/passes/ui-composite";
export { UnderwaterFogPass } from "./render/passes/underwater-fog";
export { VideoTextureSource } from "./render/passes/video-texture";
export type { VideoTextureConfig } from "./render/passes/video-texture";
export { VolumetricLightingPass } from "./render/passes/volumetric-pass";
export { computeExtinction, computeFroxelCount, computeFroxelGridBufferSize, computeFroxelLightIndexListSize, computeMiePhase, computeOpticalDepth, computeTransmittance, DEFAULT_FROXEL_CONFIG, DEFAULT_VOLUMETRIC_FOG, froxelDepthToSlice, froxelIndex3D, froxelSliceToFar, froxelSliceToNear, packVolumetricUniforms, screenPosToFroxelXY } from "./render/passes/volumetric-types";
export { WaterPass } from "./render/passes/water";
export type { WaterUniforms } from "./render/passes/water";
export { PBRSystem } from "./render/pbr";
export { PipelineCache } from "./render/pipeline";
export { RenderGraph } from "./render/render-graph";
export type { RenderPassDescriptor, RenderResource, ValidationError } from "./render/render-graph";
export { RenderPass } from "./render/render-pass";
export type { FrameGraphBuilder, GraphRenderContext, PassType, RenderPassContext } from "./render/render-pass";
export { RenderPipeline } from "./render/render-pipeline";
export type { RenderContext, RenderPassEntry, RenderPassSlot } from "./render/render-pipeline";
export { CSM_SHADER_CHUNK, POINT_SHADOW_SHADER_CHUNK, SPOT_SHADOW_SHADER_CHUNK } from "./render/shaders/shadow-chunks";
export { SkyboxRenderer } from "./render/skybox";
export type { SkyboxOptions } from "./render/skybox";
export { SurfaceManager } from "./render/surface";
export { DEFAULT_TONE_MAPPING_SETTINGS, getToneMappingOperatorIndex, TONE_MAPPING_SHADER_CHUNK, ToneMappingOperator } from "./render/tonemap";
export type { ToneMappingSettings } from "./render/tonemap";
export { TrackedRenderPass } from "./render/tracked-render-pass";
export type { ITrackedRenderPass } from "./render/tracked-render-pass";
export { ViewportLayout, viewportRectToPixels } from "./render/viewport";
export type { ViewportMode, ViewportRect } from "./render/viewport";
export { VisionTest, VisionTestSuite } from "./render/vision-test";
export type { DiffResult, PixelMatchOptions, PixelScanResult, VisionTestResult } from "./render/vision-test";

// Mesh
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
export { computeDecalProjectionMatrix, computeDecalViewMatrix, createDecalMesh } from "./render/passes/decal-mesh";
export type { DecalProjector } from "./render/passes/decal-mesh";
export { DecalPass } from "./render/passes/decal-pass";
export type { DecalItem } from "./render/passes/decal-pass";
export { GreasedLinePass } from "./render/passes/greased-line-pass";

// Material
export { MaterialCompiler } from "./material/compiler";
export { compileGraphToMaterial, compileUIGraphToMaterial, uiGraphToMaterialGraph } from "./material/graph-bridge";
export type { GraphToMaterialOptions, UIConnection, UINodeData } from "./material/graph-bridge";
export { MaterialLibrary } from "./material/library";
export { BlendMode, CullMode, Material, MaterialType } from "./material/material";
export type { MaterialDefinition, MaterialTexture, MaterialUniform } from "./material/material";

// Scene
export { batch, builderToPrefab, c, spawn, spawnChild } from "./scene/builder";
export type { ComponentSpec } from "./scene/builder";
export { Camera } from "./scene/camera";
export { CheckpointManager } from "./scene/checkpoint";
export type { CheckpointData } from "./scene/checkpoint";
export { GameLoop } from "./scene/game-loop";
export type { GameLoopConfig, GameLoopStats, RenderCallback } from "./scene/game-loop";
export { RenderLayer } from "./scene/layer";
export { createPrefabFromComponentDefs, PrefabFactory, PrefabRegistry } from "./scene/prefab";
export type { Prefab, PrefabChildEntry, PrefabComponentEntry } from "./scene/prefab";
export { Scene } from "./scene/scene";
export type { SceneSetup, SceneState, SceneTeardown, SerializedScene } from "./scene/scene";
export { SceneManager } from "./scene/scene-manager";
export { computeSkyColor, DayNightCycle, DEFAULT_ATMOSPHERE_CONFIG, DEFAULT_DAY_NIGHT_CONFIG, DEFAULT_FOG_CONFIG, FogSystem } from "./scene/sky";
export type { AtmosphereConfig, DayNightConfig, FogConfig, SunMoonState } from "./scene/sky";
export { SpatialGrid } from "./scene/spatial-grid";
export type { GridCell, SpatialEntry, SpatialQueryResult } from "./scene/spatial-grid";
export { chunkKey, WorldStreamer, worldToChunk } from "./scene/streaming";
export type { ChunkCoord, ChunkData, ChunkLoader, ChunkUnloader, StreamConfig } from "./scene/streaming";
export { generateInstances, packInstanceData, VegetationPatch, VegetationWindSystem } from "./scene/vegetation";
export type { VegetationInstance, VegetationPatchData, WindState } from "./scene/vegetation";
export { GameWorld } from "./scene/world";
export type { WorldResources } from "./scene/world";

// Telemetry
export { TelemetryCollector } from "./telemetry/collector";
export type { DrawStats, FrameTelemetry, PassTiming, ResourceEntry, ResourceStats, SnapshotDiff, SystemTiming, TelemetrySnapshot, ThreadMetrics } from "./telemetry/collector";
export { DebugOverlay, DEFAULT_DEBUG_OVERLAY_CONFIG } from "./telemetry/debug-overlay";
export type { DebugOverlayConfig } from "./telemetry/debug-overlay";
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

// Debug Draw
export { DebugLines } from "./debug-draw/lines";
export { DebugPoints } from "./debug-draw/points";
export { DebugDrawQueue } from "./debug-draw/queue";
export type { DebugLine, DebugPoint, DebugText } from "./debug-draw/queue";
export { DebugTextRenderer } from "./debug-draw/text";

// Builder
export { Builder, getBuilderConfig } from "./builder/builder";
export type { BuilderConfig, BuilderMode } from "./builder/builder";

// Scripting
export { createScriptBinding } from "./scripting/binding";
export type { ScriptBinding } from "./scripting/binding";
export { HotReloader } from "./scripting/hot-reload";
export { ScriptingSystem } from "./scripting/script";
export type { ScriptContext, ScriptHandle, ScriptModule } from "./scripting/script";

// Plugin
export { createABIVTable, WASM_ABI_VERSION } from "./plugin/abi";
export type { ABIVTable } from "./plugin/abi";
export { PluginHost } from "./plugin/host";
export type { Plugin, PluginContext, SABChannel } from "./plugin/plugin";
export { PluginRegistry } from "./plugin/registry";
export { TSPluginLoader } from "./plugin/ts-loader";
export { WASMPluginLoader } from "./plugin/wasm-loader";
export type { WASMABIExports, WASMABIImports } from "./plugin/wasm-loader";

// Save (legacy ECS serializer)
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
    LoadResult,
    SaveMeta,
    SaveResult,
    SaveSlotInfo,
    SaveState,
    SaveStateBuilder,
    SaveWarning,
    SaveWarningKind
} from "./save/persist-types";

// Assets
export { GPUResourceCache } from "./assets/cache";
export type { GPUCacheEntry } from "./assets/cache";
export { EquirectToCubemapConverter } from "./assets/cubemap-converter";
export type { EquirectToCubemapOptions } from "./assets/cubemap-converter";
export { EnvironmentManager } from "./assets/environment-manager";
export type { EnvironmentManagerOptions, EnvironmentMap } from "./assets/environment-manager";
export { AssetImporter } from "./assets/importer";
export type { ImportOptions, ImportResult } from "./assets/importer";
export { IrradianceGenerator } from "./assets/irradiance-generator";
export type { IrradianceOptions } from "./assets/irradiance-generator";
export { detectAudioFormat, loadAudioFile, loadAudioFromBuffer, registerAudioLoader } from "./assets/loader-audio";
export { createEquirectangularGPUTexture, createGPUCubemap, loadCubemapFromDirectory, loadCubemapFromFiles } from "./assets/loader-cubemap";
export type { CubemapData, CubemapFaceData } from "./assets/loader-cubemap";
export { loadDDSFromBuffer, loadDDSTexture, parseDDS } from "./assets/loader-dds";
export { loadEXRTexture, loadHDRFile, loadHDRTexture, parseEXR, parseHDR } from "./assets/loader-hdr";
export { GLBLoader } from "./assets/loader-mesh";
export type { GLTFAccessor, GLTFBuffer, GLTFBufferView, GLTFDocument, GLTFMesh, GLTFNode, GLTFPrimitive } from "./assets/loader-mesh";
export { ShaderLoader } from "./assets/loader-shader";
export type { ShaderSource } from "./assets/loader-shader";
export { createGPUTextureFromData, createSampler, detectTextureFormat, loadKTX2Texture, loadTexture, loadTextureFromImage, parseKTX2FromBuffer } from "./assets/loader-texture";
export type { TextureData, TextureFormat } from "./assets/loader-texture";
export { LODGenerator } from "./assets/lod";
export type { LODConfig, LODLevel } from "./assets/lod";
export { AssetManager } from "./assets/manager";
export type {
    AssetDestructor,
    AssetLoadProgress,
    AssetManagerOptions,
    AssetPriority,
    AssetRef,
    ProgressCallback,
    SearchPath
} from "./assets/manager";
export { bridgeMaterial, bridgeMaterials } from "./assets/material-bridge";
export type { BridgedMaterial } from "./assets/material-bridge";
export { importMaterial, importModel, importSingleMesh } from "./assets/model-importer";
export type { ImportedModel, ImportModelOptions } from "./assets/model-importer";
export { destroyGPUMesh, uploadMeshesToGPU, uploadMeshToGPU } from "./assets/model-to-gpu";
export type { GPUMesh } from "./assets/model-to-gpu";
export { convertPluginMesh, convertPluginModel } from "./assets/model-to-mesh";
export type { PluginMaterialData, PluginMeshData, PluginModelData, TargetLayout } from "./assets/model-to-mesh";
export { PrefilteredSpecularGenerator } from "./assets/prefilter-generator";
export type { PrefilterOptions } from "./assets/prefilter-generator";

// Blob Storage & Asset Manifest
export { makeBlobUri, parseBlobUri } from "./assets/blob-store";
export type {
    BlobGetOptions,
    BlobListOptions,
    BlobListResult,
    BlobObject,
    BlobPutOptions,
    BlobStore,
    BlobStoreConfig
} from "./assets/blob-store";
export {
    createEmptyManifest, DEFAULT_CACHE_DIR,
    MANIFEST_FILENAME, packCacheKey,
    validateManifest
} from "./assets/manifest";
export type { AssetManifest, AssetPackEntry } from "./assets/manifest";

// Physics
export { PhysicsTransform, RigidBody, Velocity } from "./physics/body";
export type { PhysicsTransformData, RigidBodyData, VelocityData } from "./physics/body";
export { CharacterController, CharacterControllerSystem } from "./physics/character";
export type { CharacterControllerData, CharacterControllerInput } from "./physics/character";
export { Collider, createBoxCollider, createCapsuleCollider, createConvexCollider, createMeshCollider, createSphereCollider } from "./physics/collider";
export type { ColliderData } from "./physics/collider";
export { CollisionEventSystem } from "./physics/collision-system";
export { COLLISION_STARTED_CHANNEL, COLLISION_STOPPED_CHANNEL, computeCollisionEvents, CONTACT_CHANNEL, manifoldToStartedEvent } from "./physics/events";
export type { CollisionStartedEvent, CollisionStoppedEvent, ContactEvent } from "./physics/events";
export type { BodyDesc, BodyType, CharacterControllerDesc, CharacterControllerHandle, CharacterMoveResult, ColliderDesc, ColliderShape, ContactManifold, JointDesc, JointType, PhysicsBackend, PhysicsRealmConfig, RaycastResult, RigidBodyHandle, ShapeCastResult } from "./physics/interface";
export { PhysicsLifecycle } from "./physics/lifecycle";
export type { BootstrapPhase } from "./physics/lifecycle";
export { createRagdoll, destroyRagdoll, Ragdoll } from "./physics/ragdoll";
export type { RagdollBoneConfig, RagdollConfig, RagdollData, RagdollJointConfig } from "./physics/ragdoll";
export { humanoidRagdoll } from "./physics/ragdoll-presets";
export { RagdollSystem } from "./physics/ragdoll-system";
export { RaycastQuery } from "./physics/raycast";
export { PhysicsRealm } from "./physics/realm";
export { physicsBackendRegistry } from "./physics/registry";

// Animation
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
export { packBoneTransformsVec4, VertexSkinningPass } from "./render/passes/skinning";
export { createSkinningPass, MAX_BONE_INFLUENCES, MAX_BONES_VS, SKINNING_VS_GLSL, SKINNING_VS_WGSL } from "./render/passes/skinning-vs";
export type { SkinningMode, SkinningPass } from "./render/passes/skinning-vs";

// Mesh Skinning
export { BoneTransforms, buildSkinnedMeshFromGLTF, createSkinMatricesBuffer, MAX_BONES, SkinnedMesh } from "./mesh/skinning";
export type { BoneTransformData, SkinnedMeshData } from "./mesh/skinning";

// GPU Skinning Compute Pass
export { packBoneTransforms, SkinningComputePass } from "./render/passes/skinning";
export type { SkinningComputePassResources } from "./render/passes/skinning";

// Audio
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

// Particles
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

// UI Panels
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

// Debug Visualization
export { DebugVizPass, DEFAULT_DEBUG_VIZ_SETTINGS } from "./render/passes/debug-viz";
export type { DebugVizMode, DebugVizSettings } from "./render/passes/debug-viz";

// Logging
export { ConsoleLogger, createLogger, setThreadTag } from "./util/logger";
export type { Logger } from "./util/logger";

// Math
export { PerlinNoise3D } from "./math/perlin-noise-3d";

// Stores
export { createBaseGameStoreState } from "./stores/game-store";
export type { BaseGameStoreState } from "./stores/game-store";
export { useHotReloadStore } from "./stores/hot-reload-store";
export type { ReloadEntry } from "./stores/hot-reload-store";

// Split-Screen Layout
export { computeViewports, getLayoutForPlayerCount, getPlayerCountForLayout } from "./render/splitscreen";
export type { SplitscreenLayoutType, ViewportSlot } from "./render/splitscreen";

// Sim Types (generic interfaces for plugin systems)
export type { EntityId, IHotReloadable, InputReaderLike, ISimulation, IWorkerManager, PlayerId, Quat, SimEntityLike, SimPlayerLike, SimulationContext, Transform, Vec2, Vec3, Vec4 } from "./sim/types";

// Sim Worker Loop (reusable setTimeout-based loop for Web Workers)
export { SimWorkerLoop } from "./sim/worker-loop";
export type { SimWorkerLoopConfig, SimWorkerLoopStats } from "./sim/worker-loop";

// Hot-Reload Pipeline (framework-owned hot-reload lifecycle)
export { HotReloadPipeline } from "./sim/hot-reload-pipeline";
export { SimStateHelper } from "./sim/sim-state-helper";
export { TransientStateRegistry } from "./sim/transient-state-registry";

