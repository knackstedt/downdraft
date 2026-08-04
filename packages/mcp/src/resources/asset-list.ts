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

export function createAssetListResource(ctx: EngineContext): ResourceRegistration[] {
  return [
    {
      def: {
        uri: "downdraft://asset-list",
        name: "Asset Inventory",
        description: "All loaded assets",
        mimeType: "application/json",
      },
      handler: (uri) => {
        return resourceJSON(uri, {
          assets: ctx.assetManager.list(),
          meshes: [...ctx.meshes.keys()],
          materials: ctx.materialLibrary.list().map((m) => m.name),
        });
      },
    },
  ];
}
