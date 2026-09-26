import type { GLBLoader, GLTFDocument } from "./loader-mesh";

export interface ImportOptions {
  format: "gltf" | "glb";
  generateNormals?: boolean;
  generateTangents?: boolean;
  flipY?: boolean;
  scale?: number;
}

export interface ImportResult {
  document: GLTFDocument;
  /** Parsed model data (plugin ModelData shape) with meshes, materials, etc. */
  model?: unknown;
  binaryBuffer: Uint8Array | null;
  warnings: string[];
}

export class AssetImporter {
  private loader: GLBLoader;

  constructor(loader: GLBLoader) {
    this.loader = loader;
  }

  async importGLB(data: ArrayBuffer, options?: ImportOptions): Promise<ImportResult> {
    const warnings: string[] = [];
    const { meshes, nodes } = await this.loader.parseGLB(data);

    // Apply scale: bake into vertex positions (uniform scale).
    let processedMeshes = meshes;
    if (options?.scale && options.scale !== 1) {
      const s = options.scale;
      processedMeshes.forEach((mesh) => {
        const verts = mesh.vertices;
        // Engine MeshData vertices are interleaved; position is at offset 0
        // per vertex. The stride depends on the layout. We use the layout
        // stride to find position offsets.
        const stride = mesh.layout.stride / 4; // floats per vertex
        for (let i = 0; i < mesh.vertexCount; i++) {
          const base = i * stride;
          verts[base + 0] *= s;
          verts[base + 1] *= s;
          verts[base + 2] *= s;
        }
      });
    }

    // Apply flipY: when flipY === false, flip UV V coordinate (1 - v).
    // Default (flipY true/undefined) leaves UVs as-is (glTF convention).
    if (options?.flipY === false) {
      // UVs are not stored separately in engine MeshData; they're interleaved
      // at offset 6-7 per vertex. Flip the V component.
      processedMeshes.forEach((mesh) => {
        const verts = mesh.vertices;
        const stride = mesh.layout.stride / 4;
        for (let i = 0; i < mesh.vertexCount; i++) {
          const base = i * stride;
          verts[base + 7] = 1 - verts[base + 7];
        }
      });
    }

    // Build a GLTFDocument-shaped object that retains mesh/node counts.
    const document = {
      asset: { version: "2.0" },
      meshes: processedMeshes.map((m, i) => ({
        name: `mesh_${i}`,
        primitives: [{ attributes: {}, mode: 4 }],
      })),
      nodes,
    } as unknown as GLTFDocument;

    return {
      document,
      model: { meshes: processedMeshes, nodes, name: "imported", format: "glb" },
      binaryBuffer: null,
      warnings,
    };
  }

  async importGLTF(json: object, binaryData?: ArrayBuffer): Promise<ImportResult> {
    const warnings: string[] = [];
    const doc = json as unknown as GLTFDocument;

    if (!doc.asset || !doc.asset.version) {
      warnings.push("Missing asset.version in GLTF document.");
    }

    if (doc.asset?.version && !doc.asset.version.startsWith("2.")) {
      warnings.push(`GLTF version ${doc.asset.version} — only 2.x is fully supported.`);
    }

    const { meshes, nodes } = await this.loader.parseGLTFJSON(doc);

    return {
      document: doc,
      model: { meshes, nodes, name: "imported", format: "gltf" },
      binaryBuffer: binaryData ? new Uint8Array(binaryData) : null,
      warnings,
    };
  }

  supportsFormat(extension: string): boolean {
    const ext = extension.toLowerCase().replace(".", "");
    return ext === "glb" || ext === "gltf";
  }
}
