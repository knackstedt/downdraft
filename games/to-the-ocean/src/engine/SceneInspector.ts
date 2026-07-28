// ============================================================================
// Scene Inspector — exposes window.__sceneInspector API for DevTools panel
// Bridges between the DevTools extension and the renderer/scene store
// ============================================================================

import { startGCProfiler, type GCProfilerHandle, type GCStats } from "@shared/gc-profiler";
import { ENT, PLR, PLR_FLAG } from "@shared/sim-buffer";
import { EntityType, EntityTypeNames, WeatherType } from "@shared/types";
import { simBridge } from "../simBridge";
import { useDebugStore } from "../stores/debugStore";
import { useSceneStore, type GizmoMode, type SceneTreeSnapshot } from "../stores/sceneStore";
import { detectFormat, loadModel } from "./ModelLoader";
import type { WebGPURenderer } from "./WebGPURenderer";

// Discover model files in assets/models at build time via Vite glob
const modelGlob = import.meta.glob("../../assets/models/**/*.{fbx,gltf,glb,obj,dae,stl,FBX,GLTF,GLB,OBJ,DAE,STL}", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

// Discover texture files for resolving external texture references
const textureGlob = import.meta.glob("../../assets/models/**/*.{png,jpg,jpeg,tga,bmp,webp,PNG,JPG,JPEG,TGA,BMP,WEBP}", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

// Discover MTL files for OBJ material loading
const mtlGlob = import.meta.glob("../../assets/models/**/*.{mtl,MTL}", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

// Discover .bin files for GLTF external buffer loading
const binGlob = import.meta.glob("../../assets/models/**/*.bin", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

interface AvailableModelFile {
  path: string;
  name: string;
  format: string;
  url: string;
}

const availableModelFiles: AvailableModelFile[] = Object.entries(modelGlob).map(([filePath, url]) => {
  const parts = filePath.split("/");
  const name = parts[parts.length - 1];
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return { path: filePath, name, format: ext, url };
});

// Map texture basenames to their URLs for lookup
const textureUrlMap = new Map<string, string>();
for (const [filePath, url] of Object.entries(textureGlob)) {
  const parts = filePath.split("/");
  const basename = parts[parts.length - 1].toLowerCase();
  if (!textureUrlMap.has(basename)) {
    textureUrlMap.set(basename, url);
  }
}

// Map MTL basenames to their URLs for lookup
const mtlUrlMap = new Map<string, string>();
for (const [filePath, url] of Object.entries(mtlGlob)) {
  const parts = filePath.split("/");
  const basename = parts[parts.length - 1].toLowerCase();
  if (!mtlUrlMap.has(basename)) {
    mtlUrlMap.set(basename, url);
  }
}

// Map .bin basenames to their URLs for lookup
const binUrlMap = new Map<string, string>();
for (const [filePath, url] of Object.entries(binGlob)) {
  const parts = filePath.split("/");
  const basename = parts[parts.length - 1].toLowerCase();
  if (!binUrlMap.has(basename)) {
    binUrlMap.set(basename, url);
  }
}

const MAX_BUFFER_CACHE_ENTRIES = 20;
const MAX_THUMBNAIL_CACHE_ENTRIES = 50;
const bufferCache = new Map<string, ArrayBuffer>();
const thumbnailCache = new Map<string, string | null>();

function syncFetchArrayBuffer(url: string): ArrayBuffer | null {
  const cached = bufferCache.get(url);
  if (cached) {
    // Move to end (most recently used) by re-inserting
    bufferCache.delete(url);
    bufferCache.set(url, cached);
    return cached;
  }
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url, false);
  xhr.overrideMimeType("text/plain; charset=x-user-defined");
  xhr.send();
  if (xhr.status !== 200) return null;
  const text = xhr.responseText;
  const buffer = new ArrayBuffer(text.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < text.length; i++) {
    bytes[i] = text.charCodeAt(i) & 0xff;
  }
  // Evict oldest entries if cache is full
  while (bufferCache.size >= MAX_BUFFER_CACHE_ENTRIES) {
    const oldestKey = bufferCache.keys().next().value;
    if (oldestKey === undefined) break;
    bufferCache.delete(oldestKey);
  }
  bufferCache.set(url, buffer);
  return buffer;
}

function evictThumbnailCache(): void {
  while (thumbnailCache.size >= MAX_THUMBNAIL_CACHE_ENTRIES) {
    const oldestKey = thumbnailCache.keys().next().value;
    if (oldestKey === undefined) break;
    thumbnailCache.delete(oldestKey);
  }
}

function findMTLForOBJ(filename: string, buffer: ArrayBuffer): ArrayBuffer | null {
  // Parse the OBJ text to find mtllib reference
  const text = new TextDecoder().decode(buffer);
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.toLowerCase().startsWith("mtllib")) {
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2) {
        const mtlName = parts[1];
        const mtlUrl = mtlUrlMap.get(mtlName.toLowerCase());
        if (mtlUrl) {
          return syncFetchArrayBuffer(mtlUrl);
        }
      }
    }
  }
  // Fallback: try basename.mtl
  const baseName = filename.replace(/\.[^.]+$/, "").toLowerCase();
  const mtlUrl = mtlUrlMap.get(baseName + ".mtl");
  if (mtlUrl) {
    return syncFetchArrayBuffer(mtlUrl);
  }
  return null;
}

function findBinForGLTF(filename: string, buffer: ArrayBuffer): ArrayBuffer | null {
  // Parse the GLTF JSON to find the buffer URI
  try {
    const json = JSON.parse(new TextDecoder().decode(buffer));
    if (json.buffers && json.buffers[0] && json.buffers[0].uri) {
      const uri = json.buffers[0].uri;
      if (!uri.startsWith("data:")) {
        const binName = uri.split("/").pop() ?? uri;
        const binUrl = binUrlMap.get(binName.toLowerCase());
        if (binUrl) {
          return syncFetchArrayBuffer(binUrl);
        }
      }
    }
  } catch {
    // Not valid JSON or no buffers
  }
  // Fallback: try basename.bin
  const baseName = filename.replace(/\.[^.]+$/, "").toLowerCase();
  const binUrl = binUrlMap.get(baseName + ".bin");
  if (binUrl) {
    return syncFetchArrayBuffer(binUrl);
  }
  return null;
}

async function asyncFetchArrayBuffer(url: string): Promise<ArrayBuffer | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return await resp.arrayBuffer();
  } catch {
    return null;
  }
}

export class SceneInspector {
  private renderer: WebGPURenderer | null = null;
  private initialized = false;
  private perfGcHandle: GCProfilerHandle | null = null;
  private perfActive = false;

  init(renderer: WebGPURenderer): void {
    this.renderer = renderer;
    this.initialized = true;

    const api = {
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

      importModel: (base64Data: string, filename: string): { success: boolean; nodeId?: string; error?: string } => {
        try {
          // Support chunked transfer: if base64Data is "__importBuffer", read from window
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

          // For OBJ files, try to load the MTL file
          let mtlData: ArrayBuffer | null = null;
          if (format === "obj") {
            mtlData = findMTLForOBJ(filename, buffer);
          }

          // For GLTF files, try to load the external .bin buffer
          let binData: ArrayBuffer | null = null;
          if (format === "gltf") {
            binData = findBinForGLTF(filename, buffer);
          }

          const modelData = loadModel(buffer, filename, mtlData, binData);
          if (modelData.meshes.length === 0) {
            return { success: false, error: "No meshes found in model" };
          }

          // Try to load external textures from bundled assets
          if (modelData.materials) {
            for (let i = 0; i < modelData.materials.length; i++) {
              const mat = modelData.materials[i];
              if (!mat.textureData && mat.textureUri) {
                const texUrl = textureUrlMap.get(mat.textureUri.toLowerCase());
                if (texUrl) {
                  const texBuf = syncFetchArrayBuffer(texUrl);
                  if (texBuf) {
                    mat.textureData = texBuf;
                  }
                }
              }
            }
          }

          // Get player position for initial model placement
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
        return availableModelFiles;
      },

      getModelThumbnail: (path: string): string | null => {
        const cachedThumb = thumbnailCache.get(path);
        if (cachedThumb !== undefined) return cachedThumb;
        try {
          const file = availableModelFiles.find((f) => f.path === path);
          if (!file) { evictThumbnailCache(); thumbnailCache.set(path, null); return null; }

          const buffer = syncFetchArrayBuffer(file.url);
          if (!buffer) { evictThumbnailCache(); thumbnailCache.set(path, null); return null; }
          const modelData = loadModel(buffer, file.name);
          if (modelData.meshes.length === 0) { evictThumbnailCache(); thumbnailCache.set(path, null); return null; }

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
          evictThumbnailCache();
          thumbnailCache.set(path, dataUrl);
          return dataUrl;
        } catch (e) {
          console.error("[SceneInspector] Thumbnail error for path:", path, e);
          evictThumbnailCache();
          thumbnailCache.set(path, null);
          return null;
        }
      },

      importAssetModel: (path: string): { success: boolean; nodeId?: string; error?: string } => {
        try {
          const file = availableModelFiles.find((f) => f.path === path);
          if (!file) {
            return { success: false, error: `Model not found: ${path}` };
          }
          // Synchronous XHR to fetch the bundled asset (eval doesn't await Promises)
          const buffer = syncFetchArrayBuffer(file.url);
          if (!buffer) {
            return { success: false, error: `Fetch failed for ${file.name}` };
          }
          // For OBJ files, try to load the MTL file
          let mtlData: ArrayBuffer | null = null;
          if (file.format === "obj") {
            mtlData = findMTLForOBJ(file.name, buffer);
          }

          // For GLTF files, try to load the external .bin buffer
          let binData: ArrayBuffer | null = null;
          if (file.format === "gltf") {
            binData = findBinForGLTF(file.name, buffer);
          }

          const modelData = loadModel(buffer, file.name, mtlData, binData);
          if (modelData.meshes.length === 0) {
            return { success: false, error: `No meshes found in ${file.name}` };
          }

          // Try to load external textures referenced by materials
          if (modelData.materials) {
            for (let i = 0; i < modelData.materials.length; i++) {
              const mat = modelData.materials[i];
              if (!mat.textureData && mat.textureUri) {
                const texUrl = textureUrlMap.get(mat.textureUri.toLowerCase());
                if (texUrl) {
                  const texBuf = syncFetchArrayBuffer(texUrl);
                  if (texBuf) {
                    mat.textureData = texBuf;
                  }
                } else {
                  console.warn(`[SceneInspector] Texture not found: ${mat.textureUri}`);
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

      getBoatLayout: (): { boats: { entityId: number; cells: { type: number; rotation: number; gridX: number; gridY: number; gridZ: number }[] }[] } => {
        const reader = this.renderer?.getBoatReader();
        if (!reader || !reader.isValid()) return { boats: [] };
        const count = reader.getBoatCount();
        const boats: { entityId: number; cells: { type: number; rotation: number; gridX: number; gridY: number; gridZ: number }[] }[] = [];
        for (let s = 0; s < count; s++) {
          const eid = reader.getBoatEntityId(s);
          if (!eid) continue;
          const cells = reader.getBoatCells(s);
          boats.push({
            entityId: eid,
            cells: cells.map(c => ({ type: c.type, rotation: c.rotation, gridX: c.gridX, gridY: c.gridY, gridZ: c.gridZ })),
          });
        }
        return { boats };
      },

      // --- Sim / World State ---
      getSimState: (): any => {
        const sim = this.renderer?.getSimReader();
        if (!sim || !sim.isValid()) return null;
        const weatherNames: Record<number, string> = {};
        for (const k of Object.keys(WeatherType)) {
          const v = (WeatherType as any)[k];
          if (typeof v === "number") weatherNames[v] = k;
        }
        const wind = sim.getWindDir();
        const tod = sim.getTimeOfDay();
        const hours = Math.floor(tod * 24);
        const mins = Math.floor((tod * 24 - hours) * 60);
        return {
          tick: sim.getTick(),
          timeOfDay: tod,
          timeStr: `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}`,
          weatherType: sim.getWeatherType(),
          weatherName: weatherNames[sim.getWeatherType()] ?? `Type${sim.getWeatherType()}`,
          weatherIntensity: sim.getWeatherIntensity(),
          windSpeed: sim.getWindSpeed(),
          windDirX: wind.x,
          windDirZ: wind.z,
          visibility: sim.getVisibility(),
          ambientTemp: sim.getAmbientTemp(),
          activePlayers: sim.getActivePlayers(),
          gamemode: sim.getGamemode(),
          entityCount: sim.getEntityCount(),
          playerCount: sim.getPlayerCount(),
          chunkCount: sim.getChunkCount(),
        };
      },

      // --- Player Stats ---
      getPlayerStats: (): any => {
        const sim = this.renderer?.getSimReader();
        if (!sim || !sim.isValid()) return null;
        const count = sim.getPlayerCount();
        const players: any[] = [];
        for (let i = 0; i < count; i++) {
          const slot = sim.getPlayerSlot(i);
          if (!slot) continue;
          const f32 = slot.f32;
          const u32 = slot.u32;
          const flags = u32[PLR.FLAGS];
          const flagNames: string[] = [];
          for (const [name, bit] of Object.entries(PLR_FLAG)) {
            if (typeof bit === "number" && (flags & bit)) flagNames.push(name);
          }
          players.push({
            slot: i,
            playerId: u32[PLR.PLAYER_ID],
            entityId: u32[PLR.ENTITY_ID],
            position: [f32[PLR.POS_X], f32[PLR.POS_Y], f32[PLR.POS_Z]],
            heading: f32[PLR.HEADING],
            pitch: f32[PLR.PITCH] ?? 0,
            health: f32[PLR.HEALTH],
            maxHealth: f32[PLR.MAX_HEALTH],
            hunger: f32[PLR.HUNGER],
            thirst: f32[PLR.THIRST],
            oxygen: f32[PLR.OXYGEN],
            maxOxygen: f32[PLR.MAX_OXYGEN],
            temperature: f32[PLR.TEMPERATURE],
            gold: f32[PLR.GOLD],
            cameraMode: u32[PLR.CAMERA_MODE],
            flags,
            flagNames,
          });
        }
        return { players };
      },

      // --- Entity Sim Data (velocity, health, data fields, flags) ---
      getEntitySimData: (entityId: number): any => {
        const sim = this.renderer?.getSimReader();
        if (!sim || !sim.isValid()) return null;
        const count = sim.getEntityCount();
        for (let i = 0; i < count; i++) {
          const slot = sim.getEntitySlot(i);
          if (!slot) continue;
          if (slot.u32[ENT.ID] !== entityId) continue;
          const f32 = slot.f32;
          const u32 = slot.u32;
          const type = u32[ENT.TYPE];
          const data: number[] = [];
          for (let d = 0; d < 8; d++) data.push(f32[ENT.DATA + d]);
          return {
            entityId,
            type,
            typeName: EntityTypeNames[type] ?? `Type${type}`,
            velocity: [f32[ENT.VEL_X], f32[ENT.VEL_Y], f32[ENT.VEL_Z]],
            angularVelocity: [f32[ENT.ANGVEL_X], f32[ENT.ANGVEL_Y], f32[ENT.ANGVEL_Z]],
            health: f32[ENT.HEALTH],
            maxHealth: f32[ENT.MAX_HEALTH],
            flags: u32[ENT.FLAGS],
            parentId: u32[ENT.PARENT_ID],
            chunkX: u32[ENT.CHUNK_X],
            chunkZ: u32[ENT.CHUNK_Z],
            data,
          };
        }
        return null;
      },

      // --- Physics Stats ---
      getPhysicsStats: (): any => {
        const sim = this.renderer?.getSimReader();
        if (!sim || !sim.isValid()) return null;
        return {
          initialized: sim.getPhysicsInitialized() === 1,
          failed: sim.getPhysicsFailed() === 1,
          bodyCount: sim.getPhysicsBodyCount(),
          tickCount: sim.getPhysicsTickCount(),
        };
      },

      // --- Renderer Stats (duplicate of in-game debug panel) ---
      getRendererStats: (): any => {
        const sim = this.renderer?.getSimReader();
        if (!sim || !sim.isValid()) return null;
        const playerSlot = sim.getPlayerSlot(0);
        if (!playerSlot) return null;
        const f32 = playerSlot.f32;
        const u32 = playerSlot.u32;
        const waterReader = this.renderer?.getWaterReader();
        const keys = Array.from((this.renderer as any).keysDown as Set<number>).map((k: number) => String.fromCharCode(k)).join(",");
        return {
          fps: this.renderer?.getFPS() ?? 0,
          entityCount: sim.getEntityCount(),
          playerCount: sim.getPlayerCount(),
          tick: sim.getTick(),
          canvasW: this.renderer?.getCanvasWidth() ?? 0,
          canvasH: this.renderer?.getCanvasHeight() ?? 0,
          viewportW: this.renderer?.getViewportWidth(0) ?? 0,
          viewportH: this.renderer?.getViewportHeight(0) ?? 0,
          waterValid: waterReader?.isValid() ?? false,
          waterGrid: waterReader?.getGridSize() ?? 0,
          playerPos: [f32[PLR.POS_X], f32[PLR.POS_Y], f32[PLR.POS_Z]],
          heading: f32[PLR.HEADING],
          pitch: f32[PLR.PITCH] ?? 0,
          cameraMode: u32[PLR.CAMERA_MODE],
          keys,
        };
      },

      // --- Hitbox Toggle ---
      setShowHitboxes: (show: boolean): void => {
        this.renderer?.setShowHitboxes(show);
      },
      getShowHitboxes: (): boolean => {
        return (this.renderer as any)?.entityRenderer?.showHitboxes ?? false;
      },
      setHitboxLineWidth: (width: number): void => {
        this.renderer?.setHitboxLineWidth(width);
      },
      getHitboxLineWidth: (): number => {
        return this.renderer?.getHitboxLineWidth() ?? 3;
      },

      // --- Chunk Grid Toggle ---
      setShowChunkGrid: (show: boolean): void => {
        this.renderer?.setShowChunkGrid(show);
      },
      getShowChunkGrid: (): boolean => {
        return this.renderer?.isChunkGridVisible() ?? false;
      },

      // --- Velocity Arrows Toggle ---
      setShowVelocityArrows: (show: boolean): void => {
        this.renderer?.setShowVelocityArrows(show);
      },
      getShowVelocityArrows: (): boolean => {
        return this.renderer?.isVelocityArrowsVisible() ?? false;
      },

      // --- World / Biome / Port / Island Control ---

      getWorldEntities: (): any => {
        const sim = this.renderer?.getSimReader();
        if (!sim || !sim.isValid()) return { ports: [], islands: [] };
        const count = sim.getEntityCount();
        const ports: any[] = [];
        const islands: any[] = [];
        for (let i = 0; i < count; i++) {
          const slot = sim.getEntitySlot(i);
          if (!slot) continue;
          const type = slot.u32[ENT.TYPE];
          if (type === EntityType.Port) {
            ports.push({
              entityId: slot.u32[ENT.ID],
              chunkX: slot.u32[ENT.CHUNK_X],
              chunkZ: slot.u32[ENT.CHUNK_Z],
              position: [slot.f32[ENT.POS_X], slot.f32[ENT.POS_Y], slot.f32[ENT.POS_Z]],
              scale: slot.f32[ENT.SCALE],
              size: slot.f32[ENT.DATA],
              biome: slot.f32[ENT.DATA + 5],
            });
          } else if (type === EntityType.Island) {
            islands.push({
              entityId: slot.u32[ENT.ID],
              chunkX: slot.u32[ENT.CHUNK_X],
              chunkZ: slot.u32[ENT.CHUNK_Z],
              position: [slot.f32[ENT.POS_X], slot.f32[ENT.POS_Y], slot.f32[ENT.POS_Z]],
              scale: slot.f32[ENT.SCALE],
              radius: slot.f32[ENT.DATA],
              biome: slot.f32[ENT.DATA + 1],
              size: slot.f32[ENT.DATA + 2],
            });
          }
        }
        return { ports, islands };
      },

      getPlayerChunk: (): { chunkX: number; chunkZ: number; worldX: number; worldZ: number } => {
        const sim = this.renderer?.getSimReader();
        if (!sim || !sim.isValid()) return { chunkX: 0, chunkZ: 0, worldX: 0, worldZ: 0 };
        const slot = sim.getPlayerSlot(0);
        if (!slot) return { chunkX: 0, chunkZ: 0, worldX: 0, worldZ: 0 };
        const wx = slot.f32[PLR.POS_X];
        const wz = slot.f32[PLR.POS_Z];
        const chunkSize = 256;
        return {
          chunkX: Math.floor(wx / chunkSize),
          chunkZ: Math.floor(wz / chunkSize),
          worldX: wx,
          worldZ: wz,
        };
      },

      sendWorldCommand: (cmd: any): void => {
        simBridge.sendWorldCommand(cmd);
      },

      setWeather: (weatherType: number): void => {
        simBridge.setWeather(weatherType);
      },

      setTimeOfDay: (time: number): void => {
        simBridge.setTimeOfDay(time);
      },

      getBiomeList: (): { value: number; name: string }[] => {
        const biomeNames: Record<number, string> = {
          0: "Lake", 1: "Arctic", 2: "Desert", 3: "Boreal Forest",
          4: "Tropical", 5: "Sub-Tropical", 6: "Freshwater", 7: "Ocean",
          8: "Deep Ocean", 9: "Coral Reef", 10: "Kelp Forest", 11: "Volcanic",
          12: "Garbage Patch", 13: "Hell",
        };
        const result: { value: number; name: string }[] = [];
        for (let i = 0; i <= 13; i++) {
          result.push({ value: i, name: biomeNames[i] ?? `Biome ${i}` });
        }
        return result;
      },

      // --- External Performance Metrics ---
      enablePerformanceMonitoring: (): void => {
        if (this.perfActive) return;
        this.perfActive = true;

        // Start renderer GC profiler
        if (!this.perfGcHandle) {
          this.perfGcHandle = startGCProfiler('renderer', (stats: GCStats) => {
            useDebugStore.getState().updateGCStats(stats);
          });
        }

        // Enable debug mode on renderer + sim worker (starts their GC + perf collectors)
        this.renderer?.setDebugMode(true);
        simBridge.setDebugMode(true);
      },

      disablePerformanceMonitoring: (): void => {
        if (!this.perfActive) return;
        this.perfActive = false;

        this.perfGcHandle?.stop();
        this.perfGcHandle = null;

        // Only disable debug mode if the F3 debug page isn't active
        if (!useDebugStore.getState().showDebugPage) {
          this.renderer?.setDebugMode(false);
          simBridge.setDebugMode(false);
        }
      },

      getPerformanceMetrics: (): any => {
        const pm = (window as any).__perfMetrics ?? {};
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

        const main = pm.main;
        const worker = pm.worker;

        return {
          gpu: {
            utilization: gpuUtil,
            frameTimeMs,
            fps,
          },
          renderer: {
            cpuPercent: gpuUtil,
            memUsedMB: rendererMemMB,
            diskKBps: 0,
            networkKBps: 0,
            gc: gcFor("renderer"),
          },
          main: {
            cpuPercent: main?.cpuPercent ?? 0,
            memUsedMB: main?.memUsedMB ?? 0,
            diskKBps: 0,
            networkKBps: 0,
            gc: gcFor("main"),
          },
          worker: {
            cpuPercent: worker?.cpuPercent ?? 0,
            memUsedMB: worker?.memUsedMB ?? 0,
            diskKBps: 0,
            networkKBps: 0,
            gc: gcFor("sim-worker"),
          },
          timestamp: performance.now(),
        };
      },

      getVersion: (): string => {
        return "1.0.0";
      },
    };

    (window as any).__sceneInspector = api;
    console.log("[SceneInspector] API exposed on window.__sceneInspector");

    // Apply default overlay states so they're active before the DevTools panel loads.
    // The panel will override these with saved localStorage preferences when its tab is opened.
    useSceneStore.getState().setShowLabels(true);
    this.renderer?.setShowHitboxes(true);
    this.renderer?.setShowChunkGrid(true);
    this.renderer?.setShowVelocityArrows(true);
  }

  destroy(): void {
    this.initialized = false;
    this.renderer = null;
    delete (window as any).__sceneInspector;
  }
}
