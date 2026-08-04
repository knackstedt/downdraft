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

export function createPerformanceResource(ctx: EngineContext): ResourceRegistration[] {
  return [
    {
      def: {
        uri: "downdraft://performance",
        name: "Performance Metrics",
        description: "Frame timings, system timings, and entity count",
        mimeType: "application/json",
      },
      handler: (uri) => {
        const snap = ctx.telemetryReporter.getSnapshot();
        return resourceJSON(uri, {
          tick: ctx.ecsWorld.tick,
          entityCount: ctx.ecsWorld.entityCount(),
          frameTime: snap.averageFrameTime,
          p95FrameTime: snap.p95FrameTime,
          p99FrameTime: snap.p99FrameTime,
          systemTimings: snap.systemTimings,
          frameTimeHistory: snap.frameTimes,
        });
      },
    },
  ];
}
