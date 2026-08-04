import type { GLBLoader } from "./loader-mesh";
import type { GLTFDocument } from "./loader-mesh";

export interface ImportOptions {
  format: "gltf" | "glb";
  generateNormals?: boolean;
  generateTangents?: boolean;
  flipY?: boolean;
  scale?: number;
}

export interface ImportResult {
  document: GLTFDocument;
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
    const { meshes, nodes } = this.loader.parseGLB(data);

    if (options?.scale && options.scale !== 1) {
      warnings.push(`Scale factor ${options.scale} not applied — use node transform scaling.`);
    }

    if (options?.flipY === false) {
      warnings.push("flipY=false not yet supported — GLB loader assumes Y-up.");
    }

    return {
      document: { meshes: [], nodes } as unknown as GLTFDocument,
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

    this.loader.parseGLTFJSON(doc);

    return {
      document: doc,
      binaryBuffer: binaryData ? new Uint8Array(binaryData) : null,
      warnings,
    };
  }

  supportsFormat(extension: string): boolean {
    const ext = extension.toLowerCase().replace(".", "");
    return ext === "glb" || ext === "gltf";
  }
}
