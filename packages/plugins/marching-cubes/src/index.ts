import type { Plugin } from "@downdraft/core";

export const MarchingCubesPlugin: Plugin = {
  name: "marching-cubes",
  version: "0.1.0",
  register(ctx) {
    ctx.registerResource("terrainConfig", {
      chunkSize: 64,
      isoLevel: 0.5,
      maxHeight: 20,
    });
    ctx.onDispose(() => {
      console.log("[marching-cubes] disposed");
    });
  },
};
