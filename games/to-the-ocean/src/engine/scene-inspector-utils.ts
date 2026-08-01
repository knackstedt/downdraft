// Extracted from SceneInspector.ts — model loading utilities and caches

import { detectFormat, loadModel } from "./ModelLoader";

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

export interface AvailableModelFile {
  path: string;
  name: string;
  format: string;
  url: string;
}

export const availableModelFiles: AvailableModelFile[] = Object.entries(modelGlob).map(([filePath, url]) => {
  const parts = filePath.split("/");
  const name = parts[parts.length - 1];
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return { path: filePath, name, format: ext, url };
});

// Map texture basenames to their URLs for lookup
export const textureUrlMap = new Map<string, string>();
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
export const bufferCache = new Map<string, ArrayBuffer>();
export const thumbnailCache = new Map<string, string | null>();

export function syncFetchArrayBuffer(url: string): ArrayBuffer | null {
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

export function evictThumbnailCache(): void {
  while (thumbnailCache.size >= MAX_THUMBNAIL_CACHE_ENTRIES) {
    const oldestKey = thumbnailCache.keys().next().value;
    if (oldestKey === undefined) break;
    thumbnailCache.delete(oldestKey);
  }
}

export function findMTLForOBJ(filename: string, buffer: ArrayBuffer): ArrayBuffer | null {
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

export function findBinForGLTF(filename: string, buffer: ArrayBuffer): ArrayBuffer | null {
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

export async function asyncFetchArrayBuffer(url: string): Promise<ArrayBuffer | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return await resp.arrayBuffer();
  } catch {
    return null;
  }
}

