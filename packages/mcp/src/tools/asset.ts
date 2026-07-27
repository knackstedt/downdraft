import type { EngineContext } from "../engine-context.ts";
import type { ToolRegistration } from "../types.ts";
import { jsonResult, errorResult } from "../types.ts";
import { AssetImporter } from "@downdraft/core";
import type { ImportOptions } from "@downdraft/core";
import { promises as fs } from "node:fs";

export function createAssetTools(ctx: EngineContext): ToolRegistration[] {
  const tools: ToolRegistration[] = [

    {
      def: {
        name: "import_texture",
        description: "Import and convert a texture file to engine format.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to texture file (PNG, WebP, KTX2)" },
            format: { type: "string", description: "Target format (default: auto-detect)" },
          },
          required: ["path"],
        },
      },
      handler: async (params) => {
        const path = params.path as string;
        try {
          const data = await ctx.assetManager.load(path);
          return jsonResult({ imported: true, path, type: typeof data });
        } catch (e) {
          return errorResult(`Failed to import texture: ${(e as Error).message}`);
        }
      },
    },

    {
      def: {
        name: "convert_asset",
        description: "Convert a 3D model asset (GLB/GLTF) to engine format with optional options.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to source asset file (GLB, GLTF)" },
            format: {
              type: "string",
              enum: ["gltf", "glb"],
              description: "Target format (default: glb)",
            },
            generateNormals: { type: "boolean", description: "Generate normals if missing" },
            generateTangents: { type: "boolean", description: "Generate tangents if missing" },
            flipY: { type: "boolean", description: "Flip Y axis (default: true)" },
            scale: { type: "number", description: "Scale factor" },
          },
          required: ["path"],
        },
      },
      handler: async (params) => {
        const path = params.path as string;
        const format = (params.format as "gltf" | "glb") ?? "glb";

        const options: ImportOptions = {
          format,
          generateNormals: params.generateNormals as boolean | undefined,
          generateTangents: params.generateTangents as boolean | undefined,
          flipY: params.flipY as boolean | undefined,
          scale: params.scale as number | undefined,
        };

        try {
          const buf = await fs.readFile(path);
          const fileData = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          const ext = path.split(".").pop()?.toLowerCase() ?? "";

          const loader = new (await import("@downdraft/core")).GLBLoader();
          const importer = new AssetImporter(loader);

          let result;
          if (ext === "glb") {
            result = await importer.importGLB(fileData, options);
          } else if (ext === "gltf") {
            const json = JSON.parse(new TextDecoder().decode(fileData));
            result = await importer.importGLTF(json);
          } else {
            return errorResult(`Unsupported format: ${ext}. Use GLB or GLTF.`);
          }

          return jsonResult({
            converted: true,
            path,
            format,
            warnings: result.warnings,
            nodeCount: result.document.nodes?.length ?? 0,
            meshCount: result.document.meshes?.length ?? 0,
          });
        } catch (e) {
          return errorResult(`Failed to convert asset: ${(e as Error).message}`);
        }
      },
    },

    {
      def: {
        name: "list_assets",
        description: "List all loaded assets.",
        inputSchema: {
          type: "object",
          properties: {
            filter: { type: "string", description: "Filter by extension or name substring" },
          },
        },
      },
      handler: (params) => {
        let assets = ctx.assetManager.list();
        const filter = params.filter as string | undefined;
        if (filter) {
          assets = assets.filter((a) => a.includes(filter));
        }
        return jsonResult({ count: assets.length, assets });
      },
    },

    {
      def: {
        name: "validate_project",
        description: "Check for missing assets, broken references, and invalid configurations.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => {
        const issues: string[] = [];

        for (const [entityKey, meshName] of ctx.entityMeshes) {
          if (!ctx.meshes.has(meshName)) {
            issues.push(`Entity ${entityKey} references missing mesh "${meshName}"`);
          }
        }

        for (const [entityKey, materialName] of ctx.entityMaterials) {
          if (!ctx.materialLibrary.get(materialName)) {
            issues.push(`Entity ${entityKey} references missing material "${materialName}"`);
          }
        }

        return jsonResult({
          valid: issues.length === 0,
          issues,
          issueCount: issues.length,
        });
      },
    },

  ];

  return tools;
}
