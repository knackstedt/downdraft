import type { EngineContext } from "../engine-context";
import { MeshBuilder } from "../engine-context";
import type { ToolRegistration } from "../types";
import { jsonResult, errorResult } from "../types";
import type { UndoRedoManager } from "../undo-redo";

export function createMeshTools(ctx: EngineContext, undoRedo: UndoRedoManager): ToolRegistration[] {
  const tools: ToolRegistration[] = [

    {
      def: {
        name: "generate_procedural_mesh",
        description: "Generate a procedural mesh (cube, plane, sphere) and register it.",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["cube", "plane", "sphere"],
              description: "Mesh type",
            },
            name: { type: "string", description: "Mesh name for reference" },
            size: { type: "number", description: "Size (cube edge, plane width)" },
            width: { type: "number", description: "Plane width" },
            depth: { type: "number", description: "Plane depth" },
            segments: { type: "number", description: "Plane segments" },
            radius: { type: "number", description: "Sphere radius" },
            widthSegments: { type: "number", description: "Sphere width segments" },
            heightSegments: { type: "number", description: "Sphere height segments" },
          },
          required: ["type", "name"],
        },
      },
      handler: (params) => {
        const type = params.type as string;
        const name = params.name as string;
        if (!type || !name) return errorResult("type and name are required");

        let mesh;
        switch (type) {
          case "cube":
            mesh = MeshBuilder.cube((params.size as number) ?? 1);
            break;
          case "plane":
            mesh = MeshBuilder.plane(
              (params.width as number) ?? 1,
              (params.depth as number) ?? 1,
              (params.segments as number) ?? 1,
            );
            break;
          case "sphere":
            mesh = MeshBuilder.sphere(
              (params.radius as number) ?? 0.5,
              (params.widthSegments as number) ?? 16,
              (params.heightSegments as number) ?? 12,
            );
            break;
          default:
            return errorResult(`Unknown mesh type: ${type}`);
        }

        ctx.meshes.set(name, mesh);

        undoRedo.execute({
          description: `generate_procedural_mesh("${name}", ${type})`,
          undo: () => { ctx.meshes.delete(name); },
          redo: () => { ctx.meshes.set(name, mesh); },
        });

        return jsonResult({
          name,
          type,
          vertexCount: mesh.vertexCount,
          indexCount: mesh.indexCount,
        });
      },
    },

    {
      def: {
        name: "import_mesh",
        description: "Import a mesh from a GLB/GLTF file path.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to GLB/GLTF file" },
            name: { type: "string", description: "Mesh name for reference" },
          },
          required: ["path", "name"],
        },
      },
      handler: async (params) => {
        const path = params.path as string;
        const name = params.name as string;
        if (!path || !name) return errorResult("path and name are required");

        try {
          const data = await ctx.assetManager.load(path);
          ctx.meshes.set(name, data as import("@downdraft/core").MeshData);
          return jsonResult({ imported: true, name, path });
        } catch (e) {
          return errorResult(`Failed to import mesh: ${(e as Error).message}`);
        }
      },
    },

    {
      def: {
        name: "assign_mesh",
        description: "Assign a mesh to an entity.",
        inputSchema: {
          type: "object",
          properties: {
            entity: { type: "string", description: "Entity key" },
            mesh: { type: "string", description: "Mesh name" },
          },
          required: ["entity", "mesh"],
        },
      },
      handler: (params) => {
        const entityKey = params.entity as string;
        const entity = ctx.parseEntityKey(entityKey);
        if (!entity || !ctx.isEntityAlive(entity)) {
          return errorResult(`Entity ${entityKey} not found or dead`);
        }

        const meshName = params.mesh as string;
        if (!ctx.meshes.has(meshName)) {
          return errorResult(`Mesh "${meshName}" not found`);
        }

        const oldMesh = ctx.entityMeshes.get(entityKey) ?? null;
        ctx.entityMeshes.set(entityKey, meshName);

        undoRedo.execute({
          description: `assign_mesh(${entityKey}, ${meshName})`,
          undo: () => {
            if (oldMesh) ctx.entityMeshes.set(entityKey, oldMesh);
            else ctx.entityMeshes.delete(entityKey);
          },
          redo: () => { ctx.entityMeshes.set(entityKey, meshName); },
        });

        return jsonResult({ entity: entityKey, mesh: meshName });
      },
    },

    {
      def: {
        name: "set_lod",
        description: "Configure LOD distances for an entity's mesh.",
        inputSchema: {
          type: "object",
          properties: {
            entity: { type: "string", description: "Entity key" },
            levels: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  distance: { type: "number" },
                  mesh: { type: "string" },
                },
              },
              description: "LOD levels sorted by distance",
            },
          },
          required: ["entity", "levels"],
        },
      },
      handler: (params) => {
        const entityKey = params.entity as string;
        const entity = ctx.parseEntityKey(entityKey);
        if (!entity || !ctx.isEntityAlive(entity)) {
          return errorResult(`Entity ${entityKey} not found or dead`);
        }

        const levels = params.levels as Array<{ distance: number; mesh: string }>;

        const meshName = ctx.entityMeshes.get(entityKey);
        if (!meshName) {
          return errorResult(`Entity ${entityKey} has no mesh assigned`);
        }

        const baseMesh = ctx.meshes.get(meshName);
        if (!baseMesh) {
          return errorResult(`Mesh "${meshName}" not found`);
        }

        const lodLevels = levels.map((lvl, i) => {
          const targetMesh = ctx.meshes.get(lvl.mesh);
          if (targetMesh) {
            return {
              mesh: targetMesh,
              screenSpaceError: i * 2,
              distance: lvl.distance,
            };
          }
          const generated = ctx.lodGenerator.generateLOD(baseMesh, 0.5 * (i + 1));
          return {
            mesh: generated,
            screenSpaceError: i * 2,
            distance: lvl.distance,
          };
        });

        ctx.lodConfigs.set(entityKey, {
          levels: lodLevels,
          autoGenerate: true,
          maxReduction: 0.9,
        });

        return jsonResult({ entity: entityKey, lodLevels: levels.length, levels });
      },
    },

    {
      def: {
        name: "list_meshes",
        description: "List all registered meshes.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => {
        const meshes = [...ctx.meshes.entries()].map(([name, mesh]) => ({
          name,
          vertexCount: (mesh as { vertexCount: number }).vertexCount,
          indexCount: (mesh as { indexCount: number }).indexCount,
        }));
        return jsonResult({ count: meshes.length, meshes });
      },
    },

  ];

  return tools;
}
