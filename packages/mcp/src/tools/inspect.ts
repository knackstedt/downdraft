import type { EngineContext } from "../engine-context.ts";
import type { ToolRegistration } from "../types.ts";
import { jsonResult, errorResult } from "../types.ts";

export function createInspectTools(ctx: EngineContext): ToolRegistration[] {
  const tools: ToolRegistration[] = [

    {
      def: {
        name: "inspect_object",
        description: "Rich recursive inspection: traverse hierarchy, dump all components + nested values. Supports path queries like 'world/ship_cabin/chest'.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Hierarchy path (e.g. '0.0/5.0/12.0') or entity key (e.g. '5.0')",
            },
            maxDepth: { type: "number", description: "Max traversal depth (default: 10)" },
          },
          required: ["path"],
        },
      },
      handler: (params) => {
        const path = params.path as string;
        const maxDepth = (params.maxDepth as number) ?? 10;

        const parts = path.split("/").filter(Boolean);
        if (parts.length === 0) return errorResult("Empty path");

        let currentEntity = ctx.parseEntityKey(parts[0]);
        if (!currentEntity) return errorResult(`Invalid entity key: ${parts[0]}`);
        if (!ctx.isEntityAlive(currentEntity)) return errorResult(`Entity ${parts[0]} not found or dead`);

        for (let i = 1; i < parts.length; i++) {
          const children = ctx.hierarchy.getChildren(currentEntity);
          const childKey = parts[i];
          const child = children.find((c) => ctx.getEntityKey(c) === childKey);
          if (!child) return errorResult(`Child ${childKey} not found under ${ctx.getEntityKey(currentEntity)}`);
          currentEntity = child;
        }

        return jsonResult(inspectEntityRecursive(ctx, currentEntity, 0, maxDepth));
      },
    },

    {
      def: {
        name: "query_entities",
        description: "Find entities by component type, spatial region, hierarchy path, or property values.",
        inputSchema: {
          type: "object",
          properties: {
            component: { type: "string", description: "Filter by component name" },
            property: {
              type: "object",
              description: "Filter by property value {componentName: {field: value}}",
              properties: {},
            },
            region: {
              type: "object",
              description: "Spatial region filter",
              properties: {
                min: { type: "array", items: { type: "number" } },
                max: { type: "array", items: { type: "number" } },
              },
            },
            limit: { type: "number", description: "Max results (default: 100)" },
          },
        },
      },
      handler: (params) => {
        const limit = (params.limit as number) ?? 100;
        const filterComponent = params.component as string | undefined;
        const filterProperty = params.property as Record<string, Record<string, unknown>> | undefined;
        const filterRegion = params.region as { min: [number, number, number]; max: [number, number, number] } | undefined;

        const filterComponentId = filterComponent ? ctx.getComponentIdByName(filterComponent) : null;
        const allEntities = ctx.getAllAliveEntities();
        const results: Array<Record<string, unknown>> = [];

        for (let i = 0; i < allEntities.length && results.length < limit; i++) {
          const e = allEntities[i];

          if (filterComponentId !== null && !ctx.ecsWorld.hasComponent(e, filterComponentId)) {
            continue;
          }

          if (filterProperty) {
            let matches = true;
            for (const [compName, fields] of Object.entries(filterProperty)) {
              const cid = ctx.getComponentIdByName(compName);
              const data = ctx.ecsWorld.getComponent<Record<string, unknown>>(e, cid);
              if (!data) { matches = false; break; }
              for (const [field, value] of Object.entries(fields)) {
                if (data[field] !== value) { matches = false; break; }
              }
              if (!matches) break;
            }
            if (!matches) continue;
          }

          if (filterRegion) {
            const transformCid = ctx.getComponentIdByName("Transform");
            const transform = ctx.ecsWorld.getComponent<{ pos: [number, number, number] }>(e, transformCid);
            if (transform) {
              const [x, y, z] = transform.pos;
              const [minX, minY, minZ] = filterRegion.min;
              const [maxX, maxY, maxZ] = filterRegion.max;
              if (x < minX || x > maxX || y < minY || y > maxY || z < minZ || z > maxZ) {
                continue;
              }
            }
          }

          const arch = ctx.ecsWorld.getArchetypeForEntity(e);
          const compNames = arch ? [...arch.columns.keys()].map((id) => ctx.getComponentNameById(id)) : [];
          results.push({
            entity: ctx.getEntityKey(e),
            components: compNames,
          });
        }

        return jsonResult({ count: results.length, entities: results });
      },
    },

    {
      def: {
        name: "get_scene_tree",
        description: "Get the full scene hierarchy as a tree structure.",
        inputSchema: {
          type: "object",
          properties: {
            root: { type: "string", description: "Root entity key (default: '0.0' = world root)" },
            maxDepth: { type: "number", description: "Max depth (default: 20)" },
          },
        },
      },
      handler: (params) => {
        const rootKey = (params.root as string) ?? "0.0";
        const root = ctx.parseEntityKey(rootKey);
        if (!root) return errorResult(`Invalid root key: ${rootKey}`);

        const maxDepth = (params.maxDepth as number) ?? 20;
        const tree = buildSceneTree(ctx, root, 0, maxDepth);
        return jsonResult(tree);
      },
    },

  ];

  return tools;
}

function inspectEntityRecursive(ctx: EngineContext, entity: import("@downdraft/core").Entity, depth: number, maxDepth: number): Record<string, unknown> {
  const entityKey = ctx.getEntityKey(entity);
  const arch = ctx.ecsWorld.getArchetypeForEntity(entity);

  const components: Record<string, unknown> = {};
  if (arch) {
    for (const [cid, col] of arch.columns) {
      const row = arch.entities.findIndex(
        (e) => e.index === entity.index && e.generation === entity.generation,
      );
      if (row >= 0) {
        components[ctx.getComponentNameById(cid)] = col[row];
      }
    }
  }

  const children = ctx.hierarchy.getChildren(entity);
  const childResults: Record<string, unknown>[] = [];

  if (depth < maxDepth) {
    for (let i = 0; i < children.length; i++) {
      childResults.push(inspectEntityRecursive(ctx, children[i], depth + 1, maxDepth));
    }
  }

  return {
    entity: entityKey,
    depth,
    components,
    childCount: children.length,
    children: childResults,
  };
}

function buildSceneTree(ctx: EngineContext, entity: import("@downdraft/core").Entity, depth: number, maxDepth: number): Record<string, unknown> {
  const entityKey = ctx.getEntityKey(entity);
  const arch = ctx.ecsWorld.getArchetypeForEntity(entity);
  const compNames = arch ? [...arch.columns.keys()].map((id) => ctx.getComponentNameById(id)) : [];

  const children = ctx.hierarchy.getChildren(entity);
  const childNodes: Record<string, unknown>[] = [];

  if (depth < maxDepth) {
    for (let i = 0; i < children.length; i++) {
      childNodes.push(buildSceneTree(ctx, children[i], depth + 1, maxDepth));
    }
  }

  return {
    entity: entityKey,
    components: compNames,
    children: childNodes,
  };
}
