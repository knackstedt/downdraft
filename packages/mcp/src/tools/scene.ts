import type { EngineContext } from "../engine-context";
import type { ToolRegistration } from "../types";
import { errorResult, jsonResult, textResult } from "../types";
import type { UndoRedoManager } from "../undo-redo";

export function createSceneTools(ctx: EngineContext, undoRedo: UndoRedoManager): ToolRegistration[] {
  const tools: ToolRegistration[] = [

    {
      def: {
        name: "create_scene",
        description: "Create a new scene with the given name. Unloads the current scene and activates the new one.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Scene name" },
          },
          required: ["name"],
        },
      },
      handler: async (params) => {
        const name = params.name as string;
        if (!name) return errorResult("name is required");

        const oldName = ctx.scene.name;
        const oldScene = ctx.world.sceneManager.get(oldName) ?? ctx.scene;
        const oldData = oldScene.serialize();

        // Unload current scene via scene manager
        ctx.world.sceneManager.unload(oldName);

        // Create, load, and activate new scene
        const newScene = ctx.world.sceneManager.create(name);
        await newScene.load();
        ctx.world.sceneManager.activate(name);
        ctx.scene = newScene;

        undoRedo.execute({
          description: `create_scene("${name}")`,
          undo: () => {
            ctx.world.sceneManager.unload(name);
            oldScene.deserialize(oldData);
            ctx.world.sceneManager.activate(oldName);
            ctx.scene = oldScene;
          },
          redo: () => {
            ctx.world.sceneManager.unload(oldName);
            ctx.world.sceneManager.activate(name);
            ctx.scene = newScene;
          },
        });

        return jsonResult({ scene: name, entityCount: 0 });
      },
    },

    {
      def: {
        name: "load_scene",
        description: "Load a scene from a JSON save file path.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to the save file" },
          },
          required: ["path"],
        },
      },
      handler: async (params) => {
        const path = params.path as string;
        if (!path) return errorResult("path is required");

        try {
          await ctx.saveSystem.loadFromFile(path, ctx.ecsWorld);
          return jsonResult({ loaded: true, path, entityCount: ctx.ecsWorld.entityCount() });
        } catch (e) {
          return errorResult(`Failed to load scene: ${(e as Error).message}`);
        }
      },
    },

    {
      def: {
        name: "save_scene",
        description: "Save the current scene to a JSON file.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Output file path" },
          },
          required: ["path"],
        },
      },
      handler: async (params) => {
        const path = params.path as string;
        if (!path) return errorResult("path is required");

        try {
          await ctx.saveSystem.saveToFile(ctx.ecsWorld, ctx.scene.name, path);
          return jsonResult({ saved: true, path, scene: ctx.scene.name });
        } catch (e) {
          return errorResult(`Failed to save scene: ${(e as Error).message}`);
        }
      },
    },

    {
      def: {
        name: "get_scene_info",
        description: "Get information about the current scene.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => {
        return jsonResult({
          name: ctx.scene.name,
          entityCount: ctx.ecsWorld.entityCount(),
          tick: ctx.ecsWorld.tick,
          materials: ctx.materialLibrary.list().map((m) => m.name),
          meshes: [...ctx.meshes.keys()],
          lights: ctx.lights.length,
          resources: [...ctx.ecsWorld.resources.keys()],
        });
      },
    },

    {
      def: {
        name: "export_scene",
        description: "Export the current scene as a JSON string (without writing to file).",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => {
        const data = ctx.saveSystem.save(ctx.ecsWorld, ctx.scene.name);
        return textResult(JSON.stringify(data, null, 2));
      },
    },

  ];

  return tools;
}
