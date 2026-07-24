import type { EngineContext } from "../engine-context.ts";
import type { ResourceRegistration, MCPResourceResult } from "../types.ts";

function resourceJSON(uri: string, data: unknown): MCPResourceResult {
  return {
    contents: [{
      uri,
      mimeType: "application/json",
      text: JSON.stringify(data, null, 2),
    }],
  };
}

export function createGPUInfoResource(ctx: EngineContext): ResourceRegistration[] {
  return [
    {
      def: {
        uri: "downdraft://gpu-info",
        name: "GPU Info",
        description: "Adapter info, buffer sizes, texture memory",
        mimeType: "application/json",
      },
      handler: (uri) => {
        return resourceJSON(uri, {
          adapter: "WGPU adapter info requires running render loop",
          buffers: { totalSize: 0, count: 0 },
          textures: { totalSize: 0, count: 0 },
          meshes: ctx.meshes.size,
          materials: ctx.materialLibrary.list().length,
        });
      },
    },
  ];
}
