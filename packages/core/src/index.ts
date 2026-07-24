// ECS
export { World } from "./ecs/world.ts";
export type { Entity, EntityMeta } from "./ecs/entity.ts";
export { ROOT_ENTITY, entityEqual, entityToString, isAlive } from "./ecs/entity.ts";
export { getComponentId, getComponentName, component, Component } from "./ecs/component.ts";
export type { ComponentId, ComponentDefinition, IComponent } from "./ecs/component.ts";
export { createArchetype, archetypeMatches, getArchetypeForComponents } from "./ecs/archetype.ts";
export type { Archetype } from "./ecs/archetype.ts";
export { Query, query, queryExcluded, queryChanged } from "./ecs/query.ts";
export type { QueryDescriptor } from "./ecs/query.ts";
export { system, Stage } from "./ecs/system.ts";
export type { System, SystemFn, SystemContext } from "./ecs/system.ts";
export { Schedule } from "./ecs/schedule.ts";
export { EventBus, createEventChannel } from "./ecs/events.ts";
export type { EventChannel } from "./ecs/events.ts";
export { Hierarchy } from "./ecs/hierarchy.ts";

// Change Detection
export { ChangeTracker } from "./change-detection/tracker.ts";

// SAB
export { SeqlockBuffer, createLayout } from "./sab/seqlock.ts";
export type { BufferLayout, BufferField } from "./sab/seqlock.ts";
export { SABWriter } from "./sab/writer.ts";
export { SABReader } from "./sab/reader.ts";
export { InputSABChannel } from "./sab/input.ts";
export {
  CHANNEL_LAYOUTS,
  TRANSFORM_LAYOUT,
  INPUT_LAYOUT,
  PHYSICS_LAYOUT,
  AUDIO_POSITION_LAYOUT,
  WATER_LAYOUT,
  TERRAIN_LAYOUT,
  createSABForChannel,
} from "./sab/protocol.ts";
export type { ChannelName } from "./sab/protocol.ts";

// Worker
export { SimWorkerHandle } from "./worker/sim-worker.ts";
export { SimWorkerSupervisor } from "./worker/supervisor.ts";
export { SimWorkerRuntime } from "./worker/sim-worker-entry.ts";
export { DBWorker } from "./worker/db-worker.ts";
export type { WorkerMessage, InitPayload, StepPayload, StepAckPayload } from "./worker/protocol.ts";

// Input
export { InputState, InputContext } from "./input/state.ts";
export { InputMapping } from "./input/mapping.ts";
export { InputContextRouter } from "./input/context.ts";
export { InputSABBridge } from "./input/sab-bridge.ts";

// Platform
export { WindowManager } from "./platform/window.ts";
export type { WindowConfig, WindowState } from "./platform/window.ts";
export { HiDPIManager } from "./platform/hidpi.ts";
export { HDRManager } from "./platform/hdr.ts";
export type { HDRMode, HDRConfig } from "./platform/hdr.ts";
export { HighResTimer } from "./platform/time.ts";
export { ElectrobunLifecycle } from "./platform/electrobun.ts";
export { VirtualFS } from "./platform/fs.ts";
export { ElectrobunRPC } from "./platform/rpc.ts";
export type { RPCMessage, RPCMessageType, RPCHandler } from "./platform/rpc.ts";

// Render
export { GPUDeviceManager } from "./render/device.ts";
export { SurfaceManager } from "./render/surface.ts";
export { RenderGraph } from "./render/render-graph.ts";
export type { RenderResource, RenderPassDescriptor, ValidationError } from "./render/render-graph.ts";
export { RenderPass } from "./render/render-pass.ts";
export type { RenderPassContext } from "./render/render-pass.ts";
export { OpaquePass } from "./render/passes/opaque.ts";
export type { OpaquePassMode, PBRMaterialResources } from "./render/passes/opaque.ts";
export { TransparentPass } from "./render/passes/transparent.ts";
export type { TransparentRenderItem } from "./render/passes/transparent.ts";
export { DepthPrepass } from "./render/passes/depth-prepass.ts";
export { ShadowPass } from "./render/passes/shadow.ts";
export { PostProcessPass } from "./render/passes/post-process.ts";
export type { PostProcessSettings } from "./render/passes/post-process.ts";
export { DEFAULT_POST_PROCESS_SETTINGS } from "./render/passes/post-process.ts";
export { DeferredLightingPass } from "./render/passes/deferred-lighting.ts";
export { SkyboxPass } from "./render/passes/skybox.ts";
export { UICompositePass } from "./render/passes/ui-composite.ts";
export { DebugRenderPass } from "./render/passes/debug.ts";
export { TrackedRenderPass } from "./render/tracked-render-pass.ts";
export { RenderLoop } from "./render/render-loop.ts";
export type { RenderLoopConfig } from "./render/render-loop.ts";
export { PipelineCache } from "./render/pipeline.ts";
export { BindGroupCache } from "./render/bind-group.ts";
export { RingBuffer, ArenaBuffer } from "./render/buffer.ts";
export { GBuffer } from "./render/g-buffer.ts";
export type { GBufferTextures, GBufferViews } from "./render/g-buffer.ts";
export { G_BUFFER_FORMATS } from "./render/g-buffer.ts";
export { Frustum } from "./render/frustum.ts";
export type { AABB, FrustumPlane, CullableItem } from "./render/frustum.ts";
export { computeAABB, transformAABB, cullItems } from "./render/frustum.ts";
export { MaterialHotReloader } from "./render/hot-reload.ts";
export type { WatchedShader, WatchedMesh, WatchedTexture, HotReloadCallback } from "./render/hot-reload.ts";
export { VisionTest, VisionTestSuite } from "./render/vision-test.ts";
export type { PixelMatchOptions, PixelScanResult, DiffResult, VisionTestResult } from "./render/vision-test.ts";
export { HDRSupport } from "./render/hdr.ts";
export type { HDRConfig as RenderHDRConfig } from "./render/hdr.ts";
export { LightType, createDirectionalLight, createPointLight, createDefaultLightUniform, packLightUniform, packPointLights, MAX_POINT_LIGHTS } from "./render/lighting.ts";
export type { Light, DirectionalLight, PointLight, SpotLight, LightUniformData } from "./render/lighting.ts";

// Mesh
export { MeshBuilder } from "./mesh/builder.ts";
export type { MeshData } from "./mesh/builder.ts";
export { STANDARD_VERTEX_LAYOUT, PBR_VERTEX_LAYOUT, SKINNED_VERTEX_LAYOUT } from "./mesh/vertex-layout.ts";
export type { VertexLayout, VertexAttribute, VertexAttributeFormat } from "./mesh/vertex-layout.ts";
export { vertexFormatSize, wgslVertexFormat, gpuVertexFormat } from "./mesh/vertex-layout.ts";

// Material
export { Material, BlendMode, CullMode } from "./material/material.ts";
export type { MaterialDefinition, MaterialUniform, MaterialTexture } from "./material/material.ts";
export { MaterialLibrary } from "./material/library.ts";
export { MaterialCompiler } from "./material/compiler.ts";

// Scene
export { Scene } from "./scene/scene.ts";
export { GameWorld } from "./scene/world.ts";
export { RenderLayer } from "./scene/layer.ts";
export { Camera } from "./scene/camera.ts";
export { CheckpointManager } from "./scene/checkpoint.ts";
export type { CheckpointData } from "./scene/checkpoint.ts";
export { PrefabRegistry, PrefabFactory, createPrefabFromComponentDefs } from "./scene/prefab.ts";
export type { Prefab, PrefabComponentEntry, PrefabChildEntry } from "./scene/prefab.ts";
export { SpatialGrid } from "./scene/spatial-grid.ts";
export type { SpatialEntry, GridCell, SpatialQueryResult } from "./scene/spatial-grid.ts";
export { WorldStreamer, worldToChunk, chunkKey } from "./scene/streaming.ts";
export type { ChunkCoord, ChunkData, StreamConfig, ChunkLoader, ChunkUnloader } from "./scene/streaming.ts";
export { DayNightCycle, FogSystem, computeSkyColor } from "./scene/sky.ts";
export type { DayNightConfig, SunMoonState, FogConfig, AtmosphereConfig } from "./scene/sky.ts";
export { DEFAULT_DAY_NIGHT_CONFIG, DEFAULT_FOG_CONFIG, DEFAULT_ATMOSPHERE_CONFIG } from "./scene/sky.ts";
export { VegetationPatch, VegetationWindSystem, generateInstances, packInstanceData } from "./scene/vegetation.ts";
export type { VegetationPatchData, VegetationInstance, WindState } from "./scene/vegetation.ts";

// Telemetry
export { TelemetryCollector } from "./telemetry/collector.ts";
export type { ThreadMetrics, SystemTiming } from "./telemetry/collector.ts";
export { GCTracker } from "./telemetry/gc-tracker.ts";
export { TelemetryReporter } from "./telemetry/reporter.ts";

// Debug Draw
export { DebugDrawQueue } from "./debug-draw/queue.ts";
export type { DebugLine, DebugPoint, DebugText } from "./debug-draw/queue.ts";
export { DebugLines } from "./debug-draw/lines.ts";
export { DebugPoints } from "./debug-draw/points.ts";
export { DebugTextRenderer } from "./debug-draw/text.ts";

// Builder
export { Builder, getBuilderConfig } from "./builder/builder.ts";
export type { BuilderMode, BuilderConfig } from "./builder/builder.ts";

// Scripting
export { ScriptingSystem } from "./scripting/script.ts";
export type { ScriptContext, ScriptHandle, ScriptModule } from "./scripting/script.ts";
export { HotReloader } from "./scripting/hot-reload.ts";
export { createScriptBinding } from "./scripting/binding.ts";
export type { ScriptBinding } from "./scripting/binding.ts";

// Plugin
export type { Plugin, PluginContext, SABChannel } from "./plugin/plugin.ts";
export { PluginRegistry } from "./plugin/registry.ts";
export { PluginHost } from "./plugin/host.ts";
export { TSPluginLoader } from "./plugin/ts-loader.ts";
export { WASMPluginLoader } from "./plugin/wasm-loader.ts";
export type { WASMABIExports, WASMABIImports } from "./plugin/wasm-loader.ts";
export { createABIVTable, WASM_ABI_VERSION } from "./plugin/abi.ts";
export type { ABIVTable } from "./plugin/abi.ts";

// Save
export { SaveSystem } from "./save/migrate.ts";
export { SchemaRegistry, CURRENT_SCHEMA_VERSION } from "./save/schema.ts";
export { Serializer } from "./save/serializer.ts";
export type { SaveData } from "./save/serializer.ts";

// Assets
export { AssetManager } from "./assets/manager.ts";
export type { AssetRef } from "./assets/manager.ts";
export { loadTexture, loadTextureFromImage, loadKTX2Texture, createGPUTextureFromData, createSampler, detectTextureFormat } from "./assets/loader-texture.ts";
export type { TextureData, TextureFormat } from "./assets/loader-texture.ts";
export { GLBLoader } from "./assets/loader-mesh.ts";
export type { GLTFDocument, GLTFNode, GLTFMesh, GLTFPrimitive, GLTFAccessor, GLTFBufferView, GLTFBuffer } from "./assets/loader-mesh.ts";
export { AssetImporter } from "./assets/importer.ts";
export type { ImportOptions, ImportResult } from "./assets/importer.ts";
export { ShaderLoader } from "./assets/loader-shader.ts";
export type { ShaderSource } from "./assets/loader-shader.ts";
export { GPUResourceCache } from "./assets/cache.ts";
export type { GPUCacheEntry } from "./assets/cache.ts";
export { LODGenerator } from "./assets/lod.ts";
export type { LODLevel, LODConfig } from "./assets/lod.ts";
export { loadAudioFile, loadAudioFromBuffer, detectAudioFormat, registerAudioLoader } from "./assets/loader-audio.ts";

// Physics
export type { PhysicsBackend, BodyType, ColliderShape, BodyDesc, ColliderDesc, RigidBodyHandle, RaycastResult, ShapeCastResult, ContactManifold, PhysicsRealmConfig } from "./physics/interface.ts";
export { physicsBackendRegistry } from "./physics/registry.ts";
export { PhysicsRealm } from "./physics/realm.ts";
export { RigidBody, Velocity, PhysicsTransform } from "./physics/body.ts";
export type { RigidBodyData, VelocityData, PhysicsTransformData } from "./physics/body.ts";
export { Collider, createBoxCollider, createSphereCollider, createCapsuleCollider, createMeshCollider, createConvexCollider } from "./physics/collider.ts";
export type { ColliderData } from "./physics/collider.ts";
export { CharacterController, CharacterControllerSystem } from "./physics/character.ts";
export type { CharacterControllerData } from "./physics/character.ts";
export { RaycastQuery } from "./physics/raycast.ts";
export { PhysicsLifecycle } from "./physics/lifecycle.ts";
export type { BootstrapPhase } from "./physics/lifecycle.ts";
export { COLLISION_STARTED_CHANNEL, COLLISION_STOPPED_CHANNEL, CONTACT_CHANNEL, computeCollisionEvents, manifoldToStartedEvent } from "./physics/events.ts";
export type { CollisionStartedEvent, CollisionStoppedEvent, ContactEvent } from "./physics/events.ts";
export { CollisionEventSystem } from "./physics/collision-system.ts";

// Animation
export { Skeleton, buildSkeletonFromGLTF } from "./animation/skeleton.ts";
export type { Bone, SkeletonData, GLTFSkin } from "./animation/skeleton.ts";
export { AnimationClip, buildAnimationClipFromGLTF } from "./animation/clip.ts";
export type { KeyframeTrack, AnimationClipData, TrackPath } from "./animation/clip.ts";
export { AnimationPlayer } from "./animation/player.ts";
export type { PlayingAnimation } from "./animation/player.ts";
export { AnimationStateMachine } from "./animation/state-machine.ts";
export type { AnimationState, AnimationTransition, BlendTree, BlendTree1D, BlendTree2D } from "./animation/state-machine.ts";
export { buildRetargetMapping, retargetClip } from "./animation/retarget.ts";
export type { BoneMapping, RetargetMapping } from "./animation/retarget.ts";
export { MixamoRetargeter, DEFAULT_MIXAMO_CONFIG } from "./animation/mixamo.ts";
export type { MixamoRetargetConfig } from "./animation/mixamo.ts";

// Mesh Skinning
export { SkinnedMesh, BoneTransforms, buildSkinnedMeshFromGLTF, createSkinMatricesBuffer, MAX_BONES } from "./mesh/skinning.ts";
export type { SkinnedMeshData, BoneTransformData } from "./mesh/skinning.ts";

// GPU Skinning Compute Pass
export { SkinningComputePass, packBoneTransforms } from "./render/passes/skinning.ts";
export type { SkinningComputePassResources } from "./render/passes/skinning.ts";

// Audio
export type { AudioBackend, AudioBackendConfig, AudioBufferDesc, AudioSourceHandle, AudioListenerState, AudioChannel, AudioEffectDesc, AudioEffectType, AudioFormat, AudioChannelConfig } from "./audio/interface.ts";
export { DEFAULT_AUDIO_CONFIG } from "./audio/interface.ts";
export { audioBackendRegistry } from "./audio/registry.ts";
export { AudioEngine } from "./audio/engine.ts";
export { AudioSource, createAudioSource, createSpatialAudioSource, createAmbientAudioSource } from "./audio/source.ts";
export type { AudioSourceData } from "./audio/source.ts";
export { AudioListener, createAudioListener, listenerToState } from "./audio/listener.ts";
export type { AudioListenerData } from "./audio/listener.ts";
export { AudioMixer } from "./audio/mixer.ts";
export type { MixerChannelState } from "./audio/mixer.ts";
export { AudioSABChannel, AUDIO_SAB_LAYOUT } from "./audio/sab.ts";
export type { AudioSABData } from "./audio/sab.ts";

// Crash Recovery
export { CrashRecoveryManager, DEFAULT_RECOVERY_CONFIG } from "./worker/crash-recovery.ts";
export type { CrashRecoveryConfig, RecoveryState } from "./worker/crash-recovery.ts";

// UI Panels
export { SceneTreePanel } from "./ui/scene-tree.ts";
export type { SceneTreeNode, SceneTreeState } from "./ui/scene-tree.ts";
export { InspectorPanel } from "./ui/inspector.ts";
export type { InspectorField, InspectorComponent, InspectorState } from "./ui/inspector.ts";
