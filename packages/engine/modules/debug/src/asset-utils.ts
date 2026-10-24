// ============================================================================
// Asset Utilities — generic model/texture/buffer fetching and cache management
// Games provide URL maps via IAssetUrlMaps; these utilities handle fetching.
// ============================================================================

import type { IAssetUrlMaps } from "./types";

const MAX_BUFFER_CACHE_ENTRIES = 20;
const MAX_THUMBNAIL_CACHE_ENTRIES = 50;

export const bufferCache = new Map<string, ArrayBuffer>();
export const thumbnailCache = new Map<string, string | null>();

export function syncFetchArrayBuffer(url: string): ArrayBuffer | null {
  const cached = bufferCache.get(url);
  if (cached) {
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

export function findMTLForOBJ(filename: string, buffer: ArrayBuffer, urlMaps: IAssetUrlMaps): ArrayBuffer | null {
  const text = new TextDecoder().decode(buffer);
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.toLowerCase().startsWith("mtllib")) {
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2) {
        const mtlName = parts[1];
        const mtlUrl = urlMaps.mtlUrlMap.get(mtlName.toLowerCase());
        if (mtlUrl) {
          return syncFetchArrayBuffer(mtlUrl);
        }
      }
    }
  }
  const baseName = filename.replace(/\.[^.]+$/, "").toLowerCase();
  const mtlUrl = urlMaps.mtlUrlMap.get(baseName + ".mtl");
  if (mtlUrl) {
    return syncFetchArrayBuffer(mtlUrl);
  }
  return null;
}

export function findBinForGLTF(filename: string, buffer: ArrayBuffer, urlMaps: IAssetUrlMaps): ArrayBuffer | null {
  try {
    const json = JSON.parse(new TextDecoder().decode(buffer));
    if (json.buffers && json.buffers[0] && json.buffers[0].uri) {
      const uri = json.buffers[0].uri;
      if (!uri.startsWith("data:")) {
        const binName = uri.split("/").pop() ?? uri;
        const binUrl = urlMaps.binUrlMap.get(binName.toLowerCase());
        if (binUrl) {
          return syncFetchArrayBuffer(binUrl);
        }
      }
    }
  } catch {
    // Not valid JSON or no buffers
  }
  const baseName = filename.replace(/\.[^.]+$/, "").toLowerCase();
  const binUrl = urlMaps.binUrlMap.get(baseName + ".bin");
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
