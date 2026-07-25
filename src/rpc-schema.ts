import { type RPCSchema } from "electrobun";

export type DownDraftRPC = RPCSchema<{
  bun: {
    requests: {
      getTelemetry: {
        params: void;
        response: {
          frameTime: number;
          p95: number;
          p99: number;
        };
      };
      getEntityCount: {
        params: void;
        response: number;
      };
    };
    messages: {};
  };
  webview: {
    requests: {};
    messages: {
      input: {
        keys: number[];
        mouseX: number;
        mouseY: number;
        mouseDeltaX: number;
        mouseDeltaY: number;
        mouseButtons: number[];
        wheelDelta: number;
      };
    };
  };
}>;
