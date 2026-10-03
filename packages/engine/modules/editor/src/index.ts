// @downdraft/engine/modules/editor — public API
export { createEditorModule, EditorModuleTok } from "./module";
export type { EditorModuleConfig } from "./module";

export { createNodeFs, EditorContext } from "./editor-context";
export type { EditorContextOptions, EditorFs, EditorRay, EditorSceneAdapter } from "./editor-context";

export { EditorDocument } from "./document";
export type { DocumentChange, DocumentChangeKind } from "./document";

export { SelectionModel } from "./selection";

export { EditorCommandError, EditorCommandRegistry } from "./commands/registry";
export type {
    CommandInvocation,
    CommandOutcome,
    EditorCommand,
    EditorCommandSource,
    EditorParamSchema,
    JournalEntry
} from "./commands/registry";

export { registerDefaultCommands } from "./commands/index";

export { DEFAULT_LAYOUT, EditorShell } from "./shell";
export type { EditorShellLayout, GizmoModeName } from "./shell";

export { EditorViewport } from "./viewport";

export {
    DDSCENE_FORMAT,
    DDSCENE_VERSION,
    deserializeIntoDocument,
    diffScenes,
    instantiateScene,
    parseDdScene,
    serializeDocument
} from "./ddscene";
export type { DdSceneEntity, DdSceneFile, DeserializeResult, SceneDiff } from "./ddscene";

export { createEditorMcpTools, editorMcpTools, getEditorContext } from "./mcp";
