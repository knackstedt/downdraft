import type { MeshData } from "../mesh/builder";
import { convertPluginMesh, type PluginMeshData } from "./model-to-mesh";

// --- Public types (kept for back-compat) -----------------------------------

export interface GLTFNode {
  name?: string;
  mesh?: number;
  children?: number[];
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
}

export interface GLTFMesh {
  name?: string;
  primitives: GLTFPrimitive[];
}

export interface GLTFPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
}

export interface GLTFAccessor {
  bufferView: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}

export interface GLTFBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  target?: number;
}

export interface GLTFBuffer {
  byteLength: number;
  uri?: string;
}

export interface GLTFDocument {
  asset?: { version: string; generator?: string };
  buffers?: GLTFBuffer[];
  bufferViews?: GLTFBufferView[];
  accessors?: GLTFAccessor[];
  meshes?: GLTFMesh[];
  nodes?: GLTFNode[];
  materials?: unknown[];
  images?: unknown[];
  textures?: unknown[];
}

// --- GLBLoader (delegating shim) -------------------------------------------
// The plugin parser (@downdraft/plugin-models parseGLTF) is the single source
// of truth for glTF parsing, including codec dispatch (Draco, meshopt, etc.).
// This class delegates to it and converts the result to engine MeshData via
// convertPluginMesh. It's kept for back-compat with existing call sites
// (hot-reload, mcp/asset, AssetImporter).

interface PluginModelData {
  meshes: PluginMeshData[];
  name: string;
  format: string;
  materials?: unknown[];
  animations?: unknown[];
  nodes?: PluginModelNode[];
  skin?: unknown;
}

interface PluginModelNode {
  name: string;
  children?: number[];
  mesh?: number;
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
  nodeIndex?: number;
}

export class GLBLoader {
  async load(uri: string): Promise<{ meshes: MeshData[]; nodes: GLTFNode[] }> {
    const response = await fetch(uri);
    const buffer = await response.arrayBuffer();
    return this.parseGLB(buffer);
  }

  async parseGLB(buffer: ArrayBuffer): Promise<{ meshes: MeshData[]; nodes: GLTFNode[] }> {
    // Check if this is actually a GLB or a plain JSON .gltf
    const view = new DataView(buffer);
    const magic = view.getUint32(0, true);
    const isGLB = magic === 0x46546c67;

    const { parseGLTF } = await import("@downdraft/plugin-models");
    const modelData = (await parseGLTF(buffer, "glb", isGLB, null)) as PluginModelData;

    // Convert plugin meshes to engine MeshData
    const meshes = modelData.meshes.map((m) => convertPluginMesh(m, "pbr"));

    // Convert nodes
    const nodes: GLTFNode[] = (modelData.nodes ?? []).map((n) => ({
      name: n.name,
      mesh: n.mesh,
      children: n.children,
      translation: n.translation,
      rotation: n.rotation,
      scale: n.scale,
    }));

    return { meshes, nodes };
  }

  async parseGLTFJSON(doc: GLTFDocument): Promise<{ meshes: MeshData[]; nodes: GLTFNode[] }> {
    // Re-encode the JSON doc to a buffer and parse via the plugin parser.
    // This handles the case where the caller has already parsed the JSON.
    const jsonStr = JSON.stringify(doc);
    const encoder = new TextEncoder();
    const data = encoder.encode(jsonStr).buffer;

    const { parseGLTF } = await import("@downdraft/plugin-models");
    const modelData = (await parseGLTF(data, "gltf", false, null)) as PluginModelData;

    const meshes = modelData.meshes.map((m) => convertPluginMesh(m, "pbr"));
    const nodes: GLTFNode[] = (modelData.nodes ?? []).map((n) => ({
      name: n.name,
      mesh: n.mesh,
      children: n.children,
      translation: n.translation,
      rotation: n.rotation,
      scale: n.scale,
    }));

    return { meshes, nodes };
  }
}
