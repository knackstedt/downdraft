// ============================================================================
// Hierarchy commands — setParent (+ setParentToRestore used inside undo
// batches to re-parent children onto a restored entity's NEW key).
// ============================================================================

import type { EditorCommand } from "./registry";

export function createHierarchyCommands(): EditorCommand[] {
  return [
    {
      id: "hierarchy.setParent",
      title: "Set Parent",
      mutating: true,
      params: {
        type: "object",
        properties: {
          entity: { type: "string" },
          parent: { type: "string", description: "New parent key, or omit/empty for root" },
        },
        required: ["entity"],
      },
      apply(ctx, params) {
        const key = params.entity as string;
        const entity = ctx.parseEntity(key);
        if (!entity || !ctx.isAliveKey(key)) {
          throw new Error(`Entity ${key} not found or dead`);
        }
        const parentKey = (params.parent as string | undefined) || undefined;
        const parent = parentKey ? ctx.parseEntity(parentKey) : null;
        if (parentKey && (!parent || !ctx.isAliveKey(parentKey))) {
          throw new Error(`Parent ${parentKey} not found or dead`);
        }
        if (parent && parent.index === entity.index && parent.generation === entity.generation) {
          throw new Error("Cannot parent an entity to itself");
        }
        const oldParent = ctx.engine.hierarchy.getParent(entity);
        ctx.engine.hierarchy.setParent(entity, parent);
        ctx.document.markDirty({ kind: "structure", entity: key });
        return {
          value: { entity: key, parent: parent ? ctx.key(parent) : null },
          inverse: [{
            command: "hierarchy.setParent",
            params: oldParent ? { entity: key, parent: ctx.key(oldParent) } : { entity: key },
          }],
          description: `Set parent of ${key} → ${parent ? ctx.key(parent) : "root"}`,
        };
      },
    },

    {
      id: "hierarchy.setParentToRestore",
      title: "Reparent to Restored Entity",
      mutating: true,
      params: {
        type: "object",
        properties: { child: { type: "string" } },
        required: ["child"],
      },
      apply(ctx, params) {
        const childKey = params.child as string;
        const child = ctx.parseEntity(childKey);
        if (!child || !ctx.isAliveKey(childKey)) {
          return { value: { skipped: true, child: childKey } };
        }
        const newParentKey = ctx.lastRestoredKey;
        const parent = newParentKey ? ctx.parseEntity(newParentKey) : null;
        if (!parent || !ctx.isAliveKey(newParentKey!)) {
          return { value: { skipped: true, child: childKey } };
        }
        const oldParent = ctx.engine.hierarchy.getParent(child);
        ctx.engine.hierarchy.setParent(child, parent);
        return {
          value: { child: childKey, parent: newParentKey },
          inverse: [{
            command: "hierarchy.setParent",
            params: oldParent ? { entity: childKey, parent: ctx.key(oldParent) } : { entity: childKey },
          }],
          description: `Reparent ${childKey} → restored ${newParentKey}`,
        };
      },
    },
  ];
}
