// ============================================================================
// Selection commands — selection is session state, not document content, so
// these are non-mutating: they appear in the event log (agents can observe)
// but never on the undo stack.
// ============================================================================

import type { EditorCommand } from "./registry";

export function createSelectionCommands(): EditorCommand[] {
  return [
    {
      id: "selection.set",
      title: "Set Selection",
      mutating: false,
      params: {
        type: "object",
        properties: { entities: { type: "array", items: { type: "string" } } },
        required: ["entities"],
      },
      apply(ctx, params) {
        const keys = (params.entities as string[]).filter((k) => ctx.isAliveKey(k));
        ctx.selection.set(keys);
        return { value: { selected: ctx.selection.get() }, description: `Select ${keys.length} entities` };
      },
    },
    {
      id: "selection.add",
      title: "Add to Selection",
      mutating: false,
      params: {
        type: "object",
        properties: { entity: { type: "string" } },
        required: ["entity"],
      },
      apply(ctx, params) {
        const key = params.entity as string;
        if (ctx.isAliveKey(key)) ctx.selection.add(key);
        return { value: { selected: ctx.selection.get() } };
      },
    },
    {
      id: "selection.remove",
      title: "Remove from Selection",
      mutating: false,
      params: {
        type: "object",
        properties: { entity: { type: "string" } },
        required: ["entity"],
      },
      apply(ctx, params) {
        ctx.selection.remove(params.entity as string);
        return { value: { selected: ctx.selection.get() } };
      },
    },
    {
      id: "selection.clear",
      title: "Clear Selection",
      mutating: false,
      apply(ctx) {
        ctx.selection.clear();
        return { value: { selected: [] } };
      },
    },
    {
      id: "selection.get",
      title: "Get Selection",
      mutating: false,
      apply(ctx) {
        return { value: { selected: ctx.selection.get(), primary: ctx.selection.primary() } };
      },
    },
  ];
}
