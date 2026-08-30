// Extracted from SceneInspector.ts — game-specific model asset discovery.
// Generic fetch/cache utilities live in @downdraft/module-devtools (asset-utils).

import {
    asyncFetchArrayBuffer,
    bufferCache,
    evictThumbnailCache,
    findBinForGLTF as pluginFindBinForGLTF,
    findMTLForOBJ as pluginFindMTLForOBJ,
    syncFetchArrayBuffer,
    thumbnailCache,
    type IAssetUrlMaps,
} from "@downdraft/module-devtools";

// Re-export generic utilities for backward compat
export { asyncFetchArrayBuffer, bufferCache, evictThumbnailCache, syncFetchArrayBuffer, thumbnailCache };

const modelGlob = import.meta.glob("../../assets/models/**/*.{fbx,gltf,glb,obj,dae,stl,FBX,GLTF,GLB,OBJ,DAE,STL}", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

const textureGlob = import.meta.glob("../../assets/models/**/*.{png,jpg,jpeg,tga,bmp,webp,PNG,JPG,JPEG,TGA,BMP,WEBP}", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

const mtlGlob = import.meta.glob("../../assets/models/**/*.{mtl,MTL}", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

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

export const textureUrlMap = new Map<string, string>();
for (const [filePath, url] of Object.entries(textureGlob)) {
  const parts = filePath.split("/");
  const basename = parts[parts.length - 1].toLowerCase();
  if (!textureUrlMap.has(basename)) {
    textureUrlMap.set(basename, url);
  }
}

const mtlUrlMap = new Map<string, string>();
for (const [filePath, url] of Object.entries(mtlGlob)) {
  const parts = filePath.split("/");
  const basename = parts[parts.length - 1].toLowerCase();
  if (!mtlUrlMap.has(basename)) {
    mtlUrlMap.set(basename, url);
  }
}

const binUrlMap = new Map<string, string>();
for (const [filePath, url] of Object.entries(binGlob)) {
  const parts = filePath.split("/");
  const basename = parts[parts.length - 1].toLowerCase();
  if (!binUrlMap.has(basename)) {
    binUrlMap.set(basename, url);
  }
}

const assetUrlMaps: IAssetUrlMaps = { textureUrlMap, mtlUrlMap, binUrlMap };

export function findMTLForOBJ(filename: string, buffer: ArrayBuffer): ArrayBuffer | null {
  return pluginFindMTLForOBJ(filename, buffer, assetUrlMaps);
}

export function findBinForGLTF(filename: string, buffer: ArrayBuffer): ArrayBuffer | null {
  return pluginFindBinForGLTF(filename, buffer, assetUrlMaps);
}
