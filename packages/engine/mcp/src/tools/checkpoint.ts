import type { EngineContext } from "../engine-context";
import type { ToolRegistration } from "../types";
import { jsonResult, errorResult } from "../types";
import type { UndoRedoManager } from "../undo-redo";

export function createCheckpointTools(ctx: EngineContext, undoRedo: UndoRedoManager): ToolRegistration[] {
  const tools: ToolRegistration[] = [

    {
      def: {
        name: "create_checkpoint",
        description: "Snapshot current scene state (entities, components, hierarchy, resources).",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Checkpoint name" },
          },
          required: ["name"],
        },
      },
      handler: (params) => {
        const name = params.name as string;
        if (!name) return errorResult("name is required");

        const cp = ctx.checkpointManager.create(name, ctx.ecsWorld);
        return jsonResult({
          name: cp.name,
          timestamp: cp.timestamp,
          entityCount: cp.entities.length,
        });
      },
    },

    {
      def: {
        name: "restore_checkpoint",
        description: "Roll back to a named checkpoint.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Checkpoint name" },
          },
          required: ["name"],
        },
      },
      handler: (params) => {
        const name = params.name as string;
        const success = ctx.checkpointManager.restore(name, ctx.ecsWorld);
        if (!success) return errorResult(`Checkpoint "${name}" not found`);

        return jsonResult({ restored: true, name });
      },
    },

    {
      def: {
        name: "list_checkpoints",
        description: "List all available checkpoints with timestamps.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => {
        const checkpoints = ctx.checkpointManager.list().map((cp) => ({
          name: cp.name,
          timestamp: cp.timestamp,
          entityCount: cp.entities.length,
        }));
        return jsonResult({ count: checkpoints.length, checkpoints });
      },
    },

    {
      def: {
        name: "diff_checkpoints",
        description: "Structured diff between two checkpoints (added/removed/changed entities).",
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "string", description: "First checkpoint name" },
            b: { type: "string", description: "Second checkpoint name" },
          },
          required: ["a", "b"],
        },
      },
      handler: (params) => {
        const a = params.a as string;
        const b = params.b as string;
        const diff = ctx.checkpointManager.diff(a, b);
        if (!diff) return errorResult(`One or both checkpoints not found: "${a}", "${b}"`);

        return jsonResult({ a, b, ...diff });
      },
    },

  ];

  return tools;
}
