// ============================================================================
// RendererAccessors — all getters/setters for WebGPURenderer
// Extracted from WebGPURenderer for modularity
// ============================================================================

import { MaterialLibrary, MSAA_SAMPLE_COUNT, type GPUProfiler, type GPUResourceTracker, type LayoutEngine, type PBRSystem, type PostProcessStack, type DebugOverlay as ProfilingOverlay, type TelemetryCollector, type UIInputRouter, type UIRenderer, type UIRoot } from "@downdraft/core";
import type { DebugOverlay, DebugRaycast, GizmoMode, TransformGizmo } from "@downdraft/module-devtools";
import type { ModelRenderer } from "@downdraft/library-entities";
import type { LightSystem } from "@downdraft/library-lighting";
import { materialDataArrayToMaterials, type MaterialData, type MeshData } from "@downdraft/library-models";
import type { PixelationSystem } from "@downdraft/library-postfx";
import type { ParticleSystem } from "@downdraft/library-weatherfx";
import type { BoatBufferReader } from "@to-the-ocean/library-boats/boat-sab";
import type { SimBufferReader } from "@downdraft/core";
import { PLR } from "@downdraft/core";
import type { WaterBufferReader } from "@downdraft/library-water";
import type { CameraSystem } from "./camera-system";
import type { EntityRenderer } from "./entity-renderer";

export class RendererAccessors {
  // Public state (read/write by WebGPURenderer)
  fps = 0;
  debugMode = false;
  flashlightOn = false;
  uiNeedsLayout = true;

  // Private references set via setReferences
  private simReader: SimBufferReader | null = null;
  private waterReader: WaterBufferReader | null = null;
  private entityRenderer: EntityRenderer | null = null;
  private uiRoot: UIRoot | null = null;
  private uiInputRouter: UIInputRouter | null = null;
  private telemetryCollector: TelemetryCollector | null = null;
  private gpuProfiler: GPUProfiler | null = null;
  private gpuResourceTracker: GPUResourceTracker | null = null;
  private pixelationSystem: PixelationSystem | null = null;
  private postProcessStack: PostProcessStack | null = null;
  private boatReader: BoatBufferReader | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private viewports: { x: number; y: number; w: number; h: number }[] = [];
  private debugRaycast: DebugRaycast | null = null;
  private debugOverlay: DebugOverlay | null = null;
  private profilingOverlay: ProfilingOverlay | null = null;
  private particleSystem: ParticleSystem | null = null;
  private cameraSystem: CameraSystem | null = null;
  private modelRenderer: ModelRenderer | null = null;
  private transformGizmo: TransformGizmo | null = null;
  private lightingSystem: LightSystem | null = null;
  private pbrSystem: PBRSystem | null = null;
  private uiRenderer: UIRenderer | null = null;
  private uiLayoutEngine: LayoutEngine | null = null;
  // Core material library — MaterialData from loaded models is bridged into
  // this library via materialDataArrayToMaterials, making the unified core
  // material surface the single source of truth for the game's materials.
  private materialLibrary: MaterialLibrary | null = null;

  // Gizmo state (stored but not read by renderer)
  private gizmoEnabled = false;
  private gizmoMode: GizmoMode = "translate";

  setReferences(refs: {
    simReader: SimBufferReader | null;
    waterReader: WaterBufferReader | null;
    entityRenderer: EntityRenderer | null;
    uiRoot: UIRoot | null;
    uiInputRouter: UIInputRouter | null;
    telemetryCollector: TelemetryCollector | null;
    gpuProfiler: GPUProfiler | null;
    gpuResourceTracker: GPUResourceTracker | null;
    pixelationSystem: PixelationSystem | null;
    postProcessStack: PostProcessStack | null;
    boatReader: BoatBufferReader | null;
    canvas: HTMLCanvasElement | null;
    viewports: { x: number; y: number; w: number; h: number }[];
    debugRaycast: DebugRaycast | null;
    debugOverlay: DebugOverlay | null;
    profilingOverlay: ProfilingOverlay | null;
    particleSystem: ParticleSystem | null;
    cameraSystem: CameraSystem | null;
    modelRenderer: ModelRenderer | null;
    transformGizmo: TransformGizmo | null;
    lightingSystem: LightSystem | null;
    pbrSystem: PBRSystem | null;
    uiRenderer: UIRenderer | null;
    uiLayoutEngine: LayoutEngine | null;
  }): void {
    this.simReader = refs.simReader;
    this.waterReader = refs.waterReader;
    this.entityRenderer = refs.entityRenderer;
    this.uiRoot = refs.uiRoot;
    this.uiInputRouter = refs.uiInputRouter;
    this.telemetryCollector = refs.telemetryCollector;
    this.gpuProfiler = refs.gpuProfiler;
    this.gpuResourceTracker = refs.gpuResourceTracker;
    this.pixelationSystem = refs.pixelationSystem;
    this.postProcessStack = refs.postProcessStack;
    this.boatReader = refs.boatReader;
    this.canvas = refs.canvas;
    this.viewports = refs.viewports;
    this.debugRaycast = refs.debugRaycast;
    this.debugOverlay = refs.debugOverlay;
    this.profilingOverlay = refs.profilingOverlay;
    this.particleSystem = refs.particleSystem;
    this.cameraSystem = refs.cameraSystem;
    this.modelRenderer = refs.modelRenderer;
    this.transformGizmo = refs.transformGizmo;
    this.lightingSystem = refs.lightingSystem;
    this.pbrSystem = refs.pbrSystem;
    this.uiRenderer = refs.uiRenderer;
    this.uiLayoutEngine = refs.uiLayoutEngine;
  }

  // --- FPS / Debug ---
  getFPS(): number { return this.fps; }
  setDebugMode(enabled: boolean): void { this.debugMode = enabled; }

  // --- Entity Renderer ---
  setShowHitboxes(show: boolean): void { this.entityRenderer?.setShowHitboxes(show); }
  setShowLightGizmos(show: boolean): void { if (this.lightingSystem) this.lightingSystem.showDebugGizmos = show; }
  setShowRaycast(show: boolean): void { this.debugRaycast?.setShow(show); }
  getEntityRenderer(): EntityRenderer | null { return this.entityRenderer; }

  // --- UI ---
  getUIRoot(): UIRoot | null { return this.uiRoot; }
  getUIInputRouter(): UIInputRouter | null { return this.uiInputRouter; }
  markUILayoutDirty(): void { this.uiNeedsLayout = true; }
  updateUIScreenSize(): void {
    if (this.uiRenderer && this.uiRoot && this.canvas) {
      this.uiRenderer.setScreenSize(this.canvas.width, this.canvas.height);
      this.uiRoot.width = this.canvas.width;
      this.uiRoot.height = this.canvas.height;
      this.uiNeedsLayout = true;
    }
    this.profilingOverlay?.setScreenSize(this.canvas?.width ?? 0, this.canvas?.height ?? 0);
  }
  toggleProfilingOverlay(): void {
    if (!this.profilingOverlay || !this.uiRoot) return;
    this.profilingOverlay.toggle();
    if (this.profilingOverlay.isVisible()) {
      this.uiRoot.addChild(this.profilingOverlay.getPanel());
    } else {
      this.uiRoot.removeChild(this.profilingOverlay.getPanel());
    }
    this.uiNeedsLayout = true;
  }
  isProfilingOverlayVisible(): boolean { return this.profilingOverlay?.isVisible() ?? false; }

  // --- Telemetry / GPU ---
  getTelemetryCollector(): TelemetryCollector | null { return this.telemetryCollector; }
  getAdapterInfo(): any { return this.gpuProfiler?.getAdapterInfo() ?? null; }
  getGPUErrors(): Array<{ timestamp: number; message: string; label?: string }> { return this.gpuProfiler?.getGPUErrors() ?? []; }
  clearGPUErrors(): void { this.gpuProfiler?.clearGPUErrors(); }
  getGPUResourceTracker(): GPUResourceTracker | null { return this.gpuResourceTracker; }
  getGPUProfiler(): GPUProfiler | null { return this.gpuProfiler; }
  getGPUInfo(): any {
    if (!this.gpuProfiler || !this.canvas) return null;
    return this.gpuProfiler.getGPUInfo(this.canvas, MSAA_SAMPLE_COUNT);
  }
  getFrameTelemetry(): any {
    if (!this.telemetryCollector) return null;
    return this.telemetryCollector.getFrameTelemetry();
  }

  // --- Post-processing ---
  getPostProcessInfo(): { pixelationEnabled: boolean; pixelSize: number; postProcessEffects: string[] } {
    return {
      pixelationEnabled: this.pixelationSystem?.isEnabled() ?? false,
      pixelSize: this.pixelationSystem?.getPixelSize() ?? 4,
      postProcessEffects: this.postProcessStack?.getEnabledEffects() ?? [],
    };
  }
  setPixelationEnabled(enabled: boolean): void { this.pixelationSystem?.setEnabled(enabled); }
  setPixelSize(size: number): void { this.pixelationSystem?.setPixelSize(size); }
  setDepthEdgeStrength(strength: number): void { this.pixelationSystem?.setDepthEdgeStrength(strength); }
  setPostProcessEnabled(id: "fxaa" | "dof" | "sobel" | "afterimage" | "bloom" | "ascii", enabled: boolean): void { this.postProcessStack?.setEnabled(id, enabled); }
  setDOFFocusDist(v: number): void { this.postProcessStack?.setDOFFocusDist(v); }
  setDOFFocusRange(v: number): void { this.postProcessStack?.setDOFFocusRange(v); }
  setDOFMaxBlur(v: number): void { this.postProcessStack?.setDOFMaxBlur(v); }
  setAfterimageDamp(v: number): void { this.postProcessStack?.setAfterimageDamp(v); }
  setBloomThreshold(v: number): void { this.postProcessStack?.setBloomThreshold(v); }
  setBloomStrength(v: number): void { this.postProcessStack?.setBloomStrength(v); }
  setASCIICellSize(v: number): void { this.postProcessStack?.setASCIICellSize(v); }
  setASCIIUseColor(v: boolean): void { this.postProcessStack?.setASCIIUseColor(v); }

  // --- Particles ---
  setParticleDensity(density: number): void { if (this.particleSystem) this.particleSystem.particleDensityMultiplier = density; }
  setParticleCullDistance(dist: number): void { if (this.particleSystem) this.particleSystem.particleCullDistance = dist; }

  // --- Camera ---
  setFirstPersonSensitivity(v: number): void { this.cameraSystem?.setFirstPersonSensitivity(v); }
  setThirdPersonSensitivity(v: number): void { this.cameraSystem?.setThirdPersonSensitivity(v); }
  setFreecamSensitivity(v: number): void { this.cameraSystem?.setFreecamSensitivity(v); }

  // --- PBR ---
  getLUTReady(): Promise<void> { return this.pbrSystem?.lutReady ?? Promise.resolve(); }

  // --- Hitbox ---
  setHitboxLineWidth(width: number): void { this.entityRenderer?.setHitboxLineWidth(width); }
  getHitboxLineWidth(): number { return this.entityRenderer?.getHitboxLineWidth() ?? 3; }

  // --- Debug overlay ---
  setShowChunkGrid(show: boolean): void { this.debugOverlay?.setShowChunkGrid(show); }
  isChunkGridVisible(): boolean { return this.debugOverlay?.isChunkGridVisible() ?? false; }
  setShowVelocityArrows(show: boolean): void { this.debugOverlay?.setShowVelocityArrows(show); }
  isVelocityArrowsVisible(): boolean { return this.debugOverlay?.isVelocityArrowsVisible() ?? false; }

  // --- Buffers / Canvas ---
  getSimReader(): SimBufferReader | null { return this.simReader; }
  getWaterReader(): WaterBufferReader | null { return this.waterReader; }
  getCanvasWidth(): number { return this.canvas?.width ?? 0; }
  getCanvasHeight(): number { return this.canvas?.height ?? 0; }
  getViewportWidth(idx: number): number { return this.viewports[idx]?.w ?? 0; }
  getViewportHeight(idx: number): number { return this.viewports[idx]?.h ?? 0; }
  getBoatReader(): BoatBufferReader | null { return this.boatReader; }

  // --- Flashlight ---
  toggleFlashlight(): void { this.flashlightOn = !this.flashlightOn; }
  isFlashlightOn(): boolean { return this.flashlightOn; }

  // --- Model renderer ---
  uploadModel(nodeId: string, meshes: MeshData[], materials?: MaterialData[]): void {
    // Bridge MaterialData into the core MaterialLibrary so the unified material
    // surface (editor, library, graph pipeline) is the single source of truth.
    // The bindless ModelRenderer render path continues to use the MaterialData
    // directly for GPU upload; the library registration makes materials
    // discoverable/editable via the core surface.
    if (materials && materials.length > 0 && this.materialLibrary) {
      materialDataArrayToMaterials(materials, this.materialLibrary);
    }
    this.modelRenderer?.uploadModel(nodeId, meshes, materials);
  }
  removeModel(nodeId: string): void { this.modelRenderer?.removeModel(nodeId); }

  /** Set the core MaterialLibrary that bridged MaterialData is registered into. */
  setMaterialLibrary(library: MaterialLibrary): void { this.materialLibrary = library; }
  getMaterialLibrary(): MaterialLibrary | null { return this.materialLibrary; }

  // --- Gizmo ---
  setGizmoMode(mode: GizmoMode): void { this.gizmoMode = mode; this.transformGizmo?.setMode(mode); }
  setGizmoVisible(visible: boolean): void { this.gizmoEnabled = visible; this.transformGizmo?.setVisible(visible); }
  setGizmoPosition(pos: [number, number, number]): void { this.transformGizmo?.setPosition(pos); }

  // --- Player position ---
  getPlayerWorldPos(viewportIdx: number): { x: number; y: number; z: number } | null {
    if (!this.simReader || !this.simReader.isValid()) return null;
    const playerSlot = this.simReader.getPlayerSlot(viewportIdx);
    if (!playerSlot) return null;
    return {
      x: playerSlot.f32[PLR.POS_X],
      y: playerSlot.f32[PLR.POS_Y],
      z: playerSlot.f32[PLR.POS_Z],
    };
  }
}
