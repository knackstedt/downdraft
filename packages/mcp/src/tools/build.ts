import type { EngineContext } from "../engine-context.ts";
import type { ToolRegistration } from "../types.ts";
import { jsonResult, errorResult } from "../types.ts";

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
