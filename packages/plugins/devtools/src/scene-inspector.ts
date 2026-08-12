// ============================================================================
// BaseSceneInspector — generic DevTools API exposed on window.__sceneInspector.
// Games extend this class and provide game-specific features via
// IGameDevToolsExtension.
//
// Extends DevToolsDataBridge (which provides perf/GC/GPU/telemetry data feeds)
// and adds scene-tree / model / gizmo / material-editor methods.
// ============================================================================

import { compileGraphToMaterialWithGraph, compileUIGraphToMaterial, isExtremeScale, MaterialLibrary, maxDimension, uiGraphToMaterialGraph, type Material, type UIConnection, type UINodeData } from "@downdraft/core";
import { createDefaultDdmeta, createDefaultImportSettings, detectFormat, loadModel, normalizeModel, writeDdmeta } from "@downdraft/plugin-models";
import { DevToolsDataBridge } from "./data-bridge";
import { useSceneStore, type GizmoMode, type SceneTreeSnapshot } from "./scene-store";
import type {
    IAssetResolver,
    IDebugOverlayProvider,
    IDevToolsRenderer,
} from "./types";

export abstract class BaseSceneInspector extends DevToolsDataBridge {
  // Core material library — the single source of truth for materials created
  // via the graph editor. Graph-compiled materials are registered here.
  protected materialLibrary: MaterialLibrary = new MaterialLibrary();
  // Preview mesh renderer for live material graph preview (set by the game).
  protected previewMeshRenderer: { setMaterial: (m: Material) => void } | null = null;

  // --- Abstract methods ---

  /** Games provide asset resolution for model import/thumbnails. */
  protected abstract getAssetResolver(): IAssetResolver | null;

  /** Typed view of the renderer as IDevToolsRenderer (scene-specific methods).
   *  The base class stores it as IDevToolsDataRenderer; this casts for scene use. */
  protected get sceneRenderer(): IDevToolsRenderer | null {
    return this.renderer as IDevToolsRenderer | null;
  }

  // --- Optional overrides ---

  protected getDebugOverlayProvider(): IDebugOverlayProvider | null {
    return null;
  }

  // getPanelExtensions() and getOverlayToggles() inherited from DevToolsDataBridge.

  // --- Init ---

  init(renderer: IDevToolsRenderer): void {
    super.init(renderer);

    // Apply default label visibility (generic)
    useSceneStore.getState().setShowLabels(true);
  }

  protected buildApi(): Record<string, any> {
    const api = super.buildApi();
    Object.assign(api, {
      // --- Scene Tree ---
      getSceneTree: (): SceneTreeSnapshot => {
        return useSceneStore.getState().getSceneTree();
      },

      selectNode: (id: string | null): void => {
        useSceneStore.getState().selectNode(id);
        if (id) {
          const node = useSceneStore.getState().getNode(id);
          if (node) {
            this.sceneRenderer?.setGizmoPosition(node.position);
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
          this.sceneRenderer?.setGizmoPosition(updated.position);
        }
      },

      updateNodeProperty: (id: string, key: string, value: any): void => {
        const node = useSceneStore.getState().getNode(id);
        if (node && node.locked && key !== "locked") return;
        useSceneStore.getState().updateNodeProperty(id, key as any, value);
      },

      // --- Model Import ---
      importModel: async (base64Data: string, filename: string): Promise<{ success: boolean; nodeId?: string; error?: string; warnings?: string[]; needsAutoFit?: boolean; maxDim?: number }> => {
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

          const modelData = await loadModel(buffer, filename, mtlData, binData);
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

          const playerPos = this.sceneRenderer?.getPlayerWorldPos(0) ?? { x: 0, y: 5, z: 0 };
          const pos: [number, number, number] = [playerPos.x, playerPos.y, playerPos.z];
          const nodeId = useSceneStore.getState().addModel(modelData, filename, pos);
          this.sceneRenderer?.uploadModel(nodeId, modelData.meshes, modelData.materials);

          // Check for extreme scale and return warnings for the UI to prompt auto-fit
          const warnings = modelData.normalizationWarnings ?? [];
          const needsAutoFit = modelData.bounds ? isExtremeScale(modelData.bounds) : false;
          const maxDim = modelData.bounds ? maxDimension(modelData.bounds) : 0;

          return { success: true, nodeId, warnings, needsAutoFit, maxDim };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },

      removeNode: (id: string): void => {
        this.sceneRenderer?.removeModel(id);
        useSceneStore.getState().removeNode(id);
      },

      // --- Model Auto-Fit ---
      // Detects models with extreme scale and re-normalizes with auto-fit enabled.
      // Writes a .ddmeta.json sidecar so the fix persists across reloads.
      autoFitModel: (nodeId: string, targetMaxDim: number = 2.0): { success: boolean; error?: string; sidecar?: string } => {
        try {
          const node = useSceneStore.getState().getNode(nodeId);
          if (!node || !node.modelData) {
            return { success: false, error: "Node not found or not a model" };
          }

          // Re-normalize with auto-fit enabled
          const settings = createDefaultImportSettings(
            node.modelData.sourceUpAxis,
            node.modelData.sourceUnits,
          );
          settings.autoFit = targetMaxDim;
          settings.centerToOrigin = true;
          normalizeModel(node.modelData, settings);

          // Re-upload the normalized meshes to the GPU
          this.sceneRenderer?.uploadModel(nodeId, node.modelData.meshes, node.modelData.materials);

          // Generate a .ddmeta.json sidecar for persistence
          const sidecar = writeDdmeta(settings);

          return { success: true, sidecar };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },

      // Generate a starter .ddmeta.json sidecar for a model node
      generateSidecar: (nodeId: string): { success: boolean; error?: string; sidecar?: string } => {
        try {
          const node = useSceneStore.getState().getNode(nodeId);
          if (!node || !node.modelData) {
            return { success: false, error: "Node not found or not a model" };
          }
          const defaults = createDefaultImportSettings(
            node.modelData.sourceUpAxis,
            node.modelData.sourceUnits,
          );
          const sidecar = createDefaultDdmeta(node.name, defaults);
          return { success: true, sidecar };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },

      duplicateNode: (id: string): { success: boolean; nodeId?: string; error?: string } => {
        try {
          const newId = useSceneStore.getState().duplicateNode(id);
          if (!newId) {
            return { success: false, error: "Cannot duplicate this node type" };
          }
          const node = useSceneStore.getState().getNode(newId);
          if (node && node.modelData) {
            this.sceneRenderer?.uploadModel(newId, node.modelData.meshes, node.modelData.materials);
          }
          this.sceneRenderer?.setGizmoPosition(node!.position);
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

      getModelThumbnail: async (path: string): Promise<string | null> => {
        const resolver = this.getAssetResolver();
        if (!resolver) return null;
        return this.generateThumbnail(path, resolver);
      },

      importAssetModel: async (path: string): Promise<{ success: boolean; nodeId?: string; error?: string }> => {
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
          const modelData = await loadModel(buffer, file.name, mtlData, binData);
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
          const playerPos = this.sceneRenderer?.getPlayerWorldPos(0) ?? { x: 0, y: 5, z: 0 };
          const pos: [number, number, number] = [playerPos.x, playerPos.y, playerPos.z];
          const nodeId = useSceneStore.getState().addModel(modelData, file.name, pos);
          this.sceneRenderer?.uploadModel(nodeId, modelData.meshes, modelData.materials);
          return { success: true, nodeId };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },

      // --- Gizmo ---
      setGizmoMode: (mode: GizmoMode): void => {
        useSceneStore.getState().setGizmoMode(mode);
        this.sceneRenderer?.setGizmoMode(mode);
      },

      setGizmoVisible: (visible: boolean): void => {
        useSceneStore.getState().setGizmoVisible(visible);
        this.sceneRenderer?.setGizmoVisible(visible);
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

      // --- Hitbox overlays ---
      setShowHitboxes: (show: boolean): void => {
        this.sceneRenderer?.setShowHitboxes(show);
      },
      getShowHitboxes: (): boolean => {
        return this.sceneRenderer?.getShowHitboxes() ?? false;
      },
      setHitboxLineWidth: (width: number): void => {
        this.sceneRenderer?.setHitboxLineWidth(width);
      },
      getHitboxLineWidth: (): number => {
        return this.sceneRenderer?.getHitboxLineWidth() ?? 3;
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

      // --- Debug mode (Inspector v2) ---
      setDebugMode: (mode: string): void => {
        const provider = this.getDebugModeProvider();
        if (provider && typeof (provider as any).setDebugMode === "function") {
          (provider as any).setDebugMode(mode);
        }
        this.sceneRenderer?.setDebugMode(mode !== "none");
      },

      // --- Material Editor API ---
      // These are now functional: graph-compiled materials are registered into
      // the core MaterialLibrary, the editor can list/export/import them, and
      // live preview is wired via previewMaterialGraph.

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
          // Use compileGraphToMaterialWithGraph to retain the source graph for
          // editor round-tripping + variant recompilation.
          const graph = uiGraphToMaterialGraph(nodes, connections);
          const material = compileGraphToMaterialWithGraph(graph, {
            name,
            blendMode,
            cullMode,
            profile: options?.profile as any,
          });
          this.materialLibrary.register(material);
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
          const graph = uiGraphToMaterialGraph(graphData.nodes, graphData.connections);
          const material = compileGraphToMaterialWithGraph(graph, {
            name,
            blendMode: (graphData.blendMode as any) ?? "opaque",
            cullMode: (graphData.cullMode as any) ?? "back",
          });
          this.materialLibrary.register(material);
          return { success: true };
        } catch (e: any) {
          return { success: false, error: String(e?.message ?? e) };
        }
      },

      listMaterials: (): { name: string; shader: string; type: string }[] => {
        return this.materialLibrary.list().map((m) => ({
          name: m.name,
          shader: m.shader,
          type: m.materialType,
        }));
      },

      exportMaterialAsJSON: (name: string): string | null => {
        const material = this.materialLibrary.get(name);
        if (!material || !material.graph) return null;
        return JSON.stringify({
          name: material.name,
          nodes: material.graph.getNodes(),
          connections: material.graph.getConnections(),
          blendMode: material.blendMode,
          cullMode: material.cullMode,
          profile: material.profile,
        });
      },

      importMaterialFromJSON: (json: string): { success: boolean; name?: string; error?: string } => {
        try {
          const data = JSON.parse(json);
          if (!data.nodes || !data.connections) {
            return { success: false, error: "Invalid material JSON" };
          }
          const graph = uiGraphToMaterialGraph(data.nodes, data.connections);
          const material = compileGraphToMaterialWithGraph(graph, {
            name: data.name ?? "imported_material",
            blendMode: data.blendMode ?? "opaque",
            cullMode: data.cullMode ?? "back",
            profile: data.profile,
          });
          this.materialLibrary.register(material);
          return { success: true, name: material.name };
        } catch (e: any) {
          return { success: false, error: String(e?.message ?? e) };
        }
      },

      /**
       * Live preview: compile the graph and set the resulting material on the
       * preview mesh renderer so the editor viewport renders it in real time.
       */
      previewMaterialGraph: (nodes: UINodeData[], connections: UIConnection[], options?: {
        blendMode?: string; cullMode?: string; profile?: string;
      }): { success: boolean; error?: string } => {
        try {
          const material = compileUIGraphToMaterial(nodes, connections, {
            name: "preview_material",
            blendMode: (options?.blendMode as any) ?? "opaque",
            cullMode: (options?.cullMode as any) ?? "back",
            profile: options?.profile as any,
          });
          this.previewMeshRenderer?.setMaterial(material);
          return { success: true };
        } catch (e: any) {
          return { success: false, error: String(e?.message ?? e) };
        }
      },

      /** Set the preview mesh renderer for live material graph preview. */
      setPreviewMeshRenderer: (renderer: { setMaterial: (m: Material) => void } | null): void => {
        this.previewMeshRenderer = renderer;
      },

      /** Get the core material library (for game integration). */
      getMaterialLibrary: (): MaterialLibrary => {
        return this.materialLibrary;
      },
    });
    return api;
  }

  // --- Thumbnail generation (generic, uses asset resolver) ---

  private thumbnailCache = new Map<string, string | null>();

  protected async generateThumbnail(path: string, resolver: IAssetResolver): Promise<string | null> {
    const cached = this.thumbnailCache.get(path);
    if (cached !== undefined) return cached;
    try {
      const file = resolver.getAvailableModels().find((f) => f.path === path);
      if (!file) { this.evictThumbnailCache(); this.thumbnailCache.set(path, null); return null; }

      const buffer = resolver.syncFetchArrayBuffer(file.url);
      if (!buffer) { this.evictThumbnailCache(); this.thumbnailCache.set(path, null); return null; }
      const modelData = await loadModel(buffer, file.name);
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
}
