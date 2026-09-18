import type { EngineContext } from "../engine-context";
import type { ResourceRegistration, MCPResourceResult } from "../types";
import { createSceneTreeResource } from "./scene-tree";
import { createEntityStateResource } from "./entity-state";
import { createPerformanceResource } from "./performance";
import { createGPUInfoResource } from "./gpu-info";
import { createAssetListResource } from "./asset-list";
import { createCheckpointListResource } from "./checkpoint-list";

function resourceJSON(uri: string, data: unknown): MCPResourceResult {
  return {
    contents: [{
      uri,
      mimeType: "application/json",
      text: JSON.stringify(data, null, 2),
    }],
  };
}

export function createResources(ctx: EngineContext): ResourceRegistration[] {
  return [
    ...createSceneTreeResource(ctx),
    ...createEntityStateResource(ctx),
    ...createPerformanceResource(ctx),
    ...createGPUInfoResource(ctx),
    ...createAssetListResource(ctx),
    ...createCheckpointListResource(ctx),

    {
      def: {
        uri: "downdraft://crash-events",
        name: "Crash Events",
        description: "Sim-worker crash events and recovery status",
        mimeType: "application/json",
      },
      handler: (uri) => {
        return resourceJSON(uri, {
          crashes: [],
          recoveryState: "idle",
          note: "No crash events recorded. Crash recovery requires a running sim worker.",
        });
      },
    },

    {
      def: {
        uri: "downdraft://telemetry",
        name: "Telemetry",
        description: "Per-thread GC, memory, CPU metrics",
        mimeType: "application/json",
      },
      handler: (uri) => {
        return resourceJSON(uri, ctx.telemetryReporter.getMCPFormat());
      },
    },
  ];
}
