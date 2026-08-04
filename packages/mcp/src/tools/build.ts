import type { EngineContext } from "../engine-context";
import type { ToolRegistration } from "../types";
import { jsonResult, errorResult } from "../types";

export function createBuildTools(ctx: EngineContext): ToolRegistration[] {
  const tools: ToolRegistration[] = [

    {
      def: {
        name: "build_game",
        description: "Package the game for a target platform.",
        inputSchema: {
          type: "object",
          properties: {
            target: {
              type: "string",
              enum: ["win", "mac", "linux"],
              description: "Build target platform",
            },
            output: { type: "string", description: "Output directory" },
            mode: {
              type: "string",
              enum: ["dev", "debug", "prod"],
              description: "Build mode (default: prod)",
            },
          },
          required: ["target"],
        },
      },
      handler: (params) => {
        const target = params.target as string;
        const mode = (params.mode as string) ?? "prod";
        const output = (params.output as string) ?? `dist/${target}`;

        return jsonResult({
          note: "Build system requires the CLI tool. Run 'draft build' from the project root.",
          target,
          mode,
          output,
        });
      },
    },

    {
      def: {
        name: "validate_build",
        description: "Validate that the project is ready for building (assets, scripts, scene integrity).",
        inputSchema: {
          type: "object",
          properties: {
            target: {
              type: "string",
              enum: ["win", "mac", "linux"],
              description: "Build target to validate against (default: linux)",
            },
          },
        },
      },
      handler: (params) => {
        const target = (params.target as string) ?? "linux";
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

        if (ctx.lights.length === 0) {
          issues.push("No lights in scene — build will produce a dark scene");
        }

        const scripts = ctx.scriptingSystem.getScriptNames();
        if (scripts.length === 0) {
          issues.push("No scripts loaded — game will have no logic");
        }

        const entityCount = ctx.ecsWorld.entityCount();
        if (entityCount <= 1) {
          issues.push("Scene is empty (only root entity)");
        }

        return jsonResult({
          target,
          valid: issues.length === 0,
          issues,
          issueCount: issues.length,
          stats: {
            entities: entityCount,
            meshes: ctx.meshes.size,
            materials: ctx.materialLibrary.list().length,
            lights: ctx.lights.length,
            scripts: scripts.length,
          },
        });
      },
    },

    {
      def: {
        name: "export_scene",
        description: "Export the current scene to a file.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Output file path" },
          },
          required: ["path"],
        },
      },
      handler: async (params) => {
        const path = params.path as string;
        try {
          await ctx.saveSystem.saveToFile(ctx.ecsWorld, ctx.scene.name, path);
          return jsonResult({ exported: true, path, scene: ctx.scene.name });
        } catch (e) {
          return errorResult(`Failed to export: ${(e as Error).message}`);
        }
      },
    },

  ];

  return tools;
}
