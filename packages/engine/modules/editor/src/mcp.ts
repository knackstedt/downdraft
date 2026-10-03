// ============================================================================
// Editor MCP surface — auto-generated `editor_*` tools.
//
// Every registered EditorCommand becomes an MCP tool (`entity.spawn` →
// `editor_entity_spawn`) with its params schema verbatim. Agents get the
// exact same command semantics as UI clicks — plus meta tools for journal
// inspection, diffing, and state queries.
//
// Games wire these into their harness:
//   mcp: () => createMcpHarness({ tools: createStandardAutomationTools({
//     ..., extraTools: createEditorMcpTools(ctx.editor) }) })
// or standalone: the tools are plain McpToolRegistration objects.
// ============================================================================

import { errorResult, jsonResult, type McpToolRegistration } from "@downdraft/engine/app/renderer";

import type { EditorContext } from "./editor-context";

function toolNameFor(commandId: string): string {
  // "entity.spawn" → "editor_entity_spawn"; "editor.undo" → "editor_undo"
  // (don't double the prefix for ids already namespaced).
  return commandId.replaceAll(".", "_").replace(/^(?!editor_)/, "editor_");
}

export function createEditorMcpTools(editor: EditorContext): McpToolRegistration[] {
  const tools: McpToolRegistration[] = [];

  for (const cmd of editor.commands.list()) {
    const toolName = toolNameFor(cmd.id);
    tools.push({
      def: {
        name: toolName,
        description: `[editor] ${cmd.title} — ${cmd.mutating ? "mutates the document (undoable)" : "read-only / session"}.`,
        inputSchema: (cmd.params ?? { type: "object", properties: {} }) as Record<string, unknown>,
      },
      handler: async (params) => {
        try {
          const value = await editor.commands.dispatch(cmd.id, params, "mcp");
          return jsonResult(value);
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      },
    });
  }

  // Journal + introspection tools that aren't commands themselves.
  tools.push(
    {
      def: {
        name: "editor_commands",
        description: "[editor] List all registered editor commands (id, title, mutating, params schema).",
        inputSchema: { type: "object", properties: {} },
      },
      handler: () => jsonResult({
        commands: editor.commands.list().map((c) => ({
          id: c.id,
          title: c.title,
          mutating: c.mutating,
          params: c.params ?? null,
          mcpTool: toolNameFor(c.id),
        })),
      }),
    },
    {
      def: {
        name: "editor_journal",
        description: "[editor] Command journal: undoable stack + recent event log (all dispatched commands).",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number", description: "Max event-log entries (default 50)" } },
        },
      },
      handler: (params) => jsonResult({
        undo: editor.commands.getJournal().map((e) => `${e.seq}: ${e.description}`),
        redo: editor.commands.getRedoStack().map((e) => `${e.seq}: ${e.description}`),
        events: editor.commands.getEventLog((params?.limit as number) ?? 50).map((e) => ({
          seq: e.seq,
          command: e.command,
          source: e.source,
          description: e.description,
          params: e.params,
        })),
      }),
    },
  );

  return tools;
}

/** Reach the live editor context from a game's `mcp:` hook — the module
 *  stashes itself on `globalThis.__downdraftEditor` (parity with the
 *  devtools `window.__sceneInspector` convention). */
export function getEditorContext(): EditorContext | null {
  return (globalThis as Record<string, unknown>).__downdraftEditor as EditorContext | null ?? null;
}

/** Convenience: tools for the live editor, or [] when the editor module
 *  isn't registered. Use inside `extraTools`. */
export function editorMcpTools(): McpToolRegistration[] {
  const editor = getEditorContext();
  return editor ? createEditorMcpTools(editor) : [];
}
