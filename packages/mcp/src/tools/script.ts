import { confinePath } from "@downdraft/core";
import type { EngineContext } from "../engine-context";
import type { ToolRegistration } from "../types";
import { errorResult, jsonResult } from "../types";

/** Base directory used for path confinement. Falls back to cwd. */
const GAME_ROOT = process.cwd();

/** Strip absolute filesystem paths from error messages to avoid leaking implementation details. */
function sanitizeErrorMessage(msg: string): string {
  return msg.replace(GAME_ROOT, "<game-root>").replace(/\/[^\s"']+/g, (match) => {
    if (match.startsWith("/<game-root>")) return match;
    return "<path>";
  });
}

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
        if (name.includes("..")) return errorResult("Script name must not contain '..'");

        const path = `scripts/${name}.ts`;
        try {
          const safePath = confinePath(GAME_ROOT, path);
          const { promises: fs } = await import("node:fs");
          await fs.writeFile(safePath, code);
          return jsonResult({ created: true, name, path });
        } catch (e) {
          return errorResult(`Failed to write script: ${sanitizeErrorMessage((e as Error).message)}`);
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
          const safePath = confinePath(GAME_ROOT, path);
          await ctx.scriptingSystem.load(name, safePath);
          return jsonResult({ attached: true, name, path: safePath });
        } catch (e) {
          return errorResult(`Failed to attach script: ${sanitizeErrorMessage((e as Error).message)}`);
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
          const safePath = confinePath(GAME_ROOT, path);
          await ctx.scriptingSystem.hotReload(name, safePath);
          return jsonResult({ hotReloaded: true, name, path: safePath });
        } catch (e) {
          return errorResult(`Failed to hot-reload script: ${sanitizeErrorMessage((e as Error).message)}`);
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
