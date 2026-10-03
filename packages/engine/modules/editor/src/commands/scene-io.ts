// ============================================================================
// Scene IO commands — new / open / save / saveAs / getTree / diff.
//
// File access goes through `ctx.fs` (node:fs on native hosts; games may
// inject a bridge-backed implementation). Scene replace commands journal a
// doc snapshot so undo across open/new restores the prior document.
// ============================================================================

import { deserializeIntoDocument, diffScenes, parseDdScene, serializeDocument, type DdSceneFile } from "../ddscene";
import type { EditorCommand } from "./registry";

export function createSceneIoCommands(): EditorCommand[] {
  return [
    {
      id: "scene.new",
      title: "New Scene",
      mutating: true,
      params: {
        type: "object",
        properties: { name: { type: "string" } },
      },
      marksDirty: false,
      apply(ctx, params) {
        // Snapshot for undo — reopen restores the prior document contents.
        const prior = serializeDocument(ctx.document, ctx.engine.scene, ctx.engine.hierarchy);
        const priorPath = ctx.document.filePath;
        const wasDirty = ctx.document.isDirty();
        const name = (params.name as string | undefined) ?? "untitled";
        deserializeIntoDocument(ctx.document, ctx.engine.scene, ctx.engine.ecsWorld, ctx.engine.hierarchy, {
          format: "ddscene", version: 1, name, entities: [], meta: {},
        });
        return {
          value: { name, entities: 0 },
          inverse: [{ command: "scene.restoreDoc", params: { doc: prior, path: priorPath, wasDirty } }],
          description: `New scene "${name}"`,
        };
      },
    },

    {
      id: "scene.restoreDoc",
      title: "Restore Document",
      mutating: true,
      marksDirty: false,
      params: {
        type: "object",
        properties: {
          doc: { type: "object" },
          path: { type: "string" },
          wasDirty: { type: "boolean" },
        },
        required: ["doc"],
      },
      apply(ctx, params) {
        const doc = params.doc as DdSceneFile;
        const prior = serializeDocument(ctx.document, ctx.engine.scene, ctx.engine.hierarchy);
        const priorPath = ctx.document.filePath;
        const wasDirty = ctx.document.isDirty();
        deserializeIntoDocument(ctx.document, ctx.engine.scene, ctx.engine.ecsWorld, ctx.engine.hierarchy, doc);
        ctx.document.filePath = (params.path as string | undefined) ?? null;
        if (params.wasDirty) ctx.document.markDirty({ kind: "meta" });
        return {
          value: { name: doc.name, entities: doc.entities.length },
          inverse: [{ command: "scene.restoreDoc", params: { doc: prior, path: priorPath, wasDirty } }],
          description: `Restore document "${doc.name}"`,
        };
      },
    },

    {
      id: "scene.open",
      title: "Open Scene",
      mutating: true,
      marksDirty: false,
      params: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      async apply(ctx, params) {
        if (!ctx.fs) throw new Error("No filesystem available for scene.open");
        const path = params.path as string;
        const text = await ctx.fs.readText(path);
        const file = parseDdScene(text);
        const prior = serializeDocument(ctx.document, ctx.engine.scene, ctx.engine.hierarchy);
        const priorPath = ctx.document.filePath;
        const wasDirty = ctx.document.isDirty();
        const result = deserializeIntoDocument(ctx.document, ctx.engine.scene, ctx.engine.ecsWorld, ctx.engine.hierarchy, file);
        ctx.document.filePath = path;
        return {
          value: { path, name: file.name, entities: file.entities.length, warnings: result.warnings },
          inverse: [{ command: "scene.restoreDoc", params: { doc: prior, path: priorPath, wasDirty } }],
          description: `Open scene ${path}`,
        };
      },
    },

    {
      id: "scene.save",
      title: "Save Scene",
      mutating: true,
      marksDirty: false,
      params: {
        type: "object",
        properties: { path: { type: "string", description: "Override target path (save-as)" } },
      },
      async apply(ctx, params) {
        if (!ctx.fs) throw new Error("No filesystem available for scene.save");
        const path = (params.path as string | undefined) ?? ctx.document.filePath;
        if (!path) throw new Error("scene.save: no path — pass one or set via scene.saveAs");
        const file = serializeDocument(ctx.document, ctx.engine.scene, ctx.engine.hierarchy);
        await ctx.fs.writeText(path, JSON.stringify(file, null, 2));
        ctx.document.filePath = path;
        ctx.document.markClean();
        return {
          value: { path, entities: file.entities.length },
          // Saving is journaled but not undoable (file content is the truth).
          description: `Save scene → ${path}`,
        };
      },
    },

    {
      id: "scene.saveAs",
      title: "Save Scene As",
      mutating: true,
      marksDirty: false,
      params: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      async apply(ctx, params) {
        if (!ctx.fs) throw new Error("No filesystem available for scene.saveAs");
        const path = params.path as string;
        const file = serializeDocument(ctx.document, ctx.engine.scene, ctx.engine.hierarchy);
        await ctx.fs.writeText(path, JSON.stringify(file, null, 2));
        ctx.document.filePath = path;
        ctx.document.markClean();
        return {
          value: { path, entities: file.entities.length },
          description: `Save scene as → ${path}`,
        };
      },
    },

    {
      id: "scene.getTree",
      title: "Get Scene Tree",
      mutating: false,
      apply(ctx) {
        const entities = ctx.document.entities().map((e) => {
          const key = ctx.key(e);
          const parent = ctx.engine.hierarchy.getParent(e);
          const children = ctx.engine.hierarchy.getChildren(e).map((c) => ctx.key(c));
          const arch = ctx.engine.ecsWorld.getArchetypeForEntity(e);
          const comps = arch ? [...arch.columns.keys()].map((id) => ctx.engine.getComponentNameById(id)) : [];
          return {
            key,
            name: ctx.document.entityName(key) ?? null,
            parent: parent ? ctx.key(parent) : null,
            children,
            components: comps,
            selected: ctx.selection.isSelected(key),
          };
        });
        return {
          value: {
            name: ctx.document.name,
            path: ctx.document.filePath,
            dirty: ctx.document.isDirty(),
            entities,
          },
        };
      },
    },

    {
      id: "scene.diff",
      title: "Diff Scene",
      mutating: false,
      params: {
        type: "object",
        properties: {
          against: { type: "string", description: "'file' to diff vs the doc's on-disk version" },
        },
      },
      async apply(ctx, params) {
        const current = serializeDocument(ctx.document, ctx.engine.scene, ctx.engine.hierarchy);
        const against = (params.against as string | undefined) ?? "file";
        if (against === "file") {
          if (!ctx.fs || !ctx.document.filePath) {
            throw new Error("scene.diff: document has no file path");
          }
          const onDisk = parseDdScene(await ctx.fs.readText(ctx.document.filePath));
          return { value: diffScenes(onDisk, current) };
        }
        throw new Error(`scene.diff: unknown target "${against}"`);
      },
    },

    {
      id: "scene.serialize",
      title: "Serialize Scene",
      mutating: false,
      apply(ctx) {
        return { value: serializeDocument(ctx.document, ctx.engine.scene, ctx.engine.hierarchy) };
      },
    },
  ];
}
