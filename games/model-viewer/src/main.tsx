// ============================================================================
// Model Viewer — Main Entry Point
// WebGPU init, render loop, model loading pipeline
// ============================================================================

import {
    BindlessFrameBindings,
    BindlessMaterialManager,
    BindlessTextureRegistry,
    DEPTH_FORMAT,
    FrameGraph,
    GCController,
    GPUProfiler,
    GPUResourceTracker,
    PassType,
    RenderPass,
    RendererInputBusImpl,
    TelemetryCollector,
    type FrameGraphBuilder,
    type GCControllerConfig,
    type RenderContext,
} from "@downdraft/core";
import { ModelRenderer } from "@downdraft/library-entities";
import { createCameraController } from "@downdraft/plugin-camera-controls";
import { BaseSceneInspector, type IAssetResolver, type IDevToolsRenderer } from "@downdraft/plugin-devtools";
import type { MeshData } from "@downdraft/plugin-models";
import React from "react";
import { createRoot } from "react-dom/client";
import { updateAnimDisplay } from "./anim-display";
import { ModelAnimator } from "./animation";
import App from "./app";
import { GizmoManager } from "./gizmo-manager";
import { GridRenderer } from "./grid-renderer";
import { HeightRulerRenderer } from "./height-ruler-renderer";
import {
    discoverModels,
    loadModelWithTextures,
    reloadModelWithSettings,
    writeSidecar,
    type LoadedModel,
    type ModelEntry
} from "./model-loader";
import { SkeletonRenderer } from "./skeleton-renderer";
import "./styles/globals.css";

/** Compose a column-major 4x4 model matrix from translation, rotation (quaternion), and uniform scale.
 *  Matches the ModelRenderer's transform: worldPos = rotate(rot, vertex * scale) + pos */
function composeModelMatrix(pos: [number, number, number], rot: [number, number, number, number], scale: number): Float32Array {
  const x = rot[0], y = rot[1], z = rot[2], w = rot[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  // Column-major: m[col*4 + row]
  const m = new Float32Array(16);
  m[0] = (1 - (yy + zz)) * scale;
  m[1] = (xy + wz) * scale;
  m[2] = (xz - wy) * scale;
  m[3] = 0;
  m[4] = (xy - wz) * scale;
  m[5] = (1 - (xx + zz)) * scale;
  m[6] = (yz + wx) * scale;
  m[7] = 0;
  m[8] = (xz + wy) * scale;
  m[9] = (yz - wx) * scale;
  m[10] = (1 - (xx + yy)) * scale;
  m[11] = 0;
  m[12] = pos[0];
  m[13] = pos[1];
  m[14] = pos[2];
  m[15] = 1;
  return m;
}

function computeMeshBounds(meshes: MeshData[]): { min: [number, number, number]; max: [number, number, number] } {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const mesh of meshes) {
    for (let v = 0; v < mesh.vertexCount; v++) {
      const x = mesh.vertices[v * 6];
      const y = mesh.vertices[v * 6 + 1];
      const z = mesh.vertices[v * 6 + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  }
  if (minX === Infinity) {
    return { min: [-1, -1, -1], max: [1, 1, 1] };
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

// Transform raw model-space bounds into the world-space bounds the renderer
// actually draws. MUST mirror the render-section transform in `frame()`:
// no scaling (1 world unit = 1 meter), no base rotation (normalization
// pipeline handles up-axis), centering at world origin, then Y offset so the
// model rests on the grid (bottom at y=0).
// If the renderer's base rotation, centering, or grid offset changes, update this too.
function computeWorldBounds(
  rawBounds: { min: [number, number, number]; max: [number, number, number] },
  fullBounds: { min: [number, number, number]; max: [number, number, number] },
  _upAxis?: unknown,
): { min: [number, number, number]; max: [number, number, number] } {
  const cx = (fullBounds.min[0] + fullBounds.max[0]) / 2;
  const cy = (fullBounds.min[1] + fullBounds.max[1]) / 2;
  const cz = (fullBounds.min[2] + fullBounds.max[2]) / 2;

  // No scaling — 1 world unit = 1 meter. Camera framing adjusts distance.
  // Model rests on the grid (bottom at y=0): add half-height Y offset to
  // mirror the render section's `pos[1] += modelHeight / 2`.
  const yOffset = (fullBounds.max[1] - fullBounds.min[1]) / 2;
  const wxMin = rawBounds.min[0] - cx;
  const wxMax = rawBounds.max[0] - cx;
  const wyMin = rawBounds.min[1] - cy + yOffset;
  const wyMax = rawBounds.max[1] - cy + yOffset;
  const wzMin = rawBounds.min[2] - cz;
  const wzMax = rawBounds.max[2] - cz;
  return {
    min: [Math.min(wxMin, wxMax), Math.min(wyMin, wyMax), Math.min(wzMin, wzMax)],
    max: [Math.max(wxMin, wxMax), Math.max(wyMin, wyMax), Math.max(wzMin, wzMax)],
  };
}

function getRenderedMeshes(): MeshData[] | null {
  const m = state.currentModel;
  if (!m) return null;
  let meshes = m.data.meshes;
  if (state.selectedPartIndices !== null && state.selectedPartIndices.size > 0) {
    const selectedMeshIndices = new Set<number>();
    for (const partIdx of state.selectedPartIndices) {
      const part = m.stats.parts[partIdx];
      if (part?.hasMesh) {
        for (const mi of part.meshIndices) selectedMeshIndices.add(mi);
      }
    }
    meshes = m.data.meshes.filter((_, i) => selectedMeshIndices.has(i));
  }
  return meshes;
}

// Asset base — the UNSORTED directory in to-the-ocean assets
const ASSET_BASE =
  "/@fs/home/knackstedt/Pivot/source/apophis/downdraft-engine/games/to-the-ocean/src/assets/UNSORTED";

// ── Global state shared with React UI ──

interface ViewerState {
  models: ModelEntry[];
  currentModel: LoadedModel | null;
  loading: boolean;
  error: string | null;
  autoRotate: boolean;
  showGrid: boolean;
  showHeightRuler: boolean;
  showSkeleton: boolean;
  /** Index of the bone being manipulated in the skeleton debugger, or null. */
  skeletonBoneIndex: number | null;
  /** Offset applied to the selected bone's rest position for debugging. */
  skeletonBoneOffset: [number, number, number];
  wireframe: boolean;
  selectedPartIndices: Set<number> | null; // null = show all parts
  // Animation
  animationIndex: number | null; // null = none
  animationPlaying: boolean;
  animationTime: number; // seconds
  // Parts grouping
  groupMode: "tree" | "prefix";
}

const state: ViewerState = {
  models: [],
  currentModel: null,
  loading: false,
  error: null,
  autoRotate: true,
  showGrid: true,
  showHeightRuler: false,
  showSkeleton: false,
  skeletonBoneIndex: null,
  skeletonBoneOffset: [0, 0, 0],
  wireframe: false,
  selectedPartIndices: null,
  animationIndex: null,
  animationPlaying: false,
  animationTime: 0,
  groupMode: "tree",
};

const listeners = new Set<() => void>();
function notify() { listeners.forEach((l) => l()); }
function subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }
function getState() { return state; }
function selectPart(nodeIndex: number) {
  if (!state.currentModel) return;
  if (state.selectedPartIndices === null) {
    state.selectedPartIndices = new Set();
  }
  if (state.selectedPartIndices.has(nodeIndex)) {
    state.selectedPartIndices.delete(nodeIndex);
  } else {
    state.selectedPartIndices.add(nodeIndex);
  }
  // If all parts selected, switch back to null (show all)
  const totalParts = state.currentModel.stats.parts.filter(p => p.hasMesh).length;
  if (state.selectedPartIndices.size === 0 || state.selectedPartIndices.size === totalParts) {
    state.selectedPartIndices = null;
  }
  rebuildModel();
  notify();
}
function selectAllParts() {
  state.selectedPartIndices = null;
  rebuildModel();
  notify();
}
function selectOnlyPart(nodeIndex: number) {
  state.selectedPartIndices = new Set([nodeIndex]);
  rebuildModel();
  notify();
}

// ── Animation controls ──

function selectAnimation(index: number | null) {
  state.animationIndex = index;
  state.animationTime = 0;
  state.animationPlaying = index !== null;
  notify();
}

function togglePlay() {
  if (state.animationIndex === null) return;
  state.animationPlaying = !state.animationPlaying;
  notify();
}

function seekAnimation(time: number) {
  state.animationTime = time;
  notify();
}

// ── Parts grouping controls ──

function setGroupMode(mode: "tree" | "prefix") {
  state.groupMode = mode;
  notify();
}

// Toggle every mesh part in a group: if all are selected, deselect them;
// otherwise add them to the selection. Mirrors selectPart's collapse-to-null
// behaviour when the result is all-selected or none-selected.
function toggleGroupParts(indices: number[]) {
  if (!state.currentModel) return;
  const meshIndices = indices.filter((i) => state.currentModel!.stats.parts[i]?.hasMesh);
  if (meshIndices.length === 0) return;

  const selected = state.selectedPartIndices;
  if (selected === null) {
    // Currently showing all → deselect everything except this group's parts
    const next = new Set<number>();
    for (const p of state.currentModel.stats.parts) {
      if (p.hasMesh && !meshIndices.includes(p.nodeIndex)) next.add(p.nodeIndex);
    }
    state.selectedPartIndices = next;
  } else {
    const allIn = meshIndices.every((i) => selected.has(i));
    if (allIn) {
      for (const i of meshIndices) selected.delete(i);
    } else {
      for (const i of meshIndices) selected.add(i);
    }
  }

  const totalParts = state.currentModel.stats.parts.filter(p => p.hasMesh).length;
  const after = state.selectedPartIndices;
  if (after !== null && (after.size === 0 || after.size === totalParts)) {
    state.selectedPartIndices = null;
  }
  rebuildModel();
  notify();
}

// ── WebGPU setup ──

async function initWebGPU(canvas: HTMLCanvasElement): Promise<{
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
}> {
  if (!navigator.gpu) throw new Error("WebGPU not supported");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No GPU adapter found");
  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format,
    alphaMode: "premultiplied",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  return { device, context, format };
}

// ── Depth texture cache ──

const depthTextureCache = new Map<string, GPUTexture>();

function getDepthTexture(device: GPUDevice, w: number, h: number): GPUTexture {
  const key = `${w}x${h}`;
  let tex = depthTextureCache.get(key);
  if (tex) return tex;
  tex = device.createTexture({
    size: [w, h, 1],
    format: DEPTH_FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  depthTextureCache.set(key, tex);
  return tex;
}

// ── Main bootstrap ──

async function bootstrap() {
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <React.StrictMode>
      <App
        getState={getState}
        subscribe={subscribe}
        onSelectModel={selectModel}
        onSelectPart={selectPart}
        onSelectOnlyPart={selectOnlyPart}
        onSelectAllParts={selectAllParts}
        onSelectAnimation={selectAnimation}
        onTogglePlay={togglePlay}
        onSeek={seekAnimation}
        onSetGroupMode={setGroupMode}
        onToggleGroupParts={toggleGroupParts}
        onApplyMetadata={applyMetadata}
        onSaveMetadata={saveMetadata}
        currentEntryPath={_currentEntry?.path ?? null}
        onSetSkeletonBone={setSkeletonBone}
        onSetSkeletonBoneOffset={setSkeletonBoneOffset}
      />
    </React.StrictMode>,
  );

  const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;
  if (!canvas) {
    console.error("No canvas element found");
    return;
  }

  // Discover models first (doesn't need WebGPU)
  state.loading = true;
  notify();
  try {
    state.models = await discoverModels(ASSET_BASE);
    state.loading = false;
    notify();
  } catch (e) {
    state.loading = false;
    state.error = `Failed to discover models: ${(e as Error).message}`;
    notify();
  }

  // Init WebGPU
  let device: GPUDevice | null = null;
  let context: GPUCanvasContext | null = null;
  let format: GPUTextureFormat = "bgra8unorm";

  try {
    const gpu = await initWebGPU(canvas);
    device = gpu.device;
    context = gpu.context;
    format = gpu.format;
  } catch (e) {
    state.error = `WebGPU unavailable: ${(e as Error).message}`;
    notify();
  }

  // If no WebGPU, stop here — UI still shows model list and stats
  if (!device || !context) {
    // Still try to load first model for stats display
    if (state.models.length > 0) {
      await selectModel(state.models[0]);
    }
    return;
  }

  // Init renderers
  const bindlessRegistry = new BindlessTextureRegistry(device);
  const bindlessMaterialManager = new BindlessMaterialManager(device);
  const bindlessFrameBindings = new BindlessFrameBindings(device, bindlessRegistry, bindlessMaterialManager);

  const modelRenderer = new ModelRenderer(device, format);
  modelRenderer.setBindlessDeps({
    registry: bindlessRegistry,
    materialManager: bindlessMaterialManager,
    bindGroupLayout: bindlessFrameBindings.getBindGroupLayout(),
  });
  await modelRenderer.init();
  _modelRenderer = modelRenderer;

  const gridRenderer = new GridRenderer(device, format);
  gridRenderer.init();

  const heightRulerRenderer = new HeightRulerRenderer(device, format);
  heightRulerRenderer.init();
  _heightRulerRenderer = heightRulerRenderer;

  const skeletonRenderer = new SkeletonRenderer(device, format);
  skeletonRenderer.init();
  _skeletonRenderer = skeletonRenderer;

  // FrameGraph — single orchestration path for the render pass.
  const frameGraph = new FrameGraph();
  const graphColorHandle = frameGraph.importTextureView("color", null);
  const graphDepthHandle = frameGraph.importTextureView("depth", null);

  // Telemetry / profiler / GC — wired into DevTools tabs.
  const gpuResourceTracker = new GPUResourceTracker();
  gpuResourceTracker.wrapDevice(device);
  const gpuProfiler = new GPUProfiler();
  gpuProfiler.init(device, null, format, 16);
  const telemetryCollector = new TelemetryCollector(true);
  const gcController = new GCController("renderer");

  // FPS tracking
  let fps = 0;
  let fpsFrameCount = 0;
  let fpsLastTime = performance.now();
  let lastResourceStatsTime = 0;

  // Init camera controller + input bus via the camera-controls plugin helper.
  // The model-viewer has a bespoke render loop (not GameRenderer-based), so we
  // use `createCameraController` instead of `createCameraControlsPlugin`.
  const inputBus = new RendererInputBusImpl(canvas);
  const cameraController = createCameraController(inputBus, {
    initialCamera: { fov: 45, near: 0.1, far: 500 },
    orbit: {
      rotateSpeed: 0.005,
      panSpeed: 0.002,
      zoomSpeed: 0.1,
      minDistance: 0.1,
      maxDistance: 500,
    },
  });

  // Gizmo manager for bone manipulation
  const gizmoManager = new GizmoManager();
  _gizmoManager = gizmoManager;

  // Gizmo input handlers — high priority (50) so they run before the camera
  // controller (100) and can stopPropagation to block camera rotation during
  // gizmo dragging.
  const getCanvasSize = () => {
    const dpr = Math.min(window.devicePixelRatio, 2);
    return { w: canvas.clientWidth * dpr, h: canvas.clientHeight * dpr };
  };

  inputBus.onPointerDown((e: PointerEvent, ctrl) => {
    if (!state.showSkeleton || state.skeletonBoneIndex === null) return;
    if (e.button !== 0) return; // left button only
    gizmoManager.setModelMatrix(_latestModelMatrix);
    const { w, h } = getCanvasSize();
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (w / rect.width);
    const my = (e.clientY - rect.top) * (h / rect.height);
    const cam = cameraController.getCameraState(0);
    if (!cam) return;
    const started = gizmoManager.startDrag(mx, my, cam, w, h, state.skeletonBoneOffset);
    if (started) {
      ctrl.stopPropagation();
    }
  }, 50);

  inputBus.onPointerMove((e: PointerEvent, ctrl) => {
    if (!state.showSkeleton || state.skeletonBoneIndex === null) return;
    gizmoManager.setModelMatrix(_latestModelMatrix);
    const { w, h } = getCanvasSize();
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (w / rect.width);
    const my = (e.clientY - rect.top) * (h / rect.height);
    const cam = cameraController.getCameraState(0);
    if (!cam) return;

    if (gizmoManager.isDragging()) {
      const newOffset = gizmoManager.updateDrag(mx, my);
      if (newOffset) {
        state.skeletonBoneOffset = newOffset;
        rebuildSkeleton();
        notify();
      }
      ctrl.stopPropagation();
    } else {
      // Hover detection
      const hovered = gizmoManager.pickAxis(mx, my, cam, w, h);
      gizmoManager.setHovered(hovered);
      if (hovered) {
        canvas.style.cursor = "pointer";
      } else {
        canvas.style.cursor = "";
      }
    }
  }, 50);

  inputBus.onPointerUp((_e: PointerEvent, _ctrl) => {
    if (gizmoManager.isDragging()) {
      gizmoManager.endDrag();
      canvas.style.cursor = "";
    }
  }, 50);

  // Resize handler
  function resize() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = Math.floor(canvas.clientWidth * dpr);
    const h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    cameraController.setAspect(w, h);
  }
  resize();
  window.addEventListener("resize", resize);

  // Auto-load first model AFTER renderer and camera are ready
  if (state.models.length > 0) {
    await selectModel(state.models[0]);
  }

  // Render loop
  let rotationAngle = 0;
  let lastFrameTime = performance.now();
  function frame() {
    const now = performance.now();
    const dt = (now - lastFrameTime) / 1000;
    lastFrameTime = now;

    resize();

    // Advance animation timeline
    if (state.animationPlaying && state.animationIndex !== null) {
      const anim = state.currentModel?.stats.animations[state.animationIndex];
      if (anim && anim.duration > 0) {
        state.animationTime += dt;
        if (state.animationTime >= anim.duration) {
          state.animationTime = state.animationTime % anim.duration;
        }
        // Update the scrubber + time text directly via the DOM (no React
        // re-render). The GPU animation sampling below still runs at full
        // frame rate.
        updateAnimDisplay(state.animationTime, anim.duration);
      }
    }

    // Sample the active animation (or bind pose) into skin matrices for the
    // current skinned model, then upload them to the renderer. Done every frame
    // so scrubbing and bind-pose rest both stay correct.
    if (_animator && _modelRenderer) {
      _animator.sample(state.animationIndex, state.animationTime);
      _modelRenderer.updateSkinMatrices(_animator.skinMatrices);
    }

    // Update the skeleton visualization from the animated bone world matrices
    // so it reflects the current animation pose instead of the static rest pose.
    if (_animator && _skeletonRenderer && state.showSkeleton) {
      _skeletonRenderer.updateBonePositions(
        _animator.getBoneWorldMatrices(),
        _animator.normalizationMatrix,
      );
    }

    // Frame new model on load
    const pending = (window as any).__pendingFrame;
    if (pending) {
      cameraController.frameBounds(pending.min, pending.max);
      (window as any).__pendingFrame = null;
    }

    const W = canvas.width;
    const H = canvas.height;
    if (W === 0 || H === 0) {
      requestAnimationFrame(frame);
      return;
    }

    // Auto-rotate
    if (state.autoRotate && state.currentModel) {
      rotationAngle += 0.002;
    }

    const camera = cameraController.getCameraState(0);

    // Begin frame
    modelRenderer.beginFrame(camera);
    // Prepare bindless bind group for the frame and wire it into the model renderer.
    modelRenderer.setBindlessBindGroup(bindlessFrameBindings.prepareFrame());

    const encoder = device!.createCommandEncoder();
    gpuProfiler.beginFrame();

    // Drive the render pass through the FrameGraph.
    const colorView = context!.getCurrentTexture().createView();
    const depthView = getDepthTexture(device!, W, H).createView();
    frameGraph.setImportedTextureView(graphColorHandle, colorView);
    frameGraph.setImportedTextureView(graphDepthHandle, depthView);
    frameGraph.clearPasses();
    frameGraph.addPass(new ViewerScenePass(
      graphColorHandle,
      graphDepthHandle,
      (passEncoder: GPURenderPassEncoder) => {
        gpuProfiler.beginPass("ViewerScene", passEncoder, 0);
        // Render grid (after model, so model takes depth priority)
        // Actually render grid first but with depthWrite disabled to avoid z-fighting with model
        if (state.showGrid) {
          gridRenderer.render(passEncoder, camera);
        }

        // Render height ruler
        if (state.showHeightRuler) {
          heightRulerRenderer.render(passEncoder, camera);
        }

        // Render model
        if (state.currentModel) {
          const m = state.currentModel;
          const cx = (m.stats.bounds.min[0] + m.stats.bounds.max[0]) / 2;
          const cy = (m.stats.bounds.min[1] + m.stats.bounds.max[1]) / 2;
          const cz = (m.stats.bounds.min[2] + m.stats.bounds.max[2]) / 2;

          // No auto-scaling: 1 world unit = 1 meter (the normalization pipeline
          // already converts source units to meters). The camera frames the
          // model by adjusting distance, so the grid stays true-to-scale.
          const scaleFactor = 1.0;

          // The engine's normalization pipeline now handles up-axis conversion
          // (Z-up → Y-up) and node-transform baking, so no base rotation is
          // needed here. The model is already in Y-up model space.
          const baseRot: [number, number, number, number] = [0, 0, 0, 1];
          const spinRot: [number, number, number, number] = state.autoRotate
            ? [0, Math.sin(rotationAngle / 2), 0, Math.cos(rotationAngle / 2)]
            : [0, 0, 0, 1];

          // Combine: spinRot * baseRot — spin is applied in world space (after base rotation)
          // so the model spins around world Y axis
          const rot: [number, number, number, number] = [
            spinRot[0] * baseRot[3] + spinRot[3] * baseRot[0] + spinRot[1] * baseRot[2] - spinRot[2] * baseRot[1],
            spinRot[1] * baseRot[3] + spinRot[3] * baseRot[1] + spinRot[2] * baseRot[0] - spinRot[0] * baseRot[2],
            spinRot[2] * baseRot[3] + spinRot[3] * baseRot[2] + spinRot[0] * baseRot[1] - spinRot[1] * baseRot[0],
            spinRot[3] * baseRot[3] - spinRot[0] * baseRot[0] - spinRot[1] * baseRot[1] - spinRot[2] * baseRot[2],
          ];

          // Center model at origin: modelPos = -qrotate(rot, center * scale)
          // because shader does: worldPos = qrotate(rot, vertex * scale) + modelPos
          const centered: [number, number, number] = [cx * scaleFactor, cy * scaleFactor, cz * scaleFactor];
          // qrotate: v + 2*cross(q.xyz, cross(q.xyz, v) + q.w * v)
          const qxyz = [rot[0], rot[1], rot[2]];
          const qw = rot[3];
          const cross1: [number, number, number] = [
            qxyz[1] * centered[2] - qxyz[2] * centered[1] + qw * centered[0],
            qxyz[2] * centered[0] - qxyz[0] * centered[2] + qw * centered[1],
            qxyz[0] * centered[1] - qxyz[1] * centered[0] + qw * centered[2],
          ];
          const cross2: [number, number, number] = [
            qxyz[1] * cross1[2] - qxyz[2] * cross1[1],
            qxyz[2] * cross1[0] - qxyz[0] * cross1[2],
            qxyz[0] * cross1[1] - qxyz[1] * cross1[0],
          ];
          const pos: [number, number, number] = [
            -(centered[0] + 2 * cross2[0]),
            -(centered[1] + 2 * cross2[1]),
            -(centered[2] + 2 * cross2[2]),
          ];

          // Rest model on grid: shift up so the lowest point sits at y=0.
          // baseRot is identity and spinRot is Y-axis (preserves Y), so the
          // world-space Y extent is just (bounds.max[1] - bounds.min[1]).
          // Half of that offsets the centered model from mid-grid to sitting on top.
          const modelHeight = m.stats.bounds.max[1] - m.stats.bounds.min[1];
          pos[1] += modelHeight / 2;

          modelRenderer.render(
            passEncoder,
            m.nodeId,
            pos,
            rot,
            [scaleFactor, scaleFactor, scaleFactor],
          );

          // One-time debug log per model load
          if (!(m as any)._loggedBounds) {
            (m as any)._loggedBounds = true;
            const bounds = m.stats.bounds;
            // No rotation (identity) + scale=1.0: world = centered bounds + pos
            const worldMin: [number, number, number] = [bounds.min[0] - cx + pos[0], bounds.min[1] - cy + pos[1], bounds.min[2] - cz + pos[2]];
            const worldMax: [number, number, number] = [bounds.max[0] - cx + pos[0], bounds.max[1] - cy + pos[1], bounds.max[2] - cz + pos[2]];
            console.log(`[Render] Model world-space (centered, resting on grid):`);
            console.log(`  raw bounds min=[${bounds.min.map(v => v.toFixed(4))}] max=[${bounds.max.map(v => v.toFixed(4))}]`);
            console.log(`  scale=1.0 (1 unit = 1 meter)`);
            console.log(`  modelPos=[${pos.map(v => v.toFixed(4))}]`);
            console.log(`  world bounds: min=[${worldMin.map(v => v.toFixed(4))}] max=[${worldMax.map(v => v.toFixed(4))}]`);
            console.log(`  world size: [${(worldMax[0]-worldMin[0]).toFixed(4)}, ${(worldMax[1]-worldMin[1]).toFixed(4)}, ${(worldMax[2]-worldMin[2]).toFixed(4)}] (meters)`);
            console.log(`  Camera: pos=[${camera.position.map(v => v.toFixed(4))}], target=[${camera.target.map(v => v.toFixed(4))}], dist=${Math.sqrt(camera.position.reduce((s,v)=>s+v*v,0)).toFixed(4)}, near=${camera.near}, far=${camera.far}`);
          }
        }

        // Render skeleton AFTER the model, with depth test disabled so it
        // always shows on top of the mesh surface.
        // The skeleton/gizmo use the same model transform as the model so they
        // stay aligned (centering + auto-rotation).
        if (state.showSkeleton) {
          // Compute model matrix from the current model transform
          let modelMat: Float32Array | null = null;
          if (state.currentModel) {
            const m = state.currentModel;
            const cx = (m.stats.bounds.min[0] + m.stats.bounds.max[0]) / 2;
            const cy = (m.stats.bounds.min[1] + m.stats.bounds.max[1]) / 2;
            const cz = (m.stats.bounds.min[2] + m.stats.bounds.max[2]) / 2;
            const scaleFactor = 1.0;
            const baseRot: [number, number, number, number] = [0, 0, 0, 1];
            const spinRot: [number, number, number, number] = state.autoRotate
              ? [0, Math.sin(rotationAngle / 2), 0, Math.cos(rotationAngle / 2)]
              : [0, 0, 0, 1];
            const rot: [number, number, number, number] = [
              spinRot[0] * baseRot[3] + spinRot[3] * baseRot[0] + spinRot[1] * baseRot[2] - spinRot[2] * baseRot[1],
              spinRot[1] * baseRot[3] + spinRot[3] * baseRot[1] + spinRot[2] * baseRot[0] - spinRot[0] * baseRot[2],
              spinRot[2] * baseRot[3] + spinRot[3] * baseRot[2] + spinRot[0] * baseRot[1] - spinRot[1] * baseRot[0],
              spinRot[3] * baseRot[3] - spinRot[0] * baseRot[0] - spinRot[1] * baseRot[1] - spinRot[2] * baseRot[2],
            ];
            const centered: [number, number, number] = [cx * scaleFactor, cy * scaleFactor, cz * scaleFactor];
            const qxyz = [rot[0], rot[1], rot[2]];
            const qw = rot[3];
            const cross1: [number, number, number] = [
              qxyz[1] * centered[2] - qxyz[2] * centered[1] + qw * centered[0],
              qxyz[2] * centered[0] - qxyz[0] * centered[2] + qw * centered[1],
              qxyz[0] * centered[1] - qxyz[1] * centered[0] + qw * centered[2],
            ];
            const cross2: [number, number, number] = [
              qxyz[1] * cross1[2] - qxyz[2] * cross1[1],
              qxyz[2] * cross1[0] - qxyz[0] * cross1[2],
              qxyz[0] * cross1[1] - qxyz[1] * cross1[0],
            ];
            const pos: [number, number, number] = [
              -(centered[0] + 2 * cross2[0]),
              -(centered[1] + 2 * cross2[1]),
              -(centered[2] + 2 * cross2[2]),
            ];
            const modelHeight = m.stats.bounds.max[1] - m.stats.bounds.min[1];
            pos[1] += modelHeight / 2;

            modelMat = composeModelMatrix(pos, rot, scaleFactor);
          }

          // Update gizmo manager with the same model transform for picking
          gizmoManager.setModelMatrix(modelMat);
          _latestModelMatrix = modelMat;

          skeletonRenderer.render(passEncoder, camera, modelMat);

          // Render gizmo at selected bone position
          if (state.skeletonBoneIndex !== null) {
            const gizmoVerts = gizmoManager.buildVertices();
            if (gizmoVerts) {
              skeletonRenderer.renderGizmo(passEncoder, camera, gizmoVerts.vertices, gizmoVerts.vertexCount, modelMat);
            }
          }
        }

        gpuProfiler.endPass("ViewerScene", passEncoder, 0);
      },
    ));
    frameGraph.compile(device!, W, H);
    const ctx: RenderContext = {
      device: device!,
      encoder,
      pass: null,
      camera,
      viewport: { x: 0, y: 0, w: W, h: H },
      viewportIdx: 0,
      viewportCount: 1,
      dt: 0,
      elapsedTime: 0,
      isFirstViewport: true,
      isLastViewport: true,
      width: W,
      height: H,
      viewProj: undefined as any,
      invViewProj: undefined as any,
      prevViewProj: undefined as any,
      cameraPos: camera.position,
      lightData: null as any,
      lightViewProj: undefined as any,
      mesh: null as any,
      modelMatrix: undefined as any,
      shadowsEnabled: false,
      bloomEnabled: false,
      shadowSampler: null,
      debugQueue: null,
      opaqueVertexBuffer: null,
      opaqueIndexBuffer: null,
      opaqueIndexCount: 0,
      opaqueIndexFormat: "uint32",
      getView: (h: any) => frameGraph.getTextureView(h),
      getTexture: (h: any) => frameGraph.getTexture(h),
      addDrawCalls: () => {},
      addTriangles: () => {},
    };
    frameGraph.execute(ctx);

    // Resolve GPU timers + record telemetry
    gpuProfiler.resolveGpuTimers(encoder);
    device!.queue.submit([encoder.finish()]);
    gpuProfiler.readGpuTimers().then(() => {}).catch(() => {});
    telemetryCollector.recordFrame(dt * 1000);
    telemetryCollector.recordGraphSample(dt * 1000);

    // Project height ruler markers to screen for the DOM overlay
    if (state.showHeightRuler) {
      (state as any)._heightMarkers = heightRulerRenderer.projectHeightMarkers(camera, W, H);
    } else {
      (state as any)._heightMarkers = null;
    }
    for (const t of gpuProfiler.getPassTimings()) {
      telemetryCollector.recordPassTiming(t);
    }
    // Record GPU resource stats periodically (every ~1s)
    if (now - lastResourceStatsTime > 1000) {
      lastResourceStatsTime = now;
      const rs = gpuResourceTracker.getStats();
      telemetryCollector.recordResourceStats({
        textureCount: rs.textureCount,
        bufferCount: rs.bufferCount,
        totalBytes: rs.totalBytes,
        textureBytes: rs.textureBytes,
        bufferBytes: rs.bufferBytes,
        resources: rs.resources.map(r => ({ id: r.id, type: r.type, label: r.label, size: r.size, callsite: r.callsite, width: r.width, height: r.height, format: r.format })),
      });
    }
    // FPS
    fpsFrameCount++;
    if (now - fpsLastTime >= 500) {
      fps = (fpsFrameCount * 1000) / (now - fpsLastTime);
      fpsFrameCount = 0;
      fpsLastTime = now;
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ── DevTools integration ──────────────────────────────────────────────
  // Create a renderer adapter that implements IDevToolsRenderer and exposes
  // the telemetry/profiler/GC systems to the DevTools panel.
  const devtoolsRenderer: IDevToolsRenderer = {
    setGizmoPosition: () => {},
    setGizmoMode: () => {},
    setGizmoVisible: () => {},
    uploadModel: () => {},
    removeModel: () => {},
    getPlayerWorldPos: () => null,
    setShowHitboxes: () => {},
    getShowHitboxes: () => false,
    setHitboxLineWidth: () => {},
    getHitboxLineWidth: () => 1,
    setDebugMode: () => {},
    getGPUInfo: () => gpuProfiler.getGPUInfo(canvas, 1),
    getGPUErrors: () => gpuProfiler.getGPUErrors(),
    clearGPUErrors: () => gpuProfiler.clearGPUErrors(),
    getFrameTelemetry: () => telemetryCollector.getFrameTelemetry(),
    getGPUResourceTracker: () => gpuResourceTracker,
    getTelemetryCollector: () => telemetryCollector,
    getGPUProfiler: () => gpuProfiler,
    getFrameGraph: () => {
      const passTimings = gpuProfiler.getPassTimings();
      const passNames = passTimings.map(t => t.name);
      return GPUProfiler.buildFrameGraphData(passTimings, { pixelationEnabled: false, pixelSize: 4, postProcessEffects: [] }, passNames, ["ViewerScene"]);
    },
    getFPS: () => fps,
    getGCStats: () => gcController.getStats(),
    setGCConfig: (config: Partial<GCControllerConfig>) => gcController.setConfig(config),
  } as any;

  const inspector = new ModelViewerInspector();
  inspector.init(devtoolsRenderer);
  (window as any).__renderer = devtoolsRenderer;
}

// ── Model selection ──

let _modelRenderer: ModelRenderer | null = null;
// Animator for the currently-loaded skinned model (null when the model has no
// skin). Rebuilt on each model load. Sampled each frame to produce skin
// matrices consumed by ModelRenderer.updateSkinMatrices().
let _animator: ModelAnimator | null = null;
// Height ruler renderer — set during bootstrap, used in selectModel to update
// the ruler height when a new model loads.
let _heightRulerRenderer: HeightRulerRenderer | null = null;
// Skeleton renderer — set during bootstrap, used to visualize bone hierarchy.
let _skeletonRenderer: SkeletonRenderer | null = null;
// Gizmo manager — handles 3D translate gizmo for bone manipulation.
let _gizmoManager: GizmoManager | null = null;
// Latest model matrix (updated each frame, used by input handlers for picking)
let _latestModelMatrix: Float32Array | null = null;
// Current model entry (for re-loading with custom settings)
let _currentEntry: ModelEntry | null = null;

function rebuildModel() {
  const m = state.currentModel;
  if (!m || !_modelRenderer) return;

  // Determine which mesh indices to render
  let meshesToRender = m.data.meshes;
  let materialsToRender = m.data.materials;

  if (state.selectedPartIndices !== null && state.selectedPartIndices.size > 0) {
    // Filter to only meshes belonging to selected parts (all material splits)
    const selectedMeshIndices = new Set<number>();
    for (const partIdx of state.selectedPartIndices) {
      const part = m.stats.parts[partIdx];
      if (part?.hasMesh) {
        for (const mi of part.meshIndices) selectedMeshIndices.add(mi);
      }
    }
    meshesToRender = m.data.meshes.filter((_, i) => selectedMeshIndices.has(i));
  }

  // Use reuploadModel to preserve existing texture (prevents flickering)
  _modelRenderer.reuploadModel(m.nodeId, meshesToRender, materialsToRender);

  // Re-frame to fit the newly selected parts (in world space, matching the
  // renderer's transform — see computeWorldBounds).
  (window as any).__pendingFrame = computeWorldBounds(
    computeMeshBounds(meshesToRender),
    m.stats.bounds,
  );
}

async function selectModel(entry: ModelEntry) {
  state.loading = true;
  state.error = null;
  state.selectedPartIndices = null;
  state.animationIndex = null;
  state.animationPlaying = false;
  state.animationTime = 0;
  _animator = null;
  _currentEntry = entry;
  notify();

  try {
    const loaded = await loadModelWithTextures(entry, ASSET_BASE);

    // Remove previous model from renderer before uploading new one
    if (_modelRenderer) {
      if (state.currentModel) {
        _modelRenderer.removeModel(state.currentModel.nodeId);
      }
    }

    state.currentModel = loaded;
    state.loading = false;

    // Update height ruler to match model height (rounded up to next meter)
    const modelHeight = loaded.stats.bounds.max[1] - loaded.stats.bounds.min[1];
    _heightRulerRenderer?.setMaxHeight(modelHeight);

    // Update skeleton renderer with the model's skin (if any)
    if (loaded.data.skin) {
      _skeletonRenderer?.setSkin(loaded.data.skin);
      // Scale gizmo to model size (10% of model height, clamped)
      const h = loaded.stats.bounds.max[1] - loaded.stats.bounds.min[1];
      if (_gizmoManager) _gizmoManager.gizmoSize = Math.max(0.05, Math.min(0.5, h * 0.1));
    }

    // Build the animator for skinned models so rigging + animations play.
    // Non-skinned models have no animator (rendered as static meshes).
    if (loaded.data.skin && loaded.data.skin.bones.length > 0) {
      try {
        _animator = new ModelAnimator(loaded.data.skin, loaded.data.animations ?? []);
        // Replace the stats animation list with the animator's playable clip
        // list (embedded clips + procedural demos), so the animation panel
        // shows everything that can actually play on this rig.
        loaded.stats.animations = _animator.clipNames.map((name, i) => ({
          name,
          duration: _animator!.clipDurations[i],
          channels: [],
        }));
        const playable = _animator.clips.filter((c) => c !== null).length;
        console.log(`[Anim] Animator built: ${_animator.boneCount} bones, ${playable}/${_animator.clips.length} clips playable`);
      } catch (e) {
        console.error("[Anim] Failed to build animator:", e);
        _animator = null;
      }
    } else {
      _animator = null;
    }

    // Default part selection: rigged character models (LP_fe_mesh, LP_male_mesh,
    // etc.) have many mesh-part variants per body-part group (e.g. f_hair,
    // f_hair.002, f_hair.003 …). Showing all variants at once is visually noisy
    // and produces bad framing bounds. Instead, group mesh parts by name prefix
    // (stripping the trailing ".<digits>" variant suffix) and select the first
    // part from each group — yielding one complete character by default.
    // Static models default to the first mesh part (matches prior behaviour).
    if (loaded.stats.hasSkin) {
      const groups = new Map<string, number>();
      for (const p of loaded.stats.parts) {
        if (!p.hasMesh) continue;
        const pref = (p.name || `node_${p.nodeIndex}`).replace(/\.\d+$/, "");
        if (!groups.has(pref)) groups.set(pref, p.nodeIndex);
      }
      state.selectedPartIndices = groups.size > 0 ? new Set(groups.values()) : null;
    } else {
      const firstPart = loaded.stats.parts.find(p => p.hasMesh);
      if (firstPart) {
        state.selectedPartIndices = new Set([firstPart.nodeIndex]);
      } else {
        state.selectedPartIndices = null;
      }
    }

    // Initial upload with texture loading
    if (_modelRenderer) {
      let meshesToRender = loaded.data.meshes;
      let materialsToRender = loaded.data.materials;
      if (state.selectedPartIndices !== null && state.selectedPartIndices.size > 0) {
        const selectedMeshIndices = new Set<number>();
        for (const partIdx of state.selectedPartIndices) {
          const part = loaded.stats.parts[partIdx];
          if (part?.hasMesh) {
            for (const mi of part.meshIndices) selectedMeshIndices.add(mi);
          }
        }
        meshesToRender = loaded.data.meshes.filter((_, i) => selectedMeshIndices.has(i));
      }
      _modelRenderer.uploadModel(loaded.nodeId, meshesToRender, materialsToRender);

      // Frame using world-space bounds of ONLY the rendered meshes
      (window as any).__pendingFrame = computeWorldBounds(
        computeMeshBounds(meshesToRender),
        loaded.stats.bounds,
      );
    } else {
      // Frame using full model bounds (stats-only mode), in world space
      (window as any).__pendingFrame = computeWorldBounds(
        loaded.stats.bounds,
        loaded.stats.bounds,
      );
    }

    notify();
  } catch (e) {
    state.loading = false;
    state.error = `Failed to load model: ${(e as Error).message}`;
    notify();
  }
}

// ── Metadata editor: apply new ImportSettings + write sidecar ──────────────

async function applyMetadata(settings: any): Promise<void> {
  if (!_currentEntry || !state.currentModel) return;
  state.loading = true;
  notify();
  try {
    // Remember which parts were selected (by name, since node indices may change)
    const prevSelectedNames = new Set<string>();
    if (state.selectedPartIndices) {
      for (const idx of state.selectedPartIndices) {
        const part = state.currentModel.stats.parts[idx];
        if (part?.name) prevSelectedNames.add(part.name);
      }
    }

    const loaded = await reloadModelWithSettings(_currentEntry, ASSET_BASE, settings);

    // Remove old model, upload new
    if (_modelRenderer) {
      _modelRenderer.removeModel(state.currentModel.nodeId);
    }
    state.currentModel = loaded;
    state.loading = false;

    // Rebuild animator
    _animator = null;
    if (loaded.data.skin && loaded.data.skin.bones.length > 0) {
      try {
        _animator = new ModelAnimator(loaded.data.skin, loaded.data.animations ?? []);
        loaded.stats.animations = _animator.clipNames.map((name, i) => ({
          name,
          duration: _animator!.clipDurations[i],
          channels: [],
        }));
      } catch (e) {
        console.error("[Anim] Failed to build animator:", e);
      }
    }

    // Preserve part selection by matching names in the new model.
    // If no names match (e.g. structure changed), fall back to default selection.
    const matchedIndices = new Set<number>();
    for (const part of loaded.stats.parts) {
      if (part.hasMesh && prevSelectedNames.has(part.name)) {
        matchedIndices.add(part.nodeIndex);
      }
    }

    if (matchedIndices.size > 0) {
      state.selectedPartIndices = matchedIndices;
    } else {
      // Fall back to default part selection (same logic as selectModel)
      if (loaded.stats.hasSkin) {
        const groups = new Map<string, number>();
        for (const p of loaded.stats.parts) {
          if (!p.hasMesh) continue;
          const pref = (p.name || `node_${p.nodeIndex}`).replace(/\.\d+$/, "");
          if (!groups.has(pref)) groups.set(pref, p.nodeIndex);
        }
        state.selectedPartIndices = groups.size > 0 ? new Set(groups.values()) : null;
      } else {
        const firstPart = loaded.stats.parts.find(p => p.hasMesh);
        state.selectedPartIndices = firstPart ? new Set([firstPart.nodeIndex]) : null;
      }
    }

    // Upload only the selected meshes (same logic as selectModel/rebuildModel)
    let meshesToRender = loaded.data.meshes;
    let materialsToRender = loaded.data.materials ?? [];
    if (state.selectedPartIndices && state.selectedPartIndices.size > 0) {
      const selectedMeshIndices = new Set<number>();
      for (const partIdx of state.selectedPartIndices) {
        const part = loaded.stats.parts[partIdx];
        if (part?.hasMesh) {
          for (const mi of part.meshIndices) selectedMeshIndices.add(mi);
        }
      }
      meshesToRender = loaded.data.meshes.filter((_, i) => selectedMeshIndices.has(i));
    }
    _modelRenderer?.uploadModel(loaded.nodeId, meshesToRender, materialsToRender);

    // Update height ruler
    const modelHeight = loaded.stats.bounds.max[1] - loaded.stats.bounds.min[1];
    _heightRulerRenderer?.setMaxHeight(modelHeight);

    // Update skeleton renderer with the model's skin (if any)
    if (loaded.data.skin) {
      _skeletonRenderer?.setSkin(loaded.data.skin);
      const h = loaded.stats.bounds.max[1] - loaded.stats.bounds.min[1];
      if (_gizmoManager) _gizmoManager.gizmoSize = Math.max(0.05, Math.min(0.5, h * 0.1));
    }

    // Frame the model using the rendered meshes' bounds
    (window as any).__pendingFrame = computeWorldBounds(
      computeMeshBounds(meshesToRender),
      loaded.stats.bounds,
    );

    notify();
  } catch (e) {
    state.loading = false;
    state.error = `Failed to apply metadata: ${(e as Error).message}`;
    notify();
  }
}

async function saveMetadata(settings: any): Promise<void> {
  if (!_currentEntry) return;
  const result = await writeSidecar(_currentEntry.path, settings);
  if (!result.success) {
    state.error = `Failed to write sidecar: ${result.error}`;
    notify();
  }
}

// ── Skeleton debugger: select + offset a bone to verify mapping ────────────

function setSkeletonBone(index: number | null): void {
  state.skeletonBoneIndex = index;
  state.skeletonBoneOffset = [0, 0, 0];
  rebuildSkeleton();
  // Update gizmo position
  if (index !== null && _skeletonRenderer && _gizmoManager) {
    const pos = _skeletonRenderer.getBoneWorldPosition(index);
    if (pos) _gizmoManager.setPosition(pos);
  } else {
    _gizmoManager?.clear();
  }
  notify();
}

function setSkeletonBoneOffset(offset: [number, number, number]): void {
  state.skeletonBoneOffset = offset;
  rebuildSkeleton();
  notify();
}

function rebuildSkeleton(): void {
  if (!_skeletonRenderer || !state.currentModel?.data.skin) return;
  const skin = state.currentModel.data.skin;
  if (state.skeletonBoneIndex !== null) {
    _skeletonRenderer.setSkin(skin, {
      index: state.skeletonBoneIndex,
      offset: state.skeletonBoneOffset,
    });
    // Update gizmo position to follow the moved bone
    const pos = _skeletonRenderer.getBoneWorldPosition(state.skeletonBoneIndex);
    if (pos && _gizmoManager) _gizmoManager.setPosition(pos);
  } else {
    _skeletonRenderer.setSkin(skin);
  }
}

bootstrap().catch(console.error);

// ─── FrameGraph integration ────────────────────────────────────────────────

/**
 * ViewerScenePass — a single FrameGraph pass that owns the color+depth
 * attachments for the model-viewer render loop and delegates the grid + model
 * sub-draws to a callback. This makes the FrameGraph the single orchestration
 * path: it creates the render pass encoder, manages attachments, and calls
 * execute() which invokes the draw callback.
 */
class ViewerScenePass extends RenderPass {
  name = "ViewerScene";
  passType = PassType.Render;
  private colorHandle: any;
  private depthHandle: any;
  private drawFn: (passEncoder: GPURenderPassEncoder) => void;

  constructor(
    colorHandle: any,
    depthHandle: any,
    drawFn: (passEncoder: GPURenderPassEncoder) => void,
  ) {
    super();
    this.colorHandle = colorHandle;
    this.depthHandle = depthHandle;
    this.drawFn = drawFn;
  }

  setup(builder: FrameGraphBuilder): void {
    builder.colorAttachment({
      handle: this.colorHandle,
      loadOp: "clear",
      storeOp: "store",
      clearValue: { r: 0.05, g: 0.05, b: 0.08, a: 1 },
    });
    builder.depthAttachment({
      handle: this.depthHandle,
      depthLoadOp: "clear",
      depthStoreOp: "store",
      depthClearValue: 1.0,
    });
  }

  prepare(): void {}

  execute(ctx: RenderContext): void {
    if (!ctx.pass) return;
    const rawEncoder = ctx.pass.getRawPass() as GPURenderPassEncoder;
    this.drawFn(rawEncoder);
  }
}

// ─── DevTools inspector ────────────────────────────────────────────────────

/**
 * ModelViewerInspector — minimal BaseSceneInspector subclass for the model
 * viewer. Exposes the telemetry/profiler/GC systems to the DevTools panel
 * via window.__sceneInspector.
 */
class ModelViewerInspector extends BaseSceneInspector {
  protected getAssetResolver(): IAssetResolver | null {
    return null;
  }
}
