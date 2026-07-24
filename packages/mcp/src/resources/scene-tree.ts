import type { EngineContext } from "../engine-context.ts";
import type { MCPResourceResult, ResourceRegistration } from "../types.ts";

function resourceJSON(uri: string, data: unknown): MCPResourceResult {
  return {
    contents: [{
      uri,
      mimeType: "application/json",
      text: JSON.stringify(data, null, 2),
    }],
  };
}

export function createSceneTreeResource(ctx: EngineContext): ResourceRegistration[] {
  return [
    {
      def: {
        uri: "downdraft://scene-tree",
        name: "Scene Tree",
        description: "Live scene hierarchy (parent/child tree)",
        mimeType: "application/json",
      },
      handler: (uri) => {
        const entities = ctx.getAllAliveEntities();
        const tree: Array<{ entity: string; parent: string; children: string[]; components: string[] }> = [];

        for (const e of entities) {
          const arch = ctx.ecsWorld.getArchetypeForEntity(e);
          const compNames = arch ? [...arch.columns.keys()].map((id) => ctx.getComponentNameById(id)) : [];
          const parent = ctx.hierarchy.getParent(e);
          tree.push({
            entity: ctx.getEntityKey(e),
            parent: parent ? ctx.getEntityKey(parent) : "root",
            children: ctx.hierarchy.getChildren(e).map((c) => ctx.getEntityKey(c)),
            components: compNames,
          });
        }

        return resourceJSON(uri, { scene: ctx.scene.name, entities: tree });
      },
    },
  ];
}
