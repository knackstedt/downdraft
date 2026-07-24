import type { EngineContext } from "../engine-context.ts";
import type { ToolRegistration } from "../types.ts";
import { jsonResult, errorResult } from "../types.ts";

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
