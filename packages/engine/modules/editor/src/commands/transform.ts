// ============================================================================
// Transform commands — `transform.set` is the workhorse for gizmo drags and
// inspector vec3 edits. Writes into the entity's `transform` component
// (position/rotation/scale), creating it with identity defaults when absent.
// The component name is configurable via `ctx.transformComponent`.
// ============================================================================

import { sanitizeObject } from "@downdraft/engine";

import type { EditorContext } from "../editor-context";
import type { EditorCommand } from "./registry";

const IDENTITY = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };

function readTransform(ctx: EditorContext, entityKey: string): Record<string, unknown> {
  const entity = ctx.parseEntity(entityKey);
  if (!entity) return { ...IDENTITY };
  const cid = ctx.engine.getComponentIdByName(ctx.transformComponent);
  const data = ctx.engine.ecsWorld.getComponent<Record<string, unknown>>(entity, cid);
  return data ? (sanitizeObject({ ...data }) as Record<string, unknown>) : { ...IDENTITY };
}

export function createTransformCommands(): EditorCommand[] {
  return [
    {
      id: "transform.set",
      title: "Set Transform",
      mutating: true,
      params: {
        type: "object",
        properties: {
          entity: { type: "string" },
          position: { type: "array", items: { type: "number" }, description: "[x,y,z]" },
          rotation: { type: "array", items: { type: "number" }, description: "quaternion [x,y,z,w]" },
          scale: { type: "array", items: { type: "number" }, description: "[x,y,z]" },
        },
        required: ["entity"],
      },
      apply(ctx, params) {
        const key = params.entity as string;
        const entity = ctx.parseEntity(key);
        if (!entity || !ctx.isAliveKey(key)) throw new Error(`Entity ${key} not found or dead`);

        const old = readTransform(ctx, key);
        const next = { ...old } as Record<string, unknown>;
        const applied: string[] = [];
        (["position", "rotation", "scale"] as const).forEach((field) => {
          const v = params[field] as number[] | undefined;
          if (v) { next[field] = [...v]; applied.push(field); }
        });
        if (applied.length === 0) throw new Error("transform.set: nothing to set");

        const cid = ctx.engine.getComponentIdByName(ctx.transformComponent);
        const sanitized = sanitizeObject(next);
        if (ctx.engine.ecsWorld.hasComponent(entity, cid)) {
          ctx.engine.ecsWorld.setComponent(entity, cid, sanitized);
        } else {
          ctx.engine.ecsWorld.addComponent(entity, cid, sanitized);
        }
        ctx.engine.ecsWorld.flushCommands();
        ctx.document.markDirty({ kind: "data", entity: key });
        ctx.adapter?.syncEntity?.(key);

        // Inverse restores only the fields we changed.
        const inverseChanges: Record<string, unknown> = {};
        applied.forEach((f) => { inverseChanges[f] = old[f]; });
        return {
          value: { entity: key, applied },
          inverse: [{ command: "component.set", params: { entity: key, component: ctx.transformComponent, changes: inverseChanges } }],
          description: `Transform ${key} (${applied.join(", ")})`,
        };
      },
    },

    {
      id: "transform.get",
      title: "Get Transform",
      mutating: false,
      params: {
        type: "object",
        properties: { entity: { type: "string" } },
        required: ["entity"],
      },
      apply(ctx, params) {
        const key = params.entity as string;
        if (!ctx.isAliveKey(key)) throw new Error(`Entity ${key} not found or dead`);
        return { value: { entity: key, transform: readTransform(ctx, key) } };
      },
    },
  ];
}
