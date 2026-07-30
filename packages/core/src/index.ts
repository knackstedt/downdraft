// ECS
export { archetypeMatches, createArchetype, getArchetypeForComponents } from "./ecs/archetype.ts";
export type { Archetype } from "./ecs/archetype.ts";
export { Component, component, getComponentId, getComponentName } from "./ecs/component.ts";
export type { ComponentDefinition, ComponentId, IComponent } from "./ecs/component.ts";
export { entityEqual, entityToString, isAlive, ROOT_ENTITY } from "./ecs/entity.ts";
export type { Entity, EntityMeta } from "./ecs/entity.ts";
export { createEventChannel, EventBus } from "./ecs/events.ts";
export type { EventChannel } from "./ecs/events.ts";
export { Hierarchy } from "./ecs/hierarchy.ts";
export { Query, query, queryChanged, queryExcluded } from "./ecs/query.ts";
export type { QueryDescriptor } from "./ecs/query.ts";
export { Schedule } from "./ecs/schedule.ts";
export { Stage, system } from "./ecs/system.ts";
export type { System, SystemContext, SystemFn } from "./ecs/system.ts";
export { World } from "./ecs/world.ts";

// Change Detection
export { ChangeTracker } from "./change-detection/tracker.ts";

// SAB
export { CoreInputChannel } from "./sab/core-input-channel.ts";
export { InputSABChannel } from "./sab/input.ts";

// SAB Framework
export { defineChannel, defineManifest } from "./sab/define.ts";
export { isDebug, resetWarnings, ValidationError as SABValidationError, setDebug, warnOnce } from "./sab/errors.ts";
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
} from "./sab/types.ts";

// Worker
export { CrashRecoveryManager, DEFAULT_RECOVERY_CONFIG } from "./worker/crash-recovery.ts";
export type { CrashRecoveryConfig, RecoveryState, SimWorkerLike } from "./worker/crash-recovery.ts";
export { expose, exposeEvents, getWorkerHost, wrap } from "./worker/rpc.ts";
export type { ExposeOptions, HostMessageHandler, WorkerApi, WorkerEventEmitter, WorkerHost, WorkerProxy } from "./worker/rpc.ts";

// Input
export { InputContextRouter } from "./input/context.ts";
export { InputMapping } from "./input/mapping.ts";
export { InputSABBridge } from "./input/sab-bridge.ts";
export { InputContext, InputState } from "./input/state.ts";

// Platform
export { VirtualFS } from "./platform/fs.ts";
export { HDRManager } from "./platform/hdr.ts";
export type { HDRConfig, HDRMode } from "./platform/hdr.ts";
export { HiDPIManager } from "./platform/hidpi.ts";
export { Lifecycle } from "./platform/lifecycle.ts";
export { RPC } from "./platform/rpc.ts";
export type { RPCHandler, RPCMessage, RPCMessageType } from "./platform/rpc.ts";
export { HighResTimer } from "./platform/time.ts";
export { WindowManager } from "./platform/window.ts";
export type { WindowConfig, WindowState } from "./platform/window.ts";

// Render
export { BindGroupCache } from "./render/bind-group.ts";
export { ArenaBuffer, RingBuffer } from "./render/buffer.ts";
export { GPUDeviceManager } from "./render/device.ts";
export { computeAABB, cullItems, Frustum, transformAABB } from "./render/frustum.ts";
export type { AABB, CullableItem, FrustumPlane } from "./render/frustum.ts";
export { G_BUFFER_FORMATS, GBuffer } from "./render/g-buffer.ts";
export type { GBufferTextures, GBufferViews } from "./render/g-buffer.ts";
export { HDRSupport } from "./render/hdr.ts";
export type { HDRConfig as RenderHDRConfig } from "./render/hdr.ts";
export { MaterialHotReloader } from "./render/hot-reload.ts";
export type { HotReloadCallback, WatchedMesh, WatchedShader, WatchedTexture } from "./render/hot-reload.ts";
export { createDefaultLightUniform, createDirectionalLight, createPointLight, LightType, MAX_POINT_LIGHTS, packLightUniform, packPointLights } from "./render/lighting.ts";
export type { DirectionalLight, Light, LightUniformData, PointLight, SpotLight } from "./render/lighting.ts";
export { DebugRenderPass } from "./render/passes/debug.ts";
export { DeferredLightingPass } from "./render/passes/deferred-lighting.ts";
export { DepthPrepass } from "./render/passes/depth-prepass.ts";
export { OpaquePass } from "./render/passes/opaque.ts";
export type { OpaquePassMode, PBRMaterialResources } from "./render/passes/opaque.ts";
export { DEFAULT_POST_PROCESS_SETTINGS, PostProcessPass } from "./render/passes/post-process.ts";
export type { PostProcessSettings } from "./render/passes/post-process.ts";
export { ShadowPass } from "./render/passes/shadow.ts";
export { SkyboxPass } from "./render/passes/skybox.ts";
export { TransparentPass } from "./render/passes/transparent.ts";
export type { TransparentRenderItem } from "./render/passes/transparent.ts";
export { UICompositePass } from "./render/passes/ui-composite.ts";
export { PipelineCache } from "./render/pipeline.ts";
export { RenderGraph } from "./render/render-graph.ts";
export type { RenderPassDescriptor, RenderResource, ValidationError } from "./render/render-graph.ts";
export { RenderLoop } from "./render/render-loop.ts";
export type { DebugToggleState, RenderLoopConfig } from "./render/render-loop.ts";
export { RenderPass } from "./render/render-pass.ts";
export type { RenderPassContext } from "./render/render-pass.ts";
export { SurfaceManager } from "./render/surface.ts";
export { TrackedRenderPass } from "./render/tracked-render-pass.ts";
export { VisionTest, VisionTestSuite } from "./render/vision-test.ts";
export type { DiffResult, PixelMatchOptions, PixelScanResult, VisionTestResult } from "./render/vision-test.ts";

// Mesh
export { MeshBuilder } from "./mesh/builder.ts";
export type { MeshData } from "./mesh/builder.ts";
export { gpuVertexFormat, PBR_VERTEX_LAYOUT, SKINNED_VERTEX_LAYOUT, STANDARD_VERTEX_LAYOUT, vertexFormatSize, wgslVertexFormat } from "./mesh/vertex-layout.ts";
export type { VertexAttribute, VertexAttributeFormat, VertexLayout } from "./mesh/vertex-layout.ts";

// Material
export { MaterialCompiler } from "./material/compiler.ts";
export { MaterialLibrary } from "./material/library.ts";
export { BlendMode, CullMode, Material } from "./material/material.ts";
export type { MaterialDefinition, MaterialTexture, MaterialUniform } from "./material/material.ts";

// Scene
export { Camera } from "./scene/camera.ts";
export { CheckpointManager } from "./scene/checkpoint.ts";
export type { CheckpointData } from "./scene/checkpoint.ts";
export { RenderLayer } from "./scene/layer.ts";
export { createPrefabFromComponentDefs, PrefabFactory, PrefabRegistry } from "./scene/prefab.ts";
export type { Prefab, PrefabChildEntry, PrefabComponentEntry } from "./scene/prefab.ts";
export { Scene } from "./scene/scene.ts";
export { computeSkyColor, DayNightCycle, DEFAULT_ATMOSPHERE_CONFIG, DEFAULT_DAY_NIGHT_CONFIG, DEFAULT_FOG_CONFIG, FogSystem } from "./scene/sky.ts";
export type { AtmosphereConfig, DayNightConfig, FogConfig, SunMoonState } from "./scene/sky.ts";
export { SpatialGrid } from "./scene/spatial-grid.ts";
export type { GridCell, SpatialEntry, SpatialQueryResult } from "./scene/spatial-grid.ts";
export { chunkKey, WorldStreamer, worldToChunk } from "./scene/streaming.ts";
export type { ChunkCoord, ChunkData, ChunkLoader, ChunkUnloader, StreamConfig } from "./scene/streaming.ts";
export { generateInstances, packInstanceData, VegetationPatch, VegetationWindSystem } from "./scene/vegetation.ts";
export type { VegetationInstance, VegetationPatchData, WindState } from "./scene/vegetation.ts";
export { GameWorld } from "./scene/world.ts";

// Telemetry
export { TelemetryCollector } from "./telemetry/collector.ts";
export type { SystemTiming, ThreadMetrics } from "./telemetry/collector.ts";
export { startGCProfiler } from "./telemetry/gc-profiler.ts";
export type { GCProfilerHandle, GCStats } from "./telemetry/gc-profiler.ts";
export { GCTracker } from "./telemetry/gc-tracker.ts";
export { TelemetryReporter } from "./telemetry/reporter.ts";

// Debug Draw
export { DebugLines } from "./debug-draw/lines.ts";
export { DebugPoints } from "./debug-draw/points.ts";
export { DebugDrawQueue } from "./debug-draw/queue.ts";
export type { DebugLine, DebugPoint, DebugText } from "./debug-draw/queue.ts";
export { DebugTextRenderer } from "./debug-draw/text.ts";

// Builder
export { Builder, getBuilderConfig } from "./builder/builder.ts";
export type { BuilderConfig, BuilderMode } from "./builder/builder.ts";

// Scripting
export { createScriptBinding } from "./scripting/binding.ts";
export type { ScriptBinding } from "./scripting/binding.ts";
export { HotReloader } from "./scripting/hot-reload.ts";
export { ScriptingSystem } from "./scripting/script.ts";
export type { ScriptContext, ScriptHandle, ScriptModule } from "./scripting/script.ts";

// Plugin
export { createABIVTable, WASM_ABI_VERSION } from "./plugin/abi.ts";
export type { ABIVTable } from "./plugin/abi.ts";
export { PluginHost } from "./plugin/host.ts";
export type { Plugin, PluginContext, SABChannel } from "./plugin/plugin.ts";
export { PluginRegistry } from "./plugin/registry.ts";
export { TSPluginLoader } from "./plugin/ts-loader.ts";
export { WASMPluginLoader } from "./plugin/wasm-loader.ts";
export type { WASMABIExports, WASMABIImports } from "./plugin/wasm-loader.ts";

// Save
export { SaveSystem } from "./save/migrate.ts";
export { CURRENT_SCHEMA_VERSION, SchemaRegistry } from "./save/schema.ts";
export { Serializer } from "./save/serializer.ts";
export type { SaveData } from "./save/serializer.ts";

// Assets
export { GPUResourceCache } from "./assets/cache.ts";
export type { GPUCacheEntry } from "./assets/cache.ts";
export { AssetImporter } from "./assets/importer.ts";
export type { ImportOptions, ImportResult } from "./assets/importer.ts";
export { detectAudioFormat, loadAudioFile, loadAudioFromBuffer, registerAudioLoader } from "./assets/loader-audio.ts";
export { GLBLoader } from "./assets/loader-mesh.ts";
export type { GLTFAccessor, GLTFBuffer, GLTFBufferView, GLTFDocument, GLTFMesh, GLTFNode, GLTFPrimitive } from "./assets/loader-mesh.ts";
export { ShaderLoader } from "./assets/loader-shader.ts";
export type { ShaderSource } from "./assets/loader-shader.ts";
export { createGPUTextureFromData, createSampler, detectTextureFormat, loadKTX2Texture, loadTexture, loadTextureFromImage } from "./assets/loader-texture.ts";
export type { TextureData, TextureFormat } from "./assets/loader-texture.ts";
export { LODGenerator } from "./assets/lod.ts";
export type { LODConfig, LODLevel } from "./assets/lod.ts";
export { AssetManager } from "./assets/manager.ts";
export type { AssetRef } from "./assets/manager.ts";

// Physics
export { PhysicsTransform, RigidBody, Velocity } from "./physics/body.ts";
export type { PhysicsTransformData, RigidBodyData, VelocityData } from "./physics/body.ts";
export { CharacterController, CharacterControllerSystem } from "./physics/character.ts";
export type { CharacterControllerData } from "./physics/character.ts";
export { Collider, createBoxCollider, createCapsuleCollider, createConvexCollider, createMeshCollider, createSphereCollider } from "./physics/collider.ts";
export type { ColliderData } from "./physics/collider.ts";
export { CollisionEventSystem } from "./physics/collision-system.ts";
export { COLLISION_STARTED_CHANNEL, COLLISION_STOPPED_CHANNEL, computeCollisionEvents, CONTACT_CHANNEL, manifoldToStartedEvent } from "./physics/events.ts";
export type { CollisionStartedEvent, CollisionStoppedEvent, ContactEvent } from "./physics/events.ts";
export type { BodyDesc, BodyType, ColliderDesc, ColliderShape, ContactManifold, PhysicsBackend, PhysicsRealmConfig, RaycastResult, RigidBodyHandle, ShapeCastResult } from "./physics/interface.ts";
export { PhysicsLifecycle } from "./physics/lifecycle.ts";
export type { BootstrapPhase } from "./physics/lifecycle.ts";
export { RaycastQuery } from "./physics/raycast.ts";
export { PhysicsRealm } from "./physics/realm.ts";
export { physicsBackendRegistry } from "./physics/registry.ts";

// Animation
export { AnimationClip, buildAnimationClipFromGLTF } from "./animation/clip.ts";
export type { AnimationClipData, KeyframeTrack, TrackPath } from "./animation/clip.ts";
export { DEFAULT_MIXAMO_CONFIG, MixamoRetargeter } from "./animation/mixamo.ts";
export type { MixamoRetargetConfig } from "./animation/mixamo.ts";
export { AnimationPlayer } from "./animation/player.ts";
export type { PlayingAnimation } from "./animation/player.ts";
export { buildRetargetMapping, retargetClip } from "./animation/retarget.ts";
export type { BoneMapping, RetargetMapping } from "./animation/retarget.ts";
export { buildSkeletonFromGLTF, Skeleton } from "./animation/skeleton.ts";
export type { Bone, GLTFSkin, SkeletonData } from "./animation/skeleton.ts";
export { AnimationStateMachine } from "./animation/state-machine.ts";
export type { AnimationState, AnimationTransition, BlendTree, BlendTree1D, BlendTree2D } from "./animation/state-machine.ts";

// Mesh Skinning
export { BoneTransforms, buildSkinnedMeshFromGLTF, createSkinMatricesBuffer, MAX_BONES, SkinnedMesh } from "./mesh/skinning.ts";
export type { BoneTransformData, SkinnedMeshData } from "./mesh/skinning.ts";

// GPU Skinning Compute Pass
export { packBoneTransforms, SkinningComputePass } from "./render/passes/skinning.ts";
export type { SkinningComputePassResources } from "./render/passes/skinning.ts";

// Audio
export { AudioEngine } from "./audio/engine.ts";
export { DEFAULT_AUDIO_CONFIG } from "./audio/interface.ts";
export type { AudioBackend, AudioBackendConfig, AudioBufferDesc, AudioChannel, AudioChannelConfig, AudioEffectDesc, AudioEffectType, AudioFormat, AudioListenerState, AudioSourceHandle } from "./audio/interface.ts";
export { AudioListener, createAudioListener, listenerToState } from "./audio/listener.ts";
export type { AudioListenerData } from "./audio/listener.ts";
export { AudioMixer } from "./audio/mixer.ts";
export type { MixerChannelState } from "./audio/mixer.ts";
export { audioBackendRegistry } from "./audio/registry.ts";
export { AudioSABChannel, AudioSABChannelDef } from "./audio/sab.ts";
export type { AudioSABData } from "./audio/sab.ts";
export { AudioSource, createAmbientAudioSource, createAudioSource, createSpatialAudioSource } from "./audio/source.ts";
export type { AudioSourceData } from "./audio/source.ts";

// Particles
export { ParticleComputePass } from "./particles/compute-pass.ts";
export type { ParticleComputeParams } from "./particles/compute-pass.ts";
export { createExplosionEmitter, createFireEmitter, createParticleEmitter, createSmokeEmitter, createSparkEmitter, ParticleEmitter } from "./particles/emitter.ts";
export type { EmitterShape, ParticleEmitterData } from "./particles/emitter.ts";
export { createParticleGPUData, packParticleBuffer, PARTICLE_STRIDE } from "./particles/particle-data.ts";
export type { ParticleGPUData } from "./particles/particle-data.ts";
export { ParticleRenderPass } from "./particles/render-pass.ts";
export { ParticleSimulator } from "./particles/simulator.ts";
export { DEFAULT_PARTICLE_CONFIG, ParticleSystem } from "./particles/system.ts";
export type { ParticleSystemConfig } from "./particles/system.ts";

// UI Panels
export { InspectorPanel } from "./ui/inspector.ts";
export type { InspectorComponent, InspectorField, InspectorState } from "./ui/inspector.ts";
export { SceneTreePanel } from "./ui/scene-tree.ts";
export type { SceneTreeNode, SceneTreeState } from "./ui/scene-tree.ts";

// Debug Visualization
export { DebugVizPass, DEFAULT_DEBUG_VIZ_SETTINGS } from "./render/passes/debug-viz.ts";
export type { DebugVizMode, DebugVizSettings } from "./render/passes/debug-viz.ts";

// Logging
export { ConsoleLogger, createLogger } from "./util/logger.ts";
export type { Logger } from "./util/logger.ts";

// Sim Types (generic interfaces for plugin systems)
export type { EntityId, InputReaderLike, PlayerId, Quat, SimEntityLike, SimPlayerLike, SimulationContext, Transform, Vec2, Vec3, Vec4 } from "./sim/types.ts";

