import type { Plugin } from "@downdraft/core";

export const NetworkingPlugin: Plugin = {
  name: "networking",
  version: "0.1.0",
  register(ctx) {
    ctx.registerResource("networkConfig", {
      transport: "websocket",
      tickRate: 20,
    });
    ctx.onDispose(() => {
      console.log("[networking] disposed");
    });
  },
};
