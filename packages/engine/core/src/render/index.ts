/// <reference path="../webgpu-destroy-augmentation.d.ts" />
// Render sub-barrel — re-exports all render-related items.
export { BindGroupCache } from "./bind-group";
export {
    BINDLESS_MATERIAL_CHUNK,
    BindlessFrameBindings,
    BindlessMaterialManager,
    BindlessTextureRegistry, computeBucketKey, DEFAULT_FORMAT_SLOTS,
    MATERIAL_STRUCT_SIZE, materialIndexAttribute,
    packHandle16
} from "./bindless";
export type {
    BindlessFormatSlot,
    BindlessFrameBindingsOptions,
    MaterialManagerOptions,
    MaterialParams,
    RegisteredTexture,
    TextureBucketKey,
    TextureRegistryOptions
} from "./bindless";
export { ArenaBuffer, RingBuffer } from "./buffer";
export { calculateViewProj, calculateViewProjInto, CameraMode, CameraSystem, dot3, normalize3, transformVec4 } from "./camera";
export type { CameraConfig, CameraState } from "./camera";
export { cameraMatrix, makeCamera2D, PanZoomCamera2D, screenToWorld, updateCamera, worldToScreen, type Camera2D, type Camera2DOptions, type PanZoomCamera2DOptions } from "./camera-2d";
export { CameraController } from "./camera-controller";
export type { CameraControllerOptions, OrbitInputOptions } from "./camera-controller";
export { CanvasResizeWatcher } from "./canvas-resize-watcher";
export type { CanvasResizeHandler } from "./canvas-resize-watcher";
export { DEPTH_FORMAT, MSAA_SAMPLE_COUNT } from "./constants";
export { GPUDeviceManager } from "./device";
export { FrameGraph, PassType, SlotRegistry, TextureHandle } from "./frame-graph";
export type { ColorAttachmentDesc, DepthAttachmentDesc, FrameContext, GraphRenderContext, RenderContext, TextureDesc } from "./frame-graph";
export { computeAABB, cullItems, Frustum, transformAABB } from "./frustum";
export type { AABB, CullableItem, FrustumPlane } from "./frustum";
export { FULLSCREEN_VS } from "./fullscreen-vs";
export { G_BUFFER_FORMATS, GBuffer } from "./g-buffer";
export type { GBufferTextures, GBufferViews } from "./g-buffer";
export { GameRenderer } from "./game-renderer";
export type { CameraViewportInfo, CancelRAF, FrameCallbacks, GameRendererConfig, OffscreenMode, RAFSource, RenderTargetProvider } from "./game-renderer";
export { computeHzbSize, GpuCullPass, GpuMeshTable, HzbBuilder, HzbBuildPass, IndirectDrawPass, INSTANCE_RECORD_BYTES, INSTANCE_RECORD_FLOATS, InstanceBuffer, nextPowerOf2 } from "./gpu-driven";
export type { CullBatchRecord, HzbSize, InstanceRecord, MeshBatch, MeshTableGroup } from "./gpu-driven";
export {
    createBlackTextureView, createDefaultTextureView, createDepthTexture, createStorageBuffer, createUniformBuffer
} from "./gpu-utils";
export { HDRSupport } from "./hdr";
export type { HDRConfig as RenderHDRConfig } from "./hdr";
export { MaterialHotReloader } from "./hot-reload";
export type { HotReloadCallback, WatchedMesh, WatchedShader, WatchedTexture } from "./hot-reload";
export { IBLSystem } from "./ibl";
export type { IBLSystemOptions } from "./ibl";
export { createIBLShaderChunk, IBL_SHADER_CHUNK, IBLBindGroup } from "./ibl-bind-group";
export type { IBLBindGroupOptions } from "./ibl-bind-group";
export { InputManager } from "./input-manager";
export type { RenderInputState } from "./input-manager";
export { createDefaultLightUniform, createDirectionalLight, createHemisphereLight, createPointLight, createRectAreaLight, createSpotLight, DEFAULT_SHADOW_SETTINGS, extractPointAndSpotLights, LightType, lightTypeToStorageType, MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS, packAllLightsToStorage, packLightToStorage, packLightUniform, packPointLights, packSpotLightsExtended } from "./lighting";
export type { DirectionalLight, HemisphereLight, Light, LightUniformData, PointLight, RectAreaLight, ShadowSettings, SpotLight } from "./lighting";
export { createLTCTextures, generateLTCLUTData, LTC_LUT_SIZE, LTC_SHADER_CHUNK } from "./lighting/area-light";
export type { AreaLightData, AreaLightShape, LTCTextureSet } from "./lighting/area-light";
export { ClusterGrid } from "./lighting/cluster-grid";
export { clusterIndex3D, computeClusterCount, computeClusterGridBufferSize, computeLightDataBufferSize, computeLightIndexListSize, DEFAULT_CLUSTER_CONFIG, depthSliceToNear, packClusterUniforms, packLightsArray, packLightToStorageBuffer, screenPosToClusterXY, worldDepthToSlice } from "./lighting/cluster-types";
export type { ClusterGridConfig, ClusterUniforms, GPULightData, LightShapeType } from "./lighting/cluster-types";
export { createIESGpuTexture, iesProfileToTextureData, parseIES } from "./lighting/ies-parser";
export type { IESLoadOptions, IESProfile } from "./lighting/ies-parser";
export { ClusterLightingPass } from "./passes/cluster-lighting-pass";
export { CSMPass, DEFAULT_CSM_SETTINGS } from "./passes/csm";
export type { CSMSettings } from "./passes/csm";
export { CubemapCapturePass } from "./passes/cubemap-capture";
export type { CubemapCaptureOptions } from "./passes/cubemap-capture";
export { DebugRenderPass } from "./passes/debug";
export { DeferredLightingPass } from "./passes/deferred-lighting";
export { DepthPrepass } from "./passes/depth-prepass";
export { Dome360Pass } from "./passes/dome-360";
export type { Dome360Config } from "./passes/dome-360";
export { DEFAULT_FLUID_CONFIG, FluidRenderPass } from "./passes/fluid-render";
export type { FluidConfig } from "./passes/fluid-render";
export { DEFAULT_RSM_CONFIG, packVPLsToBuffer, sampleRSMToVPLs, VPL_FLOATS, VPL_SIZE } from "./passes/gi-types";
export type { RSMConfig, VPLData } from "./passes/gi-types";
export { OpaquePass } from "./passes/opaque";
export type { OpaquePassMode, PBRMaterialResources } from "./passes/opaque";
export { MAX_POINT_LIGHT_SHADOWS, PointLightShadowPass } from "./passes/point-light-shadow";
export type { PointLightShadowData } from "./passes/point-light-shadow";
export { createProceduralGpuTexture, DEFAULT_PROCEDURAL_CONFIG, generateProceduralTexture } from "./passes/procedural-texture";
export type { ProceduralTextureConfig, ProceduralTextureType } from "./passes/procedural-texture";
export type { ReflectionProbeConfig, ReflectionProbeData } from "./passes/reflection-probe";
export { RSMPass } from "./passes/rsm-pass";
export { layoutSDFText, parseSDFFont, SDF_TEXT_SHADER } from "./passes/sdf-text";
export type { SDFFontData, SDFGlyph } from "./passes/sdf-text";
export { ShadowPass } from "./passes/shadow";
export { ShadowMapSystem } from "./passes/shadow-map";
export type { ShadowMapOptions } from "./passes/shadow-map";
export { SkyDomePass } from "./passes/sky-dome";
export type { SkyDomeUniforms } from "./passes/sky-dome";
export { SkyboxPass } from "./passes/skybox";
export { MAX_SPOT_LIGHT_SHADOWS, SpotLightShadowPass } from "./passes/spot-light-shadow";
export type { SpotLightShadowData } from "./passes/spot-light-shadow";
export { TerrainPass } from "./passes/terrain";
export type { TerrainUniforms } from "./passes/terrain";
export { TransparentPass } from "./passes/transparent";
export type { TransparentRenderItem } from "./passes/transparent";
export { UICompositePass } from "./passes/ui-composite";
export { UnderwaterFogPass } from "./passes/underwater-fog";
export { VideoTextureSource } from "./passes/video-texture";
export type { VideoTextureConfig } from "./passes/video-texture";
export { VolumetricLightingPass } from "./passes/volumetric-pass";
export { computeExtinction, computeFroxelCount, computeFroxelGridBufferSize, computeFroxelLightIndexListSize, computeMiePhase, computeOpticalDepth, computeTransmittance, DEFAULT_FROXEL_CONFIG, DEFAULT_VOLUMETRIC_FOG, froxelDepthToSlice, froxelIndex3D, froxelSliceToFar, froxelSliceToNear, packVolumetricUniforms, screenPosToFroxelXY } from "./passes/volumetric-types";
export { WaterPass } from "./passes/water";
export type { WaterUniforms } from "./passes/water";
export { PBRSystem } from "./pbr";
export { PipelineCache } from "./pipeline";
export { RenderPass } from "./render-pass";
export type { FrameGraphBuilder } from "./render-pass";
export { RendererInputBusImpl } from "./renderer-input-bus";
export { RendererModuleHost } from "./renderer-module-host";
export type { RendererModuleHostCallbacks } from "./renderer-module-host";
export { SabCanvasOverlay } from "./sab-canvas-overlay";
export type { SabCanvasOverlayOptions } from "./sab-canvas-overlay";
export { clearShaderValidationDedup, createValidatedShaderModule, createValidatedShaderModuleAsync, installShaderValidationGuard } from "./shader-validator";
export { CSM_SHADER_CHUNK, POINT_SHADOW_SHADER_CHUNK, SPOT_SHADOW_SHADER_CHUNK } from "./shaders/shadow-chunks";
export { SkyboxRenderer } from "./skybox";
export type { SkyboxOptions } from "./skybox";
export { SurfaceManager } from "./surface";
export { DEFAULT_TONE_MAPPING_SETTINGS, getToneMappingOperatorIndex, TONE_MAPPING_SHADER_CHUNK, ToneMappingOperator } from "./tonemap";
export type { ToneMappingSettings } from "./tonemap";
export { TrackedRenderPass } from "./tracked-render-pass";
export type { ITrackedRenderPass } from "./tracked-render-pass";
export { ViewportLayout, viewportRectToPixels } from "./viewport";
export type { ViewportMode, ViewportRect } from "./viewport";
export { wgslHotReload } from "./wgsl-hmr";
export type { WgslReloadFn } from "./wgsl-hmr";

// Decal passes (from mesh section in original barrel)
export { computeDecalProjectionMatrix, computeDecalViewMatrix, createDecalMesh } from "./passes/decal-mesh";
export type { DecalProjector } from "./passes/decal-mesh";
export { DecalPass } from "./passes/decal-pass";
export type { DecalItem } from "./passes/decal-pass";
export { GreasedLinePass } from "./passes/greased-line-pass";

// Skinning passes (from animation section in original barrel)
export { packBoneTransformsVec4, VertexSkinningPass } from "./passes/skinning";
export { createSkinningPass, MAX_BONE_INFLUENCES, MAX_BONES_VS, SKINNING_VS_GLSL, SKINNING_VS_WGSL } from "./passes/skinning-vs";
export type { SkinningMode, SkinningPass } from "./passes/skinning-vs";

// GPU Skinning Compute Pass
export { packBoneTransforms, SkinningComputePass } from "./passes/skinning";
export type { SkinningComputePassResources } from "./passes/skinning";

// Compute Graph Pass + Kernel Helper
export { runComputeKernel } from "./compute-kernel";
export type { ComputeKernelInput, ComputeKernelResult } from "./compute-kernel";
export { GraphComputePass } from "./passes/graph-compute";
export type { GraphComputeBuffer } from "./passes/graph-compute";

// Debug Visualization
export { DebugVizPass, DEFAULT_DEBUG_VIZ_SETTINGS } from "./passes/debug-viz";
export type { DebugVizMode, DebugVizSettings } from "./passes/debug-viz";

// Split-Screen Layout
export { computeViewports, getLayoutForPlayerCount, getPlayerCountForLayout } from "./splitscreen";
export type { SplitscreenLayoutType, ViewportSlot } from "./splitscreen";

// GPU Resource Tracker (destroy helpers)
export { destroyAll, destroyAndNull, destroyMapValues } from "./resource-tracker";
export type { Destroyable } from "./resource-tracker";

