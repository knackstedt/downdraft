// ============================================================================
// Component commands — add / set (merge-patch) / remove / inspect.
//
// `component.set` merges `changes` into existing data and inverses with the
// captured old data — the workhorse behind inspector edits and gizmo drags.
// ============================================================================

import { sanitizeObject } from "@downdraft/engine";

import type { EditorContext } from "../editor-context";
import type { EditorCommand } from "./registry";

function readComponent(ctx: EditorContext, entityKey: string, componentName: string): Record<string, unknown> | null {
  const entity = ctx.parseEntity(entityKey);
  if (!entity) return null;
  const cid = ctx.engine.getComponentIdByName(componentName);
  const data = ctx.engine.ecsWorld.getComponent<Record<string, unknown>>(entity, cid);
  return data ? (sanitizeObject({ ...data }) as Record<string, unknown>) : null;
}

export function createComponentCommands(): EditorCommand[] {
  return [
    {
      id: "component.add",
      title: "Add Component",
      mutating: true,
      params: {
        type: "object",
        properties: {
          entity: { type: "string" },
          component: { type: "string" },
          data: { type: "object", description: "Initial component data" },
        },
        required: ["entity", "component"],
      },
      apply(ctx, params) {
        const key = params.entity as string;
        const entity = ctx.parseEntity(key);
        if (!entity || !ctx.isAliveKey(key)) throw new Error(`Entity ${key} not found or dead`);
        const name = params.component as string;
        const cid = ctx.engine.getComponentIdByName(name);
        if (ctx.engine.ecsWorld.hasComponent(entity, cid)) {
          throw new Error(`Entity ${key} already has component "${name}"`);
        }
        const data = sanitizeObject({ ...(params.data as Record<string, unknown> | undefined) });
        ctx.engine.ecsWorld.addComponent(entity, cid, data);
        ctx.engine.ecsWorld.flushCommands();
        ctx.document.markDirty({ kind: "data", entity: key });
        ctx.adapter?.syncEntity?.(key);
        return {
          value: { entity: key, component: name },
          inverse: [{ command: "component.remove", params: { entity: key, component: name } }],
          description: `Add ${name} to ${key}`,
        };
      },
    },

    {
      id: "component.set",
      title: "Set Component Data",
      mutating: true,
      params: {
        type: "object",
        properties: {
          entity: { type: "string" },
          component: { type: "string" },
          changes: { type: "object", description: "Partial data merged into the component" },
        },
        required: ["entity", "component", "changes"],
      },
      apply(ctx, params) {
        const key = params.entity as string;
        const name = params.component as string;
        const entity = ctx.parseEntity(key);
        if (!entity || !ctx.isAliveKey(key)) throw new Error(`Entity ${key} not found or dead`);

        const oldData = readComponent(ctx, key, name);
        if (oldData === null) throw new Error(`Entity ${key} has no component "${name}"`);

        const changes = sanitizeObject({ ...(params.changes as Record<string, unknown>) });
        const newData = sanitizeObject({ ...oldData, ...changes });
        const cid = ctx.engine.getComponentIdByName(name);
        ctx.engine.ecsWorld.setComponent(entity, cid, newData);
        ctx.engine.ecsWorld.flushCommands();
        ctx.document.markDirty({ kind: "data", entity: key });
        ctx.adapter?.syncEntity?.(key);
        return {
          value: { entity: key, component: name, updated: Object.keys(changes) },
          inverse: [{ command: "component.set", params: { entity: key, component: name, changes: oldData } }],
          description: `Set ${name} on ${key}`,
        };
      },
    },

    {
      id: "component.remove",
      title: "Remove Component",
      mutating: true,
      params: {
        type: "object",
        properties: {
          entity: { type: "string" },
          component: { type: "string" },
        },
        required: ["entity", "component"],
      },
      apply(ctx, params) {
        const key = params.entity as string;
        const name = params.component as string;
        const entity = ctx.parseEntity(key);
        if (!entity || !ctx.isAliveKey(key)) throw new Error(`Entity ${key} not found or dead`);
        const oldData = readComponent(ctx, key, name);
        if (oldData === null) throw new Error(`Entity ${key} has no component "${name}"`);

        const cid = ctx.engine.getComponentIdByName(name);
        ctx.engine.ecsWorld.removeComponent(entity, cid);
        ctx.engine.ecsWorld.flushCommands();
        ctx.document.markDirty({ kind: "data", entity: key });
        ctx.adapter?.syncEntity?.(key);
        return {
          value: { entity: key, component: name, removed: true },
          inverse: [{ command: "component.add", params: { entity: key, component: name, data: oldData } }],
          description: `Remove ${name} from ${key}`,
        };
      },
    },

    {
      id: "component.list",
      title: "List Components on Entity",
      mutating: false,
      params: {
        type: "object",
        properties: { entity: { type: "string" } },
        required: ["entity"],
      },
      apply(ctx, params) {
        const key = params.entity as string;
        const entity = ctx.parseEntity(key);
        if (!entity || !ctx.isAliveKey(key)) throw new Error(`Entity ${key} not found or dead`);
        const arch = ctx.engine.ecsWorld.getArchetypeForEntity(entity);
        const components: Record<string, unknown> = {};
        if (arch) {
          const row = arch.entities.findIndex((e) => e.index === entity.index && e.generation === entity.generation);
          if (row >= 0) {
            for (const [cid] of arch.columns.entries()) {
              components[ctx.engine.getComponentNameById(cid)] =
                sanitizeObject(ctx.engine.ecsWorld.getComponent(entity, cid) ?? {});
            }
          }
        }
        return { value: { entity: key, components } };
      },
    },
  ];
}
