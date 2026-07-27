import type { EngineContext } from "../engine-context.ts";
import type { ToolRegistration } from "../types.ts";
import { jsonResult, errorResult } from "../types.ts";
import { promises as fs } from "node:fs";

export function createScriptTools(ctx: EngineContext): ToolRegistration[] {
  const tools: ToolRegistration[] = [

    {
      def: {
        name: "create_script",
        description: "Create a TypeScript game logic script file.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Script name" },
            code: { type: "string", description: "TypeScript source code" },
          },
          required: ["name", "code"],
        },
      },
      handler: async (params) => {
        const name = params.name as string;
        const code = params.code as string;
        if (!name || !code) return errorResult("name and code are required");

        const path = `scripts/${name}.ts`;
        try {
          await fs.writeFile(path, code);
          return jsonResult({ created: true, name, path });
        } catch (e) {
          return errorResult(`Failed to write script: ${(e as Error).message}`);
        }
      },
    },

    {
      def: {
        name: "attach_script",
        description: "Attach (load) a script to the running game.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Script name" },
            path: { type: "string", description: "Script file path (default: scripts/{name}.ts)" },
          },
          required: ["name"],
        },
      },
      handler: async (params) => {
        const name = params.name as string;
        const path = (params.path as string) ?? `scripts/${name}.ts`;

        try {
          await ctx.scriptingSystem.load(name, path);
          return jsonResult({ attached: true, name, path });
        } catch (e) {
          return errorResult(`Failed to attach script: ${(e as Error).message}`);
        }
      },
    },

    {
      def: {
        name: "hot_reload_script",
        description: "Hot-reload a script (dispose old, load new).",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Script name" },
            path: { type: "string", description: "Script file path" },
          },
          required: ["name"],
        },
      },
      handler: async (params) => {
        const name = params.name as string;
        const path = (params.path as string) ?? `scripts/${name}.ts`;

        try {
          await ctx.scriptingSystem.hotReload(name, path);
          return jsonResult({ hotReloaded: true, name, path });
        } catch (e) {
          return errorResult(`Failed to hot-reload script: ${(e as Error).message}`);
        }
      },
    },

    {
      def: {
        name: "list_scripts",
        description: "List all loaded scripts.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => {
        return jsonResult({ scripts: ctx.scriptingSystem.getScriptNames() });
      },
    },

  ];

  return tools;
}
