import { getColumnValue, sanitizeObject, type Entity } from "@downdraft/engine";
import type { EngineContext } from "../engine-context";
import type { ToolRegistration } from "../types";
import { errorResult, jsonResult } from "../types";
import type { UndoRedoManager } from "../undo-redo";

export function createEntityTools(ctx: EngineContext, undoRedo: UndoRedoManager): ToolRegistration[] {
  const tools: ToolRegistration[] = [

    {
      def: {
        name: "spawn_entity",
        description: "Spawn a new entity with optional components. Returns the entity ID.",
        inputSchema: {
          type: "object",
          properties: {
            components: {
              type: "object",
              description: "Map of component name to component data",
              properties: {},
            },
            parent: { type: "string", description: "Parent entity key (e.g. '0.0' for root)" },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Optional tags for the entity",
            },
          },
        },
      },
      handler: (params) => {
        const componentsMap = new Map<number, unknown>();
        const components = sanitizeObject(
          (params.components ?? {}) as Record<string, Record<string, unknown>>,
        );
        for (const [name, data] of Object.entries(components)) {
          const id = ctx.getComponentIdByName(name);
          componentsMap.set(id, sanitizeObject({ ...data }));
        }

        const entity = ctx.ecsWorld.spawn(componentsMap);
        ctx.scene.addEntity(entity);

        const parentKey = params.parent as string | undefined;
        let parent: Entity | null = null;
        if (parentKey) {
          parent = ctx.parseEntityKey(parentKey);
        }
        if (parent) {
          ctx.hierarchy.setParent(entity, parent);
        }

        const entityKey = ctx.getEntityKey(entity);

        const savedParent2 = parent ? parent : null;

        undoRedo.execute({
          description: `spawn_entity(${entityKey})`,
          undo: () => {
            if (ctx.isEntityAlive(entity)) {
              ctx.ecsWorld.despawn(entity);
              ctx.ecsWorld.flushCommands();
              ctx.scene.removeEntity(entity);
            }
          },
          redo: () => {
            const reComponents = new Map<number, unknown>();
            for (const [name, data] of Object.entries(components)) {
              const id = ctx.getComponentIdByName(name);
              reComponents.set(id, sanitizeObject({ ...data }));
            }
            const reEntity = ctx.ecsWorld.spawn(reComponents);
            ctx.ecsWorld.flushCommands();
            ctx.scene.addEntity(reEntity);
            if (savedParent2) {
              ctx.hierarchy.setParent(reEntity, savedParent2);
            }
          },
        });

        return jsonResult({ entity: entityKey, components: Object.keys(components) });
      },
    },

    {
      def: {
        name: "modify_entity",
        description: "Modify an entity's component data or transform.",
        inputSchema: {
          type: "object",
          properties: {
            entity: { type: "string", description: "Entity key (e.g. '5.0')" },
            component: { type: "string", description: "Component name to modify" },
            changes: {
              type: "object",
              description: "Partial component data to update",
              properties: {},
            },
          },
          required: ["entity", "component", "changes"],
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
        const changes = sanitizeObject(
          params.changes as Record<string, unknown>,
        );

        const oldData = ctx.ecsWorld.getComponent<Record<string, unknown>>(entity, componentId);
        if (!oldData) {
          return errorResult(`Entity ${entityKey} has no component "${componentName}"`);
        }

        const oldCopy = sanitizeObject({ ...oldData });
        const newData = sanitizeObject({ ...oldData, ...changes });
        ctx.ecsWorld.addComponent(entity, componentId, newData);
        ctx.ecsWorld.flushCommands();

        undoRedo.execute({
          description: `modify_entity(${entityKey}, ${componentName})`,
          undo: () => {
            if (ctx.isEntityAlive(entity)) {
              ctx.ecsWorld.addComponent(entity, componentId, oldCopy);
              ctx.ecsWorld.flushCommands();
            }
          },
          redo: () => {
            if (ctx.isEntityAlive(entity)) {
              ctx.ecsWorld.addComponent(entity, componentId, newData);
              ctx.ecsWorld.flushCommands();
            }
          },
        });

        return jsonResult({ entity: entityKey, component: componentName, updated: Object.keys(changes) });
      },
    },

    {
      def: {
        name: "remove_entity",
        description: "Remove (despawn) an entity from the world.",
        inputSchema: {
          type: "object",
          properties: {
            entity: { type: "string", description: "Entity key (e.g. '5.0')" },
          },
          required: ["entity"],
        },
      },
      handler: (params) => {
        const entityKey = params.entity as string;
        const entity = ctx.parseEntityKey(entityKey);
        if (!entity || !ctx.isEntityAlive(entity)) {
          return errorResult(`Entity ${entityKey} not found or already dead`);
        }

        const arch = ctx.ecsWorld.getArchetypeForEntity(entity);
        const savedComponents = new Map<number, unknown>();
        if (arch) {
          for (const [cid, col] of arch.columns.entries()) {
            const row = arch.entities.findIndex(
              (e) => e.index === entity.index && e.generation === entity.generation,
            );
            if (row >= 0) {
              const val = getColumnValue(col, row);
              savedComponents.set(cid, val ? { ...val as Record<string, unknown> } : val);
            }
          }
        }

        const savedParent = ctx.hierarchy.getParent(entity);
        const savedChildren = ctx.hierarchy.getChildren(entity);

        ctx.ecsWorld.despawn(entity);
        ctx.ecsWorld.flushCommands();
        ctx.scene.removeEntity(entity);

        undoRedo.execute({
          description: `remove_entity(${entityKey})`,
          undo: () => {
            const restored = ctx.ecsWorld.spawn(savedComponents);
            ctx.ecsWorld.flushCommands();
            ctx.scene.addEntity(restored);
            ctx.hierarchy.setParent(restored, savedParent);
            savedChildren.forEach((child) => {
              if (ctx.isEntityAlive(child)) {
                ctx.hierarchy.setParent(child, restored);
              }
            });
          },
          redo: () => {
            const e = ctx.parseEntityKey(entityKey);
            if (e && ctx.isEntityAlive(e)) {
              ctx.ecsWorld.despawn(e);
              ctx.ecsWorld.flushCommands();
              ctx.scene.removeEntity(e);
            }
          },
        });

        return jsonResult({ removed: true, entity: entityKey });
      },
    },

    {
      def: {
        name: "get_entity_state",
        description: "Get the full state of an entity — all components and their data.",
        inputSchema: {
          type: "object",
          properties: {
            entity: { type: "string", description: "Entity key (e.g. '5.0')" },
          },
          required: ["entity"],
        },
      },
      handler: (params) => {
        const entityKey = params.entity as string;
        const entity = ctx.parseEntityKey(entityKey);
        if (!entity || !ctx.isEntityAlive(entity)) {
          return errorResult(`Entity ${entityKey} not found or dead`);
        }

        const arch = ctx.ecsWorld.getArchetypeForEntity(entity);
        if (!arch) {
          return jsonResult({ entity: entityKey, components: {} });
        }

        const components: Record<string, unknown> = {};
        for (const [cid, col] of arch.columns.entries()) {
          const row = arch.entities.findIndex(
            (e) => e.index === entity.index && e.generation === entity.generation,
          );
          if (row >= 0) {
            components[ctx.getComponentNameById(cid)] = getColumnValue(col, row);
          }
        }

        const parent = ctx.hierarchy.getParent(entity);
        const children = ctx.hierarchy.getChildren(entity);
        const mesh = ctx.entityMeshes.get(entityKey);
        const material = ctx.entityMaterials.get(entityKey);

        return jsonResult({
          id: entityKey,
          components,
          parent: parent ? ctx.getEntityKey(parent) : null,
          children: children.map((c) => ctx.getEntityKey(c)),
          mesh: mesh ?? null,
          material: material ?? null,
        });
      },
    },

    {
      def: {
        name: "find_entities",
        description: "Find entities by component type, hierarchy path, or tags.",
        inputSchema: {
          type: "object",
          properties: {
            component: { type: "string", description: "Filter by component name" },
            parent: { type: "string", description: "Filter by parent entity key" },
            limit: { type: "number", description: "Max results (default 100)" },
          },
        },
      },
      handler: (params) => {
        const limit = (params.limit as number) ?? 100;
        const filterComponent = params.component as string | undefined;
        const filterParent = params.parent as string | undefined;

        const filterComponentId = filterComponent ? ctx.getComponentIdByName(filterComponent) : null;
        const parentEntity = filterParent ? ctx.parseEntityKey(filterParent) : null;

        const results: Array<{ entity: string; components: string[] }> = [];
        const allEntities = ctx.getAllAliveEntities();

        for (let i = 0; i < allEntities.length && results.length < limit; i++) {
          const e = allEntities[i];

          if (filterComponentId !== null && !ctx.ecsWorld.hasComponent(e, filterComponentId)) {
            continue;
          }

          if (parentEntity) {
            const parent = ctx.hierarchy.getParent(e);
            if (!parent || parent.index !== parentEntity.index || parent.generation !== parentEntity.generation) {
              continue;
            }
          }

          const arch = ctx.ecsWorld.getArchetypeForEntity(e);
          const compNames = arch ? [...arch.columns.keys()].map((id) => ctx.getComponentNameById(id)) : [];

          results.push({ entity: ctx.getEntityKey(e), components: compNames });
        }

        return jsonResult({ count: results.length, entities: results });
      },
    },

    {
      def: {
        name: "set_parent",
        description: "Set the parent of an entity in the hierarchy.",
        inputSchema: {
          type: "object",
          properties: {
            entity: { type: "string", description: "Entity key" },
            parent: { type: "string", description: "New parent entity key (use '0.0' for root)" },
          },
          required: ["entity", "parent"],
        },
      },
      handler: (params) => {
        const entityKey = params.entity as string;
        const parentKey = params.parent as string;
        const entity = ctx.parseEntityKey(entityKey);
        const newParent = ctx.parseEntityKey(parentKey);

        if (!entity || !ctx.isEntityAlive(entity)) {
          return errorResult(`Entity ${entityKey} not found or dead`);
        }
        if (!newParent) {
          return errorResult(`Invalid parent key ${parentKey}`);
        }

        const oldParent = ctx.hierarchy.getParent(entity);
        ctx.hierarchy.setParent(entity, newParent);

        undoRedo.execute({
          description: `set_parent(${entityKey}, ${parentKey})`,
          undo: () => {
            if (ctx.isEntityAlive(entity)) {
              ctx.hierarchy.setParent(entity, oldParent);
            }
          },
          redo: () => {
            if (ctx.isEntityAlive(entity)) {
              ctx.hierarchy.setParent(entity, newParent);
            }
          },
        });

        return jsonResult({ entity: entityKey, parent: parentKey });
      },
    },

  ];

  return tools;
}
