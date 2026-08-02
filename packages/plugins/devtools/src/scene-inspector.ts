// ============================================================================
// BaseSceneInspector — generic DevTools API exposed on window.__sceneInspector.
// Games extend this class and provide game-specific features via
// IGameDevToolsExtension.
// ============================================================================

import { compileUIGraphToMaterial, startGCProfiler, TelemetryCollector, type GCProfilerHandle, type GCStats, type UIConnection, type UINodeData } from "@downdraft/core";
import { detectFormat, loadModel } from "@downdraft/plugin-models";
import { useDebugStore } from "./debug-store.ts";
import { useSceneStore, type GizmoMode, type SceneTreeSnapshot } from "./scene-store.ts";
import type {
    IAssetResolver,
    IDebugModeProvider,
    IDebugOverlayProvider,
    IDevToolsOverlayToggle,
    IDevToolsPanelExtension,
    IDevToolsRenderer,
    IPerformanceMetricsProvider,
} from "./types.ts";

export abstract class BaseSceneInspector {
  protected renderer: IDevToolsRenderer | null = null;
  protected initialized = false;
  protected perfGcHandle: GCProfilerHandle | null = null;
  protected perfActive = false;
  protected cachedGpuSystemInfo: any = null;
  protected cachedElectronGpuInfo: any = null;
  protected cachedVulkanValidation: any = null;
  protected ipcFetchInterval: ReturnType<typeof setInterval> | null = null;

  // --- Abstract methods ---

  /** Games provide asset resolution for model import/thumbnails. */
  protected abstract getAssetResolver(): IAssetResolver | null;

  // --- Optional overrides ---

  protected getDebugOverlayProvider(): IDebugOverlayProvider | null {
    return null;
  }

  protected getDebugModeProvider(): IDebugModeProvider | null {
    return null;
  }

  protected getPerformanceMetricsProvider(): IPerformanceMetricsProvider | null {
    return null;
  }

  /** Games override this to declare custom DevTools panel tabs. */
  protected getPanelExtensions(): IDevToolsPanelExtension[] {
    return [];
  }

  /** Games override this to declare custom overlay toggles. */
  protected getOverlayToggles(): IDevToolsOverlayToggle[] {
    return [];
  }

  // --- Init ---

  init(renderer: IDevToolsRenderer): void {
    this.renderer = renderer;
    this.initialized = true;

    this.fetchIpcData();
    this.ipcFetchInterval = setInterval(() => this.fetchIpcData(), 2000);

    const api = this.buildApi();
    (window as any).__sceneInspector = api;
    console.log("[BaseSceneInspector] API exposed on window.__sceneInspector");

    // Apply default label visibility (generic)
    useSceneStore.getState().setShowLabels(true);
  }

  protected buildApi(): Record<string, any> {
    return {
      // --- Scene Tree ---
      getSceneTree: (): SceneTreeSnapshot => {
        return useSceneStore.getState().getSceneTree();
      },

      selectNode: (id: string | null): void => {
        useSceneStore.getState().selectNode(id);
        if (id) {
          const node = useSceneStore.getState().getNode(id);
          if (node) {
            this.renderer?.setGizmoPosition(node.position);
          }
        }
      },

      updateNodeTransform: (
        id: string,
        transform: {
          position?: [number, number, number];
          rotation?: [number, number, number, number];
          scale?: [number, number, number];
        },
      ): void => {
        const node = useSceneStore.getState().getNode(id);
        if (node && node.locked) return;
        useSceneStore.getState().updateNodeTransform(id, transform);
        const updated = useSceneStore.getState().getNode(id);
        if (updated) {
          this.renderer?.setGizmoPosition(updated.position);
        }
      },

      updateNodeProperty: (id: string, key: string, value: any): void => {
        const node = useSceneStore.getState().getNode(id);
        if (node && node.locked && key !== "locked") return;
        useSceneStore.getState().updateNodeProperty(id, key as any, value);
      },

      // --- Model Import ---
      importModel: (base64Data: string, filename: string): { success: boolean; nodeId?: string; error?: string } => {
        try {
          let actualBase64 = base64Data;
          if (base64Data === "__importBuffer") {
            actualBase64 = (window as any).__importBuffer;
            if (!actualBase64) {
              return { success: false, error: "No import buffer found on window" };
            }
          }
          const binaryString = atob(actualBase64);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          const buffer = bytes.buffer;

          const format = detectFormat(filename);
          if (!format) {
            return { success: false, error: `Unknown format: ${filename}` };
          }

          const resolver = this.getAssetResolver();
          let mtlData: ArrayBuffer | null = null;
          if (format === "obj" && resolver) {
            mtlData = resolver.findMTLForOBJ(filename, buffer);
          }

          let binData: ArrayBuffer | null = null;
          if (format === "gltf" && resolver) {
            binData = resolver.findBinForGLTF(filename, buffer);
          }

          const modelData = loadModel(buffer, filename, mtlData, binData);
          if (modelData.meshes.length === 0) {
            return { success: false, error: "No meshes found in model" };
          }

          if (modelData.materials && resolver) {
            for (let i = 0; i < modelData.materials.length; i++) {
              const mat = modelData.materials[i];
              if (!mat.textureData && mat.textureUri) {
                const texUrl = resolver.getTextureUrl(mat.textureUri.toLowerCase());
                if (texUrl) {
                  const texBuf = resolver.syncFetchArrayBuffer(texUrl);
                  if (texBuf) {
                    mat.textureData = texBuf;
                  }
                }
              }
            }
          }

          const playerPos = this.renderer?.getPlayerWorldPos(0) ?? { x: 0, y: 5, z: 0 };
          const pos: [number, number, number] = [playerPos.x, playerPos.y, playerPos.z];
          const nodeId = useSceneStore.getState().addModel(modelData, filename, pos);
          this.renderer?.uploadModel(nodeId, modelData.meshes, modelData.materials);

          return { success: true, nodeId };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },

      removeNode: (id: string): void => {
        this.renderer?.removeModel(id);
        useSceneStore.getState().removeNode(id);
      },

      duplicateNode: (id: string): { success: boolean; nodeId?: string; error?: string } => {
        try {
          const newId = useSceneStore.getState().duplicateNode(id);
          if (!newId) {
            return { success: false, error: "Cannot duplicate this node type" };
          }
          const node = useSceneStore.getState().getNode(newId);
          if (node && node.modelData) {
            this.renderer?.uploadModel(newId, node.modelData.meshes, node.modelData.materials);
          }
          this.renderer?.setGizmoPosition(node!.position);
          return { success: true, nodeId: newId };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },

      getNodeJSON: (id: string): string | null => {
        const node = useSceneStore.getState().getNode(id);
        if (!node) return null;
        return JSON.stringify({
          id: node.id,
          name: node.name,
          type: node.type,
          visible: node.visible,
          locked: node.locked,
          position: node.position,
          rotation: node.rotation,
          scale: node.scale,
          modelFormat: node.modelFormat,
          children: node.children,
          parentId: node.parentId,
        }, null, 2);
      },

      getAvailableModels: (): { path: string; name: string; format: string; url: string }[] => {
        return this.getAssetResolver()?.getAvailableModels() ?? [];
      },

      getModelThumbnail: (path: string): string | null => {
        const resolver = this.getAssetResolver();
        if (!resolver) return null;
        return this.generateThumbnail(path, resolver);
      },

      importAssetModel: (path: string): { success: boolean; nodeId?: string; error?: string } => {
        try {
          const resolver = this.getAssetResolver();
          if (!resolver) return { success: false, error: "No asset resolver" };
          const file = resolver.getAvailableModels().find((f) => f.path === path);
          if (!file) {
            return { success: false, error: `Model not found: ${path}` };
          }
          const buffer = resolver.syncFetchArrayBuffer(file.url);
          if (!buffer) {
            return { success: false, error: `Fetch failed for ${file.name}` };
          }
          let mtlData: ArrayBuffer | null = null;
          if (file.format === "obj") {
            mtlData = resolver.findMTLForOBJ(file.name, buffer);
          }
          let binData: ArrayBuffer | null = null;
          if (file.format === "gltf") {
            binData = resolver.findBinForGLTF(file.name, buffer);
          }
          const modelData = loadModel(buffer, file.name, mtlData, binData);
          if (modelData.meshes.length === 0) {
            return { success: false, error: `No meshes found in ${file.name}` };
          }
          if (modelData.materials) {
            for (let i = 0; i < modelData.materials.length; i++) {
              const mat = modelData.materials[i];
              if (!mat.textureData && mat.textureUri) {
                const texUrl = resolver.getTextureUrl(mat.textureUri.toLowerCase());
                if (texUrl) {
                  const texBuf = resolver.syncFetchArrayBuffer(texUrl);
                  if (texBuf) {
                    mat.textureData = texBuf;
                  }
                }
              }
            }
          }
          const playerPos = this.renderer?.getPlayerWorldPos(0) ?? { x: 0, y: 5, z: 0 };
          const pos: [number, number, number] = [playerPos.x, playerPos.y, playerPos.z];
          const nodeId = useSceneStore.getState().addModel(modelData, file.name, pos);
          this.renderer?.uploadModel(nodeId, modelData.meshes, modelData.materials);
          return { success: true, nodeId };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },

      // --- Gizmo ---
      setGizmoMode: (mode: GizmoMode): void => {
        useSceneStore.getState().setGizmoMode(mode);
        this.renderer?.setGizmoMode(mode);
      },

      setGizmoVisible: (visible: boolean): void => {
        useSceneStore.getState().setGizmoVisible(visible);
        this.renderer?.setGizmoVisible(visible);
      },

      setShowLabels: (visible: boolean): void => {
        useSceneStore.getState().setShowLabels(visible);
      },

      getShowLabels: (): boolean => {
        return useSceneStore.getState().showLabels;
      },

      getGizmoMode: (): GizmoMode => {
        return useSceneStore.getState().gizmoMode;
      },

      isReady: (): boolean => {
        return this.initialized;
      },

      // --- Hitbox overlays ---
      setShowHitboxes: (show: boolean): void => {
        this.renderer?.setShowHitboxes(show);
      },
      getShowHitboxes: (): boolean => {
        return this.renderer?.getShowHitboxes() ?? false;
      },
      setHitboxLineWidth: (width: number): void => {
        this.renderer?.setHitboxLineWidth(width);
      },
      getHitboxLineWidth: (): number => {
        return this.renderer?.getHitboxLineWidth() ?? 3;
      },

      // --- Chunk grid / velocity arrows (optional, via debug overlay provider) ---
      setShowChunkGrid: (show: boolean): void => {
        this.getDebugOverlayProvider()?.setShowChunkGrid(show);
      },
      getShowChunkGrid: (): boolean => {
        return this.getDebugOverlayProvider()?.getShowChunkGrid() ?? false;
      },
      setShowVelocityArrows: (show: boolean): void => {
        this.getDebugOverlayProvider()?.setShowVelocityArrows(show);
      },
      getShowVelocityArrows: (): boolean => {
        return this.getDebugOverlayProvider()?.getShowVelocityArrows() ?? false;
      },

      // --- Performance monitoring ---
      enablePerformanceMonitoring: (): void => {
        if (this.perfActive) return;
        this.perfActive = true;

        if (!this.perfGcHandle) {
          this.perfGcHandle = startGCProfiler('renderer', (stats: GCStats) => {
            useDebugStore.getState().updateGCStats(stats);
          });
        }

        this.renderer?.setDebugMode(true);
        this.getDebugModeProvider()?.setDebugMode(true);
      },

      disablePerformanceMonitoring: (): void => {
        if (!this.perfActive) return;
        this.perfActive = false;

        this.perfGcHandle?.stop();
        this.perfGcHandle = null;

        if (!useDebugStore.getState().showDebugPage) {
          this.renderer?.setDebugMode(false);
          this.getDebugModeProvider()?.setDebugMode(false);
        }
      },

      getPerformanceMetrics: (): any => {
        const provider = this.getPerformanceMetricsProvider();
        if (provider) return provider.getPerformanceMetrics();

        // Fallback: basic renderer-only metrics
        const gcStats = useDebugStore.getState().gcStats;
        const fps = this.renderer?.getFPS() ?? 0;
        const frameTimeMs = fps > 0 ? 1000 / fps : 0;
        const targetFrameMs = 1000 / 60;
        const gpuUtil = Math.min(100, (frameTimeMs / targetFrameMs) * 100);
        const perfMem = (performance as any).memory;
        const rendererMemMB = perfMem ? perfMem.usedJSHeapSize / 1048576 : 0;

        function gcFor(label: string) {
          const g = gcStats[label];
          if (!g) return { count: 0, totalTime: 0, scavengeCount: 0, majorCount: 0 };
          return {
            count: g.interval.count,
            totalTime: g.interval.totalTime,
            scavengeCount: g.interval.scavengeCount,
            majorCount: g.interval.majorCount,
          };
        }

        return {
          gpu: { utilization: gpuUtil, frameTimeMs, fps },
          renderer: {
            cpuPercent: gpuUtil, memUsedMB: rendererMemMB,
            diskKBps: 0, networkKBps: 0, gc: gcFor("renderer"),
          },
          main: { cpuPercent: 0, memUsedMB: 0, diskKBps: 0, networkKBps: 0, gc: gcFor("main") },
          worker: { cpuPercent: 0, memUsedMB: 0, diskKBps: 0, networkKBps: 0, gc: gcFor("sim-worker") },
          timestamp: performance.now(),
        };
      },

      // --- GPU Debugging ---
      getGPUInfo: (): any => {
        return this.renderer?.getGPUInfo() ?? null;
      },

      getGPUErrors: (): any => {
        return this.renderer?.getGPUErrors() ?? [];
      },

      clearGPUErrors: (): void => {
        this.renderer?.clearGPUErrors();
      },

      getFrameTelemetry: (): any => {
        return this.renderer?.getFrameTelemetry() ?? null;
      },

      getGPUResourceStats: (): any => {
        const tracker = this.renderer?.getGPUResourceTracker();
        if (!tracker) return null;
        return tracker.getStats();
      },

      getPassTimings: (): any => {
        const tc = this.renderer?.getTelemetryCollector();
        if (!tc) return [];
        return tc.getPassTimings();
      },

      getFrameGraph: (): any => {
        return this.renderer?.getFrameGraph() ?? null;
      },

      saveSnapshot: (label: string): any => {
        const tc = this.renderer?.getTelemetryCollector();
        if (!tc) return null;
        return tc.saveSnapshot(label || "Snapshot");
      },

      getSnapshots: (): any => {
        const tc = this.renderer?.getTelemetryCollector();
        if (!tc) return [];
        return tc.getSnapshots();
      },

      clearSnapshots: (): void => {
        this.renderer?.getTelemetryCollector()?.clearSnapshots();
      },

      diffSnapshots: (idxA: number, idxB: number): any => {
        const tc = this.renderer?.getTelemetryCollector();
        if (!tc) return [];
        const snaps = tc.getSnapshots();
        if (idxA < 0 || idxB < 0 || idxA >= snaps.length || idxB >= snaps.length) return [];
        return TelemetryCollector.diffSnapshots(snaps[idxA], snaps[idxB]);
      },

      getVersion: (): string => {
        return "1.0.0";
      },

      getGPUSystemInfo: (): any => {
        return this.cachedGpuSystemInfo;
      },

      getElectronGPUInfo: (): any => {
        return this.cachedElectronGpuInfo;
      },

      getVulkanValidationStatus: (): any => {
        return this.cachedVulkanValidation;
      },

      // --- Panel extensions (game-specific tabs and overlay toggles) ---
      getPanelExtensions: (): IDevToolsPanelExtension[] => this.getPanelExtensions(),
      getOverlayToggles: (): IDevToolsOverlayToggle[] => this.getOverlayToggles(),

      // --- Debug mode (Inspector v2) ---
      setDebugMode: (mode: string): void => {
        const provider = this.getDebugModeProvider();
        if (provider && typeof (provider as any).setDebugMode === "function") {
          (provider as any).setDebugMode(mode);
        }
        this.renderer?.setDebugMode(mode !== "none");
      },

      // --- Material Editor API ---

      compileMaterialGraph: (nodes: UINodeData[], connections: UIConnection[], options?: {
        blendMode?: string; cullMode?: string; profile?: string;
      }): { wgsl?: string; errors: string[]; warnings: string[] } => {
        try {
          const blendMode = (options?.blendMode as any) ?? "opaque";
          const cullMode = (options?.cullMode as any) ?? "back";
          const profile = options?.profile;
          const material = compileUIGraphToMaterial(nodes, connections, {
            name: "preview_material",
            blendMode,
            cullMode,
            profile: profile as any,
          });
          const wgsl = material.inlineShaderSource ?? "";
          return { wgsl, errors: [], warnings: [] };
        } catch (e: any) {
          return { errors: [String(e?.message ?? e)], warnings: [] };
        }
      },

      createMaterialFromGraph: (nodes: UINodeData[], connections: UIConnection[], options?: {
        name?: string; blendMode?: string; cullMode?: string; profile?: string;
      }): { success: boolean; materialName?: string; error?: string } => {
        try {
          const name = options?.name ?? "graph_material";
          const blendMode = (options?.blendMode as any) ?? "opaque";
          const cullMode = (options?.cullMode as any) ?? "back";
          const material = compileUIGraphToMaterial(nodes, connections, {
            name,
            blendMode,
            cullMode,
            profile: options?.profile as any,
          });
          return { success: true, materialName: name };
        } catch (e: any) {
          return { success: false, error: String(e?.message ?? e) };
        }
      },

      saveMaterialToLibrary: (name: string, graphData: {
        nodes: UINodeData[]; connections: UIConnection[];
        blendMode?: string; cullMode?: string;
      }): { success: boolean; error?: string } => {
        try {
          const material = compileUIGraphToMaterial(graphData.nodes, graphData.connections, {
            name,
            blendMode: (graphData.blendMode as any) ?? "opaque",
            cullMode: (graphData.cullMode as any) ?? "back",
          });
          return { success: true };
        } catch (e: any) {
          return { success: false, error: String(e?.message ?? e) };
        }
      },

      listMaterials: (): { name: string; shader: string; type: string }[] => {
        return [];
      },

      exportMaterialAsJSON: (name: string): string | null => {
        return null;
      },

      importMaterialFromJSON: (json: string): { success: boolean; name?: string; error?: string } => {
        try {
          const data = JSON.parse(json);
          if (!data.nodes || !data.connections) {
            return { success: false, error: "Invalid material JSON" };
          }
          return { success: true, name: data.name ?? "imported_material" };
        } catch (e: any) {
          return { success: false, error: String(e?.message ?? e) };
        }
      },
    };
  }

  // --- Thumbnail generation (generic, uses asset resolver) ---

  private thumbnailCache = new Map<string, string | null>();

  protected generateThumbnail(path: string, resolver: IAssetResolver): string | null {
    const cached = this.thumbnailCache.get(path);
    if (cached !== undefined) return cached;
    try {
      const file = resolver.getAvailableModels().find((f) => f.path === path);
      if (!file) { this.evictThumbnailCache(); this.thumbnailCache.set(path, null); return null; }

      const buffer = resolver.syncFetchArrayBuffer(file.url);
      if (!buffer) { this.evictThumbnailCache(); this.thumbnailCache.set(path, null); return null; }
      const modelData = loadModel(buffer, file.name);
      if (modelData.meshes.length === 0) { this.evictThumbnailCache(); this.thumbnailCache.set(path, null); return null; }

      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      let totalTris = 0;

      for (let mi = 0; mi < modelData.meshes.length; mi++) {
        const mesh = modelData.meshes[mi];
        const verts = mesh.vertices;
        const vc = mesh.vertexCount;
        totalTris += mesh.indexCount / 3;
        for (let i = 0; i < vc; i++) {
          const x = verts[i * 6];
          const y = verts[i * 6 + 1];
          const z = verts[i * 6 + 2];
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (z < minZ) minZ = z;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
          if (z > maxZ) maxZ = z;
        }
      }

      if (!isFinite(minX)) return null;

      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const cz = (minZ + maxZ) / 2;
      const sizeX = maxX - minX;
      const sizeY = maxY - minY;
      const sizeZ = maxZ - minZ;
      const maxSize = Math.max(sizeX, sizeY, sizeZ);
      if (maxSize === 0) return null;

      const angleY = Math.PI / 6;
      const angleX = Math.PI / 6;
      const cosY = Math.cos(angleY), sinY = Math.sin(angleY);
      const cosX = Math.cos(angleX), sinX = Math.sin(angleX);

      const THUMB_SIZE = 192;
      const canvas = document.createElement("canvas");
      canvas.width = THUMB_SIZE;
      canvas.height = THUMB_SIZE;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;

      ctx.fillStyle = "#1a1a2e";
      ctx.fillRect(0, 0, THUMB_SIZE, THUMB_SIZE);

      const scale = (THUMB_SIZE * 0.75) / maxSize;
      const offsetX = THUMB_SIZE / 2;
      const offsetY = THUMB_SIZE / 2;

      const MAX_DRAW_TRIS = 20000;
      const triStep = totalTris > MAX_DRAW_TRIS ? Math.ceil(totalTris / MAX_DRAW_TRIS) : 1;

      ctx.strokeStyle = "#569cd6";
      ctx.lineWidth = 0.5;
      ctx.fillStyle = "rgba(86, 156, 214, 0.12)";

      for (let mi = 0; mi < modelData.meshes.length; mi++) {
        const mesh = modelData.meshes[mi];
        const verts = mesh.vertices;
        const indices = mesh.indices;
        const ic = mesh.indexCount;

        for (let i = 0; i < ic; i += 3 * triStep) {
          const i0 = indices[i], i1 = indices[i + 1], i2 = indices[i + 2];
          const x0 = verts[i0 * 6] - cx, y0 = verts[i0 * 6 + 1] - cy, z0 = verts[i0 * 6 + 2] - cz;
          const x1 = verts[i1 * 6] - cx, y1 = verts[i1 * 6 + 1] - cy, z1 = verts[i1 * 6 + 2] - cz;
          const x2 = verts[i2 * 6] - cx, y2 = verts[i2 * 6 + 1] - cy, z2 = verts[i2 * 6 + 2] - cz;

          const px0 = offsetX + (x0 * cosY + z0 * sinY) * scale;
          const py0 = offsetY - (y0 * cosX - (-x0 * sinY + z0 * cosY) * sinX) * scale;
          const px1 = offsetX + (x1 * cosY + z1 * sinY) * scale;
          const py1 = offsetY - (y1 * cosX - (-x1 * sinY + z1 * cosY) * sinX) * scale;
          const px2 = offsetX + (x2 * cosY + z2 * sinY) * scale;
          const py2 = offsetY - (y2 * cosX - (-x2 * sinY + z2 * cosY) * sinX) * scale;

          ctx.beginPath();
          ctx.moveTo(px0, py0);
          ctx.lineTo(px1, py1);
          ctx.lineTo(px2, py2);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
      }

      const dataUrl = canvas.toDataURL("image/png");
      this.evictThumbnailCache();
      this.thumbnailCache.set(path, dataUrl);
      return dataUrl;
    } catch (e) {
      console.error("[BaseSceneInspector] Thumbnail error for path:", path, e);
      this.evictThumbnailCache();
      this.thumbnailCache.set(path, null);
      return null;
    }
  }

  protected evictThumbnailCache(): void {
    if (this.thumbnailCache.size > 30) {
      this.thumbnailCache.clear();
    }
  }

  // --- IPC data fetching (generic Electron) ---

  private fetchIpcData(): void {
    const w = window as any;
    if (w.downdraft?.getGPUSystemInfo) {
      w.downdraft.getGPUSystemInfo().then((data: any) => { this.cachedGpuSystemInfo = data; }).catch(() => {});
    }
    if (w.downdraft?.getElectronGPUInfo) {
      w.downdraft.getElectronGPUInfo().then((info: any) => { this.cachedElectronGpuInfo = info; }).catch(() => {});
    }
    if (w.downdraft?.getVulkanValidationStatus) {
      w.downdraft.getVulkanValidationStatus().then((data: any) => { this.cachedVulkanValidation = data; }).catch(() => {});
    }
  }

  destroy(): void {
    this.initialized = false;
    this.renderer = null;
    if (this.ipcFetchInterval) {
      clearInterval(this.ipcFetchInterval);
      this.ipcFetchInterval = null;
    }
    delete (window as any).__sceneInspector;
  }
}
