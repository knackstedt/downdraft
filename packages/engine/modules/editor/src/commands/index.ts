// ============================================================================
// Default command set — everything registered on a fresh EditorContext.
// ============================================================================

import { createComponentCommands } from "./component";
import { createEntityCommands } from "./entity";
import { createHierarchyCommands } from "./hierarchy";
import { createPrefabCommands } from "./prefab";
import type { EditorCommand, EditorCommandRegistry } from "./registry";
import { createSceneIoCommands } from "./scene-io";
import { createSelectionCommands } from "./selection";
import { createTransformCommands } from "./transform";

function createEditorMetaCommands(): EditorCommand[] {
  return [
    {
      id: "editor.undo",
      title: "Undo",
      mutating: false,
      apply: async (ctx) => ({ value: { undone: await ctx.commands.undo() } }),
    },
    {
      id: "editor.redo",
      title: "Redo",
      mutating: false,
      apply: async (ctx) => ({ value: { redone: await ctx.commands.redo() } }),
    },
    {
      id: "editor.getState",
      title: "Editor State",
      mutating: false,
      apply(ctx) {
        return {
          value: {
            scene: ctx.document.name,
            path: ctx.document.filePath,
            dirty: ctx.document.isDirty(),
            entities: ctx.document.entityCount,
            selection: ctx.selection.get(),
            undoDepth: ctx.commands.getJournal().length,
            redoDepth: ctx.commands.getRedoStack().length,
          },
        };
      },
    },
  ];
}

/** Register the full default command vocabulary on a registry. */
export function registerDefaultCommands(registry: EditorCommandRegistry): void {
  registry.registerAll([
    ...createEntityCommands(),
    ...createComponentCommands(),
    ...createHierarchyCommands(),
    ...createTransformCommands(),
    ...createSelectionCommands(),
    ...createSceneIoCommands(),
    ...createPrefabCommands(),
    ...createEditorMetaCommands(),
  ]);
}
