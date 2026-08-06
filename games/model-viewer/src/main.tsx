// ============================================================================
// Model Viewer — Main Entry Point
// WebGPU init, render loop, model loading pipeline
// ============================================================================

import { DEPTH_FORMAT, RendererInputBusImpl } from "@downdraft/core";
import { createCameraController } from "@downdraft/plugin-camera-controls";
import { ModelRenderer } from "@downdraft/plugin-entities";
import type { MeshData } from "@downdraft/plugin-models";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { GridRenderer } from "./grid-renderer";
import {
  discoverModels,
  loadModelWithTextures,
  type LoadedModel,
  type ModelEntry,
} from "./model-loader";
import "./styles/globals.css";

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
// actually draws. MUST mirror the render-section transform in `frame()`
// (lines ~407-465): uniform scale = 2.0 / full-model maxDim, base rotation
// of -90deg around X (Z-up -> Y-up, so (x,y,z) -> (x,z,-y)), and centering
// at world origin (modelPos = -qrotate(baseRot, fullCenter * scale)).
// If the renderer's base rotation or centering changes, update this too.
function computeWorldBounds(
  rawBounds: { min: [number, number, number]; max: [number, number, number] },
  fullBounds: { min: [number, number, number]; max: [number, number, number] },
): { min: [number, number, number]; max: [number, number, number] } {
  const cx = (fullBounds.min[0] + fullBounds.max[0]) / 2;
  const cy = (fullBounds.min[1] + fullBounds.max[1]) / 2;
  const cz = (fullBounds.min[2] + fullBounds.max[2]) / 2;
  const maxDim = Math.max(
    fullBounds.max[0] - fullBounds.min[0],
    fullBounds.max[1] - fullBounds.min[1],
    fullBounds.max[2] - fullBounds.min[2],
    0.1,
  );
  const scale = 2.0 / maxDim;

  // After -90deg X rotation: x' = x, y' = z, z' = -y.
  // Apply (p - fullCenter) * scale, then axis swap.
  const wxMin = (rawBounds.min[0] - cx) * scale;
  const wxMax = (rawBounds.max[0] - cx) * scale;
  const wyMin = (rawBounds.min[2] - cz) * scale;
  const wyMax = (rawBounds.max[2] - cz) * scale;
  const wzMin = -(rawBounds.max[1] - cy) * scale;
  const wzMax = -(rawBounds.min[1] - cy) * scale;

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
      if (part?.hasMesh && part.meshIndex !== undefined) {
        selectedMeshIndices.add(part.meshIndex);
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
  const modelRenderer = new ModelRenderer(device, format);
  await modelRenderer.init();
  _modelRenderer = modelRenderer;

  const gridRenderer = new GridRenderer(device, format);
  gridRenderer.init();

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
        notify();
      }
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

    const encoder = device!.createCommandEncoder();
    const passEncoder = encoder.beginRenderPass({
      colorAttachments: [{
        view: context!.getCurrentTexture().createView(),
        clearValue: { r: 0.05, g: 0.05, b: 0.08, a: 1 },
        loadOp: "clear" as GPULoadOp,
        storeOp: "store" as GPUStoreOp,
      }],
      depthStencilAttachment: {
        view: getDepthTexture(device!, W, H).createView(),
        depthClearValue: 1.0,
        depthLoadOp: "clear" as GPULoadOp,
        depthStoreOp: "store" as GPUStoreOp,
      },
    });

    // Render grid (after model, so model takes depth priority)
    // Actually render grid first but with depthWrite disabled to avoid z-fighting with model
    if (state.showGrid) {
      gridRenderer.render(passEncoder, camera);
    }

    // Render model
    if (state.currentModel) {
      const m = state.currentModel;
      const cx = (m.stats.bounds.min[0] + m.stats.bounds.max[0]) / 2;
      const cy = (m.stats.bounds.min[1] + m.stats.bounds.max[1]) / 2;
      const cz = (m.stats.bounds.min[2] + m.stats.bounds.max[2]) / 2;
      const maxDim = Math.max(
        m.stats.bounds.max[0] - m.stats.bounds.min[0],
        m.stats.bounds.max[1] - m.stats.bounds.min[1],
        m.stats.bounds.max[2] - m.stats.bounds.min[2],
        0.1,
      );
      const scaleFactor = 2.0 / maxDim;

      // Base rotation: rotate X by -90deg (flip vertically + convert Z-up to Y-up)
      const halfAngle = -Math.PI / 4; // half of -90deg
      const baseRot: [number, number, number, number] = [Math.sin(halfAngle), 0, 0, Math.cos(halfAngle)];
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
        // After -90° X rotation: x'=x, y'=z, z'=-y
        const rotMin: [number, number, number] = [bounds.min[0] * scaleFactor, bounds.min[2] * scaleFactor, -bounds.max[1] * scaleFactor];
        const rotMax: [number, number, number] = [bounds.max[0] * scaleFactor, bounds.max[2] * scaleFactor, -bounds.min[1] * scaleFactor];
        const worldMin: [number, number, number] = [rotMin[0] + pos[0], rotMin[1] + pos[1], rotMin[2] + pos[2]];
        const worldMax: [number, number, number] = [rotMax[0] + pos[0], rotMax[1] + pos[1], rotMax[2] + pos[2]];
        console.log(`[Render] Model world-space (after rotation + centering):`);
        console.log(`  raw bounds min=[${bounds.min.map(v => v.toFixed(4))}] max=[${bounds.max.map(v => v.toFixed(4))}]`);
        console.log(`  scaleFactor=${scaleFactor.toFixed(6)}, maxDim=${maxDim.toFixed(4)}`);
        console.log(`  modelPos=[${pos.map(v => v.toFixed(4))}]`);
        console.log(`  world bounds: min=[${worldMin.map(v => v.toFixed(4))}] max=[${worldMax.map(v => v.toFixed(4))}]`);
        console.log(`  world size: [${(worldMax[0]-worldMin[0]).toFixed(4)}, ${(worldMax[1]-worldMin[1]).toFixed(4)}, ${(worldMax[2]-worldMin[2]).toFixed(4)}]`);
        console.log(`  Camera: pos=[${camera.position.map(v => v.toFixed(4))}], target=[${camera.target.map(v => v.toFixed(4))}], dist=${Math.sqrt(camera.position.reduce((s,v)=>s+v*v,0)).toFixed(4)}, near=${camera.near}, far=${camera.far}`);
      }
    }

    passEncoder.end();
    device!.queue.submit([encoder.finish()]);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ── Model selection ──

let _modelRenderer: ModelRenderer | null = null;

function rebuildModel() {
  const m = state.currentModel;
  if (!m || !_modelRenderer) return;

  // Determine which mesh indices to render
  let meshesToRender = m.data.meshes;
  let materialsToRender = m.data.materials;

  if (state.selectedPartIndices !== null && state.selectedPartIndices.size > 0) {
    // Filter to only meshes belonging to selected parts
    const selectedMeshIndices = new Set<number>();
    for (const partIdx of state.selectedPartIndices) {
      const part = m.stats.parts[partIdx];
      if (part?.hasMesh && part.meshIndex !== undefined) {
        selectedMeshIndices.add(part.meshIndex);
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

    // Default to showing only the first part
    const firstPart = loaded.stats.parts.find(p => p.hasMesh);
    if (firstPart) {
      state.selectedPartIndices = new Set([firstPart.nodeIndex]);
    } else {
      state.selectedPartIndices = null;
    }

    // Initial upload with texture loading
    if (_modelRenderer) {
      let meshesToRender = loaded.data.meshes;
      let materialsToRender = loaded.data.materials;
      if (state.selectedPartIndices !== null && state.selectedPartIndices.size > 0) {
        const selectedMeshIndices = new Set<number>();
        for (const partIdx of state.selectedPartIndices) {
          const part = loaded.stats.parts[partIdx];
          if (part?.hasMesh && part.meshIndex !== undefined) {
            selectedMeshIndices.add(part.meshIndex);
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

bootstrap().catch(console.error);
