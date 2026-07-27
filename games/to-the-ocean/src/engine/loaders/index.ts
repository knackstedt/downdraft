import type { MeshData, MaterialData, ModelData, ModelFormat, AnimationData, ModelNode, SkinData, BoneData } from "./types";
import { detectFormat } from "./types";
import { parseOBJ } from "./obj";
import { parseGLTF } from "./gltf";
import { parseFBX } from "./fbx";
import { parseDAE } from "./dae";
import { parseSTL } from "./stl";

export function loadModel(data: ArrayBuffer, filename: string, mtlData?: ArrayBuffer | null, binData?: ArrayBuffer | null): ModelData {
  const format = detectFormat(filename);
  if (!format) throw new Error(`Unknown model format: ${filename}`);

  const baseName = filename.replace(/\.[^.]+$/, "");

  switch (format) {
    case "obj":
      return parseOBJ(data, baseName, mtlData);
    case "gltf":
      return parseGLTF(data, baseName, false, binData);
    case "glb":
      return parseGLTF(data, baseName, true);
    case "fbx":
      return parseFBX(data, baseName);
    case "dae":
      return parseDAE(data, baseName);
    case "stl":
      return parseSTL(data, baseName);
  }
}

export { detectFormat };
export type { MeshData, MaterialData, ModelData, ModelFormat, AnimationData, ModelNode, SkinData, BoneData };
