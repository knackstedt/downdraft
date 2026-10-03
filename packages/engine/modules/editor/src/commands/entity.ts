// ============================================================================
// Entity commands — spawn / remove / restore / duplicate / rename.
//
// Inverses are plain invocations: `entity.remove` captures a full snapshot
// (components, name, parent, children) and its inverse is `entity.restore`.
// Restored entities get NEW entity keys — `restore` reports the new key in
// its result so the journal stays truthful, and `hierarchy.setParent`
// inverses re-parent surviving children onto the restored entity.
// ============================================================================

import { getColumnValue, sanitizeObject, type Entity } from "@downdraft/engine";

import type { EditorContext } from "../editor-context";
import type { CommandInvocation, EditorCommand } from "./registry";

interface EntitySnapshot {
  /** The entity key at snapshot time — registered as an alias on restore so
   *  stale references (redo params, child re-parents) resolve to the new key. */
  key: string;
  name?: string;
  parent: string | null;
  components: Record<string, Record<string, unknown>>;
  children: string[];
}

function snapshotEntity(ctx: EditorContext, entity: Entity): EntitySnapshot {
  const { world } = ctx.document;
  const components: Record<string, Record<string, unknown>> = {};
  const arch = world.getArchetypeForEntity(entity);
  if (arch) {
    const row = arch.entities.findIndex(
      (e) => e.index === entity.index && e.generation === entity.generation,
    );
    if (row >= 0) {
      for (const [cid, col] of arch.columns.entries()) {
        const data = getColumnValue(col, row);
        if (data !== undefined && data !== null) {
          components[ctx.engine.getComponentNameById(cid)] = sanitizeObject({ ...data }) as Record<string, unknown>;
        }
      }
    }
  }
  const parent = ctx.engine.hierarchy.getParent(entity);
  const key = ctx.key(entity);
  return {
    key,
    name: ctx.document.entityName(key),
    parent: parent ? ctx.key(parent) : null,
    components,
    children: ctx.engine.hierarchy.getChildren(entity).map((c) => ctx.key(c)),
  };
}

/** Spawn from a component-name map. Shared by spawn/restore. */
function spawnWithComponents(
  ctx: EditorContext,
  components: Record<string, Record<string, unknown>>,
): Entity {
  const map = new Map<number, unknown>();
  for (const [name, data] of Object.entries(components)) {
    map.set(ctx.engine.getComponentIdByName(name), sanitizeObject({ ...data }));
  }
  const entity = ctx.engine.ecsWorld.spawn(map);
  ctx.engine.scene.trackEntity(entity);
  ctx.engine.ecsWorld.flushCommands();
  return entity;
}

export function createEntityCommands(): EditorCommand[] {
  return [
    {
      id: "entity.spawn",
      title: "Spawn Entity",
      mutating: true,
      params: {
        type: "object",
        properties: {
          name: { type: "string", description: "Display name" },
          components: { type: "object", description: "Component name → data" },
          parent: { type: "string", description: "Parent entity key" },
          position: { type: "array", items: { type: "number" }, description: "Shorthand for transform.position" },
        },
      },
      apply(ctx, params) {
        const components = (params.components ?? {}) as Record<string, Record<string, unknown>>;
        // `position` shorthand merges into the transform component.
        const position = params.position as number[] | undefined;
        if (position) {
          components["transform"] = { ...components["transform"], position: [...position] };
        }
        const entity = spawnWithComponents(ctx, components);
        const key = ctx.key(entity);

        const name = params.name as string | undefined;
        if (name) ctx.document.setEntityName(key, name);

        const parentKey = params.parent as string | undefined;
        const parent = parentKey ? ctx.parseEntity(parentKey) : null;
        if (parent) ctx.engine.hierarchy.setParent(entity, parent);

        ctx.document.markDirty({ kind: "structure", entity: key });
        ctx.adapter?.syncEntity?.(key);

        return {
          value: { entity: key, components: Object.keys(components) },
          inverse: [{ command: "entity.remove", params: { entity: key } }],
          description: `Spawn entity${name ? ` "${name}"` : ""} (${key})`,
        };
      },
    },

    {
      id: "entity.remove",
      title: "Remove Entity",
      mutating: true,
      params: {
        type: "object",
        properties: {
          entity: { type: "string", description: "Entity key" },
        },
        required: ["entity"],
      },
      apply(ctx, params) {
        const key = params.entity as string;
        const entity = ctx.parseEntity(key);
        if (!entity || !ctx.isAliveKey(key)) {
          throw new Error(`Entity ${key} not found or already dead`);
        }
        const snap = snapshotEntity(ctx, entity);

        ctx.engine.ecsWorld.despawn(entity);
        ctx.engine.ecsWorld.flushCommands();
        ctx.engine.scene.removeEntity(entity);
        ctx.document.setEntityName(key, undefined);
        ctx.selection.remove(key);

        ctx.document.markDirty({ kind: "structure", entity: key });
        ctx.adapter?.removeEntity?.(key);

        // Restore puts the entity back; surviving children re-parent to the
        // restored key (entity.restore returns it — the child's setParent
        // inverse is resolved at undo time against the restore result).
        const inverse: CommandInvocation[] = [
          { command: "entity.restore", params: { snapshot: snap, parent: snap.parent } },
        ];
        snap.children.forEach((childKey) => {
          if (ctx.isAliveKey(childKey)) {
            inverse.push({ command: "hierarchy.setParentToRestore", params: { child: childKey } });
          }
        });

        return {
          value: { removed: true, entity: key },
          inverse,
          description: `Remove entity ${snap.name ?? key}`,
        };
      },
    },

    {
      id: "entity.restore",
      title: "Restore Entity",
      mutating: true,
      params: {
        type: "object",
        properties: {
          snapshot: { type: "object", description: "Captured entity snapshot" },
          parent: { type: "string", description: "Parent entity key (resolves to latest restore)" },
        },
        required: ["snapshot"],
      },
      apply(ctx, params) {
        const snap = params.snapshot as EntitySnapshot;
        const entity = spawnWithComponents(ctx, snap.components);
        const key = ctx.key(entity);
        if (snap.name) ctx.document.setEntityName(key, snap.name);

        // `parent` may be a stale key (if the parent was itself restored in
        // the same undo batch, the caller passes the restored key instead).
        const parentKey = (params.parent as string | null) ?? snap.parent;
        const parent = parentKey ? ctx.parseEntity(parentKey) : null;
        if (parent && ctx.isAliveKey(ctx.key(parent))) {
          ctx.engine.hierarchy.setParent(entity, parent);
        }

        ctx.document.markDirty({ kind: "structure", entity: key });
        ctx.adapter?.syncEntity?.(key);

        // Alias the snapshotted (stale) key to the new one — redo of the
        // original remove, and any journaled params carrying the old key,
        // resolve through it. Also stash for `hierarchy.setParentToRestore`.
        if (snap.key) ctx.registerKeyAlias(snap.key, key);
        ctx.lastRestoredKey = key;

        return {
          value: { entity: key },
          inverse: [{ command: "entity.remove", params: { entity: key } }],
          description: `Restore entity${snap.name ? ` "${snap.name}"` : ""}`,
        };
      },
    },

    {
      id: "entity.duplicate",
      title: "Duplicate Entity",
      mutating: true,
      params: {
        type: "object",
        properties: { entity: { type: "string" } },
        required: ["entity"],
      },
      apply(ctx, params) {
        const key = params.entity as string;
        const entity = ctx.parseEntity(key);
        if (!entity || !ctx.isAliveKey(key)) {
          throw new Error(`Entity ${key} not found or dead`);
        }
        const snap = snapshotEntity(ctx, entity);
        const clone = spawnWithComponents(ctx, snap.components);
        const cloneKey = ctx.key(clone);
        const origName = ctx.document.entityName(key);
        if (origName) ctx.document.setEntityName(cloneKey, `${origName} (copy)`);
        const parent = snap.parent ? ctx.parseEntity(snap.parent) : null;
        if (parent) ctx.engine.hierarchy.setParent(clone, parent);

        ctx.document.markDirty({ kind: "structure", entity: cloneKey });
        ctx.adapter?.syncEntity?.(cloneKey);

        return {
          value: { entity: cloneKey },
          inverse: [{ command: "entity.remove", params: { entity: cloneKey } }],
          description: `Duplicate entity ${origName ?? key}`,
        };
      },
    },

    {
      id: "entity.rename",
      title: "Rename Entity",
      mutating: true,
      params: {
        type: "object",
        properties: {
          entity: { type: "string" },
          name: { type: "string" },
        },
        required: ["entity", "name"],
      },
      apply(ctx, params) {
        const key = params.entity as string;
        if (!ctx.isAliveKey(key)) throw new Error(`Entity ${key} not found or dead`);
        const name = params.name as string;
        const oldName = ctx.document.entityName(key);
        ctx.document.setEntityName(key, name);
        ctx.document.markDirty({ kind: "meta", entity: key });
        return {
          value: { entity: key, name },
          inverse: oldName !== undefined
            ? [{ command: "entity.rename", params: { entity: key, name: oldName } }]
            : [{ command: "entity.rename", params: { entity: key, name: `Entity ${key}` } }],
          description: `Rename ${oldName ?? key} → "${name}"`,
        };
      },
    },

    {
      id: "entity.list",
      title: "List Entities",
      mutating: false,
      apply(ctx) {
        const out = ctx.document.entities().map((e) => {
          const key = ctx.key(e);
          const parent = ctx.engine.hierarchy.getParent(e);
          const arch = ctx.engine.ecsWorld.getArchetypeForEntity(e);
          const comps = arch ? [...arch.columns.keys()].map((id) => ctx.engine.getComponentNameById(id)) : [];
          return {
            key,
            name: ctx.document.entityName(key) ?? null,
            parent: parent ? ctx.key(parent) : null,
            components: comps,
          };
        });
        return { value: { count: out.length, entities: out } };
      },
    },
  ];
}
