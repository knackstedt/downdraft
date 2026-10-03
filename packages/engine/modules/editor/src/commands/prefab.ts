// ============================================================================
// Prefab commands — capture an entity subtree as a reusable Prefab and
// instantiate prefabs into the document. Backed by the existing
// PrefabRegistry/PrefabFactory on the EngineContext's GameWorld.
// ============================================================================

import { getColumnValue, sanitizeObject, type Entity, type Prefab } from "@downdraft/engine";

import type { EditorContext } from "../editor-context";
import type { EditorCommand } from "./registry";

function entityToPrefab(ctx: EditorContext, entity: Entity, name: string): Prefab {
  const arch = ctx.engine.ecsWorld.getArchetypeForEntity(entity);
  const components: Prefab["components"] = [];
  if (arch) {
    const row = arch.entities.findIndex((e) => e.index === entity.index && e.generation === entity.generation);
    if (row >= 0) {
      for (const [cid, col] of arch.columns.entries()) {
        const data = getColumnValue(col, row);
        components.push({ componentId: cid, data: sanitizeObject(data) as Record<string, unknown> });
      }
    }
  }

  const children = ctx.engine.hierarchy.getChildren(entity).map((child) => {
    const childArch = ctx.engine.ecsWorld.getArchetypeForEntity(child);
    const childComps: Prefab["components"] = [];
    if (childArch) {
      const row = childArch.entities.findIndex((e) => e.index === child.index && e.generation === child.generation);
      if (row >= 0) {
        for (const [cid, col] of childArch.columns.entries()) {
          const data = getColumnValue(col, row);
          childComps.push({ componentId: cid, data: sanitizeObject(data) as Record<string, unknown> });
        }
      }
    }
    // Flatten child components into a PrefabChildEntry — prefab names are
    // resolved against the registry at spawn time.
    return { prefab: "", components: childComps };
  });

  return { name, components, children };
}

export function createPrefabCommands(): EditorCommand[] {
  return [
    {
      id: "prefab.create",
      title: "Create Prefab",
      mutating: true,
      params: {
        type: "object",
        properties: {
          entity: { type: "string", description: "Root entity to capture" },
          name: { type: "string", description: "Prefab name" },
        },
        required: ["entity", "name"],
      },
      apply(ctx, params) {
        const key = params.entity as string;
        const entity = ctx.parseEntity(key);
        if (!entity || !ctx.isAliveKey(key)) throw new Error(`Entity ${key} not found or dead`);
        const name = params.name as string;

        const existed = ctx.engine.world.prefabRegistry.has(name);
        const prior = existed ? ctx.engine.world.prefabRegistry.get(name)! : null;

        const prefab = entityToPrefab(ctx, entity, name);
        ctx.engine.world.prefabRegistry.register(prefab);
        ctx.document.markDirty({ kind: "meta", entity: key });

        return {
          value: { prefab: name, components: prefab.components.length, children: prefab.children?.length ?? 0 },
          inverse: [{ command: prior ? "prefab.restore" : "prefab.unregister", params: prior ? { prefab: prior } : { name } }],
          description: `Create prefab "${name}"`,
        };
      },
    },

    {
      id: "prefab.instantiate",
      title: "Instantiate Prefab",
      mutating: true,
      params: {
        type: "object",
        properties: {
          prefab: { type: "string" },
          parent: { type: "string" },
          name: { type: "string", description: "Display name for the instance" },
        },
        required: ["prefab"],
      },
      apply(ctx, params) {
        const name = params.prefab as string;
        const parentKey = params.parent as string | undefined;
        const parent = parentKey ? ctx.parseEntity(parentKey) : undefined;
        const entity = ctx.engine.world.prefabFactory.spawn(name, parent ?? undefined);
        ctx.engine.ecsWorld.flushCommands();
        ctx.engine.scene.trackEntity(entity);
        const key = ctx.key(entity);
        const displayName = params.name as string | undefined;
        ctx.document.setEntityName(key, displayName ?? name);
        ctx.document.markDirty({ kind: "structure", entity: key });
        ctx.adapter?.syncEntity?.(key);
        return {
          value: { entity: key, prefab: name },
          inverse: [{ command: "entity.remove", params: { entity: key } }],
          description: `Instantiate prefab "${name}"`,
        };
      },
    },

    {
      id: "prefab.unregister",
      title: "Unregister Prefab",
      mutating: true,
      params: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      apply(ctx, params) {
        const name = params.name as string;
        const prior = ctx.engine.world.prefabRegistry.get(name) ?? null;
        ctx.engine.world.prefabRegistry.unregister(name);
        return {
          value: { unregistered: name },
          inverse: prior ? [{ command: "prefab.restore", params: { prefab: prior } }] : undefined,
          description: `Unregister prefab "${name}"`,
        };
      },
    },

    {
      id: "prefab.restore",
      title: "Restore Prefab",
      mutating: true,
      params: {
        type: "object",
        properties: { prefab: { type: "object" } },
        required: ["prefab"],
      },
      apply(ctx, params) {
        const prefab = params.prefab as Prefab;
        ctx.engine.world.prefabRegistry.register(prefab);
        return {
          value: { prefab: prefab.name },
          inverse: [{ command: "prefab.unregister", params: { name: prefab.name } }],
          description: `Restore prefab "${prefab.name}"`,
        };
      },
    },

    {
      id: "prefab.list",
      title: "List Prefabs",
      mutating: false,
      apply(ctx) {
        return { value: { prefabs: ctx.engine.world.prefabRegistry.list() } };
      },
    },
  ];
}
