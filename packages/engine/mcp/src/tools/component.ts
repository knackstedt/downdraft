import type { EngineContext } from "../engine-context";
import type { ToolRegistration } from "../types";
import { jsonResult, errorResult } from "../types";
import type { UndoRedoManager } from "../undo-redo";

export function createComponentTools(ctx: EngineContext, undoRedo: UndoRedoManager): ToolRegistration[] {
  const tools: ToolRegistration[] = [

    {
      def: {
        name: "add_component",
        description: "Add a component to an entity with the given data.",
        inputSchema: {
          type: "object",
          properties: {
            entity: { type: "string", description: "Entity key (e.g. '5.0')" },
            component: { type: "string", description: "Component name" },
            data: {
              type: "object",
              description: "Component data fields",
              properties: {},
            },
          },
          required: ["entity", "component", "data"],
        },
      },
      handler: (params) => {
        const entityKey = params.entity as string;
        const entity = ctx.parseEntityKey(entityKey);
        if (!entity || !ctx.isEntityAlive(entity)) {
          return errorResult(`Entity ${entityKey} not found or dead`);
        }

        const componentName = params.component as string;
        const componentId = ctx.getComponentIdByName(componentName);
        const data = params.data as Record<string, unknown>;

        const hadComponent = ctx.ecsWorld.hasComponent(entity, componentId);
        const oldData = hadComponent
          ? ctx.ecsWorld.getComponent<Record<string, unknown>>(entity, componentId)
          : null;

        ctx.ecsWorld.addComponent(entity, componentId, data);
        ctx.ecsWorld.flushCommands();

        undoRedo.execute({
          description: `add_component(${entityKey}, ${componentName})`,
          undo: () => {
            if (ctx.isEntityAlive(entity)) {
              if (hadComponent && oldData) {
                ctx.ecsWorld.addComponent(entity, componentId, oldData);
              } else {
                ctx.ecsWorld.removeComponent(entity, componentId);
              }
              ctx.ecsWorld.flushCommands();
            }
          },
          redo: () => {
            if (ctx.isEntityAlive(entity)) {
              ctx.ecsWorld.addComponent(entity, componentId, data);
              ctx.ecsWorld.flushCommands();
            }
          },
        });

        return jsonResult({ entity: entityKey, component: componentName, added: true });
      },
    },

    {
      def: {
        name: "remove_component",
        description: "Remove a component from an entity.",
        inputSchema: {
          type: "object",
          properties: {
            entity: { type: "string", description: "Entity key" },
            component: { type: "string", description: "Component name" },
          },
          required: ["entity", "component"],
        },
      },
      handler: (params) => {
        const entityKey = params.entity as string;
        const entity = ctx.parseEntityKey(entityKey);
        if (!entity || !ctx.isEntityAlive(entity)) {
          return errorResult(`Entity ${entityKey} not found or dead`);
        }

        const componentName = params.component as string;
        const componentId = ctx.getComponentIdByName(componentName);

        if (!ctx.ecsWorld.hasComponent(entity, componentId)) {
          return errorResult(`Entity ${entityKey} has no component "${componentName}"`);
        }

        const oldData = ctx.ecsWorld.getComponent<Record<string, unknown>>(entity, componentId);

        ctx.ecsWorld.removeComponent(entity, componentId);
        ctx.ecsWorld.flushCommands();

        undoRedo.execute({
          description: `remove_component(${entityKey}, ${componentName})`,
          undo: () => {
            if (ctx.isEntityAlive(entity) && oldData) {
              ctx.ecsWorld.addComponent(entity, componentId, oldData);
              ctx.ecsWorld.flushCommands();
            }
          },
          redo: () => {
            if (ctx.isEntityAlive(entity)) {
              ctx.ecsWorld.removeComponent(entity, componentId);
              ctx.ecsWorld.flushCommands();
            }
          },
        });

        return jsonResult({ entity: entityKey, component: componentName, removed: true });
      },
    },

    {
      def: {
        name: "inspect_component",
        description: "Deep dump of a single component on an entity, showing all fields and values.",
        inputSchema: {
          type: "object",
          properties: {
            entity: { type: "string", description: "Entity key" },
            component: { type: "string", description: "Component name" },
          },
          required: ["entity", "component"],
        },
      },
      handler: (params) => {
        const entityKey = params.entity as string;
        const entity = ctx.parseEntityKey(entityKey);
        if (!entity || !ctx.isEntityAlive(entity)) {
          return errorResult(`Entity ${entityKey} not found or dead`);
        }

        const componentName = params.component as string;
        const componentId = ctx.getComponentIdByName(componentName);

        const data = ctx.ecsWorld.getComponent<Record<string, unknown>>(entity, componentId);
        if (!data) {
          return errorResult(`Entity ${entityKey} has no component "${componentName}"`);
        }

        const fields: Record<string, { type: string; value: unknown }> = {};
        for (const [key, value] of Object.entries(data)) {
          let typeStr: string = typeof value;
          if (Array.isArray(value)) typeStr = "array";
          else if (value instanceof Float32Array) typeStr = "Float32Array";
          else if (value instanceof Uint32Array) typeStr = "Uint32Array";
          else if (value === null) typeStr = "null";

          fields[key] = { type: typeStr, value };
        }

        return jsonResult({
          entity: entityKey,
          component: componentName,
          componentId,
          fields,
        });
      },
    },

    {
      def: {
        name: "list_components",
        description: "List all registered component names.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => {
        const entities = ctx.getAllAliveEntities();
        const componentNames = new Set<string>();

        entities.forEach((e) => {
          const arch = ctx.ecsWorld.getArchetypeForEntity(e);
          if (arch) {
            for (const cid of arch.columns.keys()) {
              componentNames.add(ctx.getComponentNameById(cid));
            }
          }
        });

        return jsonResult({ components: [...componentNames] });
      },
    },

  ];

  return tools;
}
