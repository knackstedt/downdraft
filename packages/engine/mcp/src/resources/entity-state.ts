import { getColumnValue } from "@downdraft/engine";
import type { EngineContext } from "../engine-context";
import type { MCPResourceResult, ResourceRegistration } from "../types";

function resourceJSON(uri: string, data: unknown): MCPResourceResult {
  return {
    contents: [{
      uri,
      mimeType: "application/json",
      text: JSON.stringify(data, null, 2),
    }],
  };
}

export function createEntityStateResource(ctx: EngineContext): ResourceRegistration[] {
  return [
    {
      def: {
        uri: "downdraft://entity-state",
        name: "Entity State",
        description: "Entity component dump (all entities, all components)",
        mimeType: "application/json",
      },
      handler: (uri) => {
        const entities = ctx.getAllAliveEntities();
        const dump: Record<string, unknown> = {};

        for (const e of entities) {
          const key = ctx.getEntityKey(e);
          const arch = ctx.ecsWorld.getArchetypeForEntity(e);
          const components: Record<string, unknown> = {};

          if (arch) {
            for (const [cid, col] of arch.columns) {
              const row = arch.entities.findIndex(
                (en) => en.index === e.index && en.generation === e.generation,
              );
              if (row >= 0) {
                components[ctx.getComponentNameById(cid)] = getColumnValue(col, row);
              }
            }
          }

          dump[key] = {
            components,
            mesh: ctx.entityMeshes.get(key) ?? null,
            material: ctx.entityMaterials.get(key) ?? null,
          };
        }

        return resourceJSON(uri, dump);
      },
    },
  ];
}
