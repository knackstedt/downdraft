import type { EngineContext } from "../engine-context";
import type { ResourceRegistration, MCPResourceResult } from "../types";

function resourceJSON(uri: string, data: unknown): MCPResourceResult {
  return {
    contents: [{
      uri,
      mimeType: "application/json",
      text: JSON.stringify(data, null, 2),
    }],
  };
}

export function createCheckpointListResource(ctx: EngineContext): ResourceRegistration[] {
  return [
    {
      def: {
        uri: "downdraft://checkpoint-list",
        name: "Checkpoint List",
        description: "Available checkpoints + undo/redo history",
        mimeType: "application/json",
      },
      handler: (uri) => {
        const checkpoints = ctx.checkpointManager.list().map((cp) => ({
          name: cp.name,
          timestamp: cp.timestamp,
          entityCount: cp.entities.length,
        }));
        return resourceJSON(uri, { checkpoints });
      },
    },
  ];
}
