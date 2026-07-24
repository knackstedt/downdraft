import type { MeshData } from "../mesh/builder.ts";
import { PBR_VERTEX_LAYOUT, STANDARD_VERTEX_LAYOUT, type VertexLayout } from "../mesh/vertex-layout.ts";

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

const COMPONENT_TYPE_SIZE: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};

const COMPONENT_TYPE_ARRAY: Record<number, (n: number) => ArrayBufferView> = {
  5120: (n) => new Int8Array(n),
  5121: (n) => new Uint8Array(n),
  5122: (n) => new Int16Array(n),
  5123: (n) => new Uint16Array(n),
  5125: (n) => new Uint32Array(n),
  5126: (n) => new Float32Array(n),
};

const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

export class GLBLoader {
  private buffers: ArrayBuffer[] = [];
  private doc: GLTFDocument | null = null;

  async load(uri: string): Promise<{ meshes: MeshData[]; nodes: GLTFNode[] }> {
    const response = await fetch(uri);
    const buffer = await response.arrayBuffer();
    return this.parseGLB(buffer);
  }

  parseGLB(buffer: ArrayBuffer): { meshes: MeshData[]; nodes: GLTFNode[] } {
    const view = new DataView(buffer);
    const magic = view.getUint32(0, true);
    if (magic !== 0x46546c67) {
      return this.parseGLTFJSON(JSON.parse(new TextDecoder().decode(new Uint8Array(buffer))));
    }

    const version = view.getUint32(4, true);
    if (version !== 2) throw new Error(`Unsupported GLB version: ${version}`);
    const totalLength = view.getUint32(8, true);

    let offset = 12;
    let jsonChunk: ArrayBuffer | null = null;
    let binChunk: ArrayBuffer | null = null;

    while (offset < totalLength) {
      const chunkLength = view.getUint32(offset, true);
      const chunkType = view.getUint32(offset + 4, true);
      const chunkData = buffer.slice(offset + 8, offset + 8 + chunkLength);
      if (chunkType === 0x4e4f534a) {
        jsonChunk = chunkData;
      } else if (chunkType === 0x004e4942) {
        binChunk = chunkData;
      }
      offset += 8 + chunkLength;
    }

    if (!jsonChunk) throw new Error("GLB: No JSON chunk found");
    const doc = JSON.parse(new TextDecoder().decode(new Uint8Array(jsonChunk))) as GLTFDocument;

    this.buffers = [];
    if (binChunk) this.buffers.push(binChunk);
    if (doc.buffers) {
      for (let i = this.buffers.length; i < doc.buffers.length; i++) {
        this.buffers.push(new ArrayBuffer(doc.buffers[i].byteLength));
      }
    }

    this.doc = doc;
    const meshes = this.parseMeshes();
    const nodes = doc.nodes ?? [];
    return { meshes, nodes };
  }

  parseGLTFJSON(doc: GLTFDocument): { meshes: MeshData[]; nodes: GLTFNode[] } {
    this.doc = doc;
    this.buffers = (doc.buffers ?? []).map(() => new ArrayBuffer(0));
    const meshes = this.parseMeshes();
    const nodes = doc.nodes ?? [];
    return { meshes, nodes };
  }

  private getAccessorData(accessorIndex: number): { data: ArrayBufferView; count: number; components: number } {
    if (!this.doc?.accessors) throw new Error("No accessors");
    const accessor = this.doc.accessors[accessorIndex];
    const bufferView = this.doc.bufferViews![accessor.bufferView];
    const buffer = this.buffers[bufferView.buffer];

    const componentSize = COMPONENT_TYPE_SIZE[accessor.componentType];
    const components = TYPE_COMPONENTS[accessor.type];
    const stride = bufferView.byteStride ?? componentSize * components;
    const byteOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const count = accessor.count;
    const totalComponents = count * components;
    const arr = COMPONENT_TYPE_ARRAY[accessor.componentType](totalComponents);

    const view = new DataView(buffer, byteOffset, bufferView.byteLength);
    for (let i = 0; i < count; i++) {
      const elementOffset = i * stride;
      for (let c = 0; c < components; c++) {
        const bytePos = elementOffset + c * componentSize;
        switch (accessor.componentType) {
          case 5126: (arr as Float32Array)[i * components + c] = view.getFloat32(bytePos, true); break;
          case 5123: (arr as Uint16Array)[i * components + c] = view.getUint16(bytePos, true); break;
          case 5125: (arr as Uint32Array)[i * components + c] = view.getUint32(bytePos, true); break;
          case 5122: (arr as Int16Array)[i * components + c] = view.getInt16(bytePos, true); break;
          case 5121: (arr as Uint8Array)[i * components + c] = view.getUint8(bytePos); break;
          case 5120: (arr as Int8Array)[i * components + c] = view.getInt8(bytePos); break;
        }
      }
    }

    return { data: arr, count, components };
  }

  private parseMeshes(): MeshData[] {
    if (!this.doc?.meshes) return [];
    const result: MeshData[] = [];

    for (let mi = 0; mi < this.doc.meshes.length; mi++) {
      const mesh = this.doc.meshes[mi];
      for (let pi = 0; pi < mesh.primitives.length; pi++) {
        const prim = mesh.primitives[pi];
        const meshData = this.parsePrimitive(prim);
        if (meshData) result.push(meshData);
      }
    }

    return result;
  }

  private parsePrimitive(prim: GLTFPrimitive): MeshData | null {
    const hasTangent = prim.attributes.TANGENT !== undefined;
    const layout: VertexLayout = hasTangent ? PBR_VERTEX_LAYOUT : STANDARD_VERTEX_LAYOUT;
    const stride = layout.stride / 4;

    const posAccessor = this.getAccessorData(prim.attributes.POSITION);
    const vertexCount = posAccessor.count;
    const vertices = new Float32Array(vertexCount * stride);

    let normalData: { data: ArrayBufferView; count: number; components: number } | null = null;
    if (prim.attributes.NORMAL !== undefined) {
      normalData = this.getAccessorData(prim.attributes.NORMAL);
    }

    let uvData: { data: ArrayBufferView; count: number; components: number } | null = null;
    if (prim.attributes.TEXCOORD_0 !== undefined) {
      uvData = this.getAccessorData(prim.attributes.TEXCOORD_0);
    }

    let tangentData: { data: ArrayBufferView; count: number; components: number } | null = null;
    if (prim.attributes.TANGENT !== undefined) {
      tangentData = this.getAccessorData(prim.attributes.TANGENT);
    }

    for (let i = 0; i < vertexCount; i++) {
      const base = i * stride;
      vertices[base + 0] = (posAccessor.data as Float32Array)[i * 3 + 0];
      vertices[base + 1] = (posAccessor.data as Float32Array)[i * 3 + 1];
      vertices[base + 2] = (posAccessor.data as Float32Array)[i * 3 + 2];

      if (normalData) {
        vertices[base + 3] = (normalData.data as Float32Array)[i * 3 + 0];
        vertices[base + 4] = (normalData.data as Float32Array)[i * 3 + 1];
        vertices[base + 5] = (normalData.data as Float32Array)[i * 3 + 2];
      }

      if (uvData) {
        vertices[base + 6] = (uvData.data as Float32Array)[i * 2 + 0];
        vertices[base + 7] = (uvData.data as Float32Array)[i * 2 + 1];
      }

      if (hasTangent && tangentData) {
        vertices[base + 8] = (tangentData.data as Float32Array)[i * 4 + 0];
        vertices[base + 9] = (tangentData.data as Float32Array)[i * 4 + 1];
        vertices[base + 10] = (tangentData.data as Float32Array)[i * 4 + 2];
        vertices[base + 11] = (tangentData.data as Float32Array)[i * 4 + 3];
      } else {
        vertices[base + 8] = 1; vertices[base + 9] = 0; vertices[base + 10] = 0; vertices[base + 11] = 1;
      }
    }

    let indices: Uint16Array | Uint32Array;
    if (prim.indices !== undefined) {
      const indexData = this.getAccessorData(prim.indices);
      if (indexData.data instanceof Uint16Array) {
        indices = indexData.data as Uint16Array;
      } else if (indexData.data instanceof Uint32Array) {
        indices = indexData.data as Uint32Array;
      } else if (indexData.data instanceof Uint8Array) {
        indices = new Uint16Array(indexData.data as Uint8Array);
      } else {
        const src = indexData.data as Int8Array | Int16Array;
        indices = new Uint32Array(indexData.count);
        for (let i = 0; i < indexData.count; i++) {
          indices[i] = src[i];
        }
      }
    } else {
      indices = vertexCount > 65535
        ? new Uint32Array(vertexCount)
        : new Uint16Array(vertexCount);
      for (let i = 0; i < vertexCount; i++) indices[i] = i;
    }

    return {
      vertices,
      indices,
      layout,
      vertexCount,
      indexCount: indices.length,
    };
  }
}
