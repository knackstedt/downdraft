import type { Plugin } from "@downdraft/core";

export const WaterPlugin: Plugin = {
  name: "water",
  version: "0.1.0",
  register(ctx) {
    ctx.registerResource("waterConfig", {
      waveHeight: 0.5,
      waveLength: 10,
      deepColor: [0.1, 0.2, 0.4, 1],
      shallowColor: [0.3, 0.6, 0.8, 1],
    });
    ctx.onDispose(() => {
      console.log("[water] disposed");
    });
  },
};
