import type { EngineContext } from "../engine-context";
import { BlendMode, CullMode, Material } from "../engine-context";
import type { ToolRegistration } from "../types";
import { jsonResult, errorResult } from "../types";
import type { UndoRedoManager } from "../undo-redo";

export function createMaterialTools(ctx: EngineContext, undoRedo: UndoRedoManager): ToolRegistration[] {
  const tools: ToolRegistration[] = [

    {
      def: {
        name: "create_material",
        description: "Create a new material from a definition (shader + uniforms + textures).",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Material name" },
            shader: { type: "string", description: "WGSL shader path or inline source" },
            type: {
              type: "string",
              description: "Built-in material type (pbr, unlit, skybox, particle, postprocess)",
              enum: ["pbr", "unlit", "skybox", "particle", "postprocess", "custom"],
            },
            blendMode: {
              type: "string",
              enum: ["opaque", "alpha-blend", "alpha-clip", "additive"],
            },
            cullMode: {
              type: "string",
              enum: ["none", "front", "back"],
            },
            uniforms: { type: "object", description: "Uniform definitions", properties: {} },
            textures: { type: "object", description: "Texture binding definitions", properties: {} },
          },
          required: ["name"],
        },
      },
      handler: (params) => {
        const name = params.name as string;
        if (!name) return errorResult("name is required");

        const type = (params.type as string) ?? "custom";
        let material: Material;

        if (type === "pbr") {
          material = ctx.materialLibrary.createPBR(name);
        } else if (type === "unlit") {
          material = ctx.materialLibrary.createUnlit(name);
        } else if (type === "skybox") {
          material = ctx.materialLibrary.createSkybox(name);
        } else if (type === "particle") {
          material = ctx.materialLibrary.createParticle(name);
        } else if (type === "postprocess") {
          material = ctx.materialLibrary.createPostProcess(name);
        } else {
          const shader = params.shader as string ?? "shaders/pbr.wgsl";
          const blendModeStr = (params.blendMode as string) ?? "opaque";
          const cullModeStr = (params.cullMode as string) ?? "back";
          const blendMode = BlendMode[blendModeStr as keyof typeof BlendMode] ?? BlendMode.Opaque;
          const cullMode = CullMode[cullModeStr as keyof typeof CullMode] ?? CullMode.Back;

          material = new Material({
            name,
            shader,
            uniforms: (params.uniforms as Record<string, { name: string; type: "f32" | "vec2" | "vec3" | "vec4" | "mat4"; binding: number }>) ?? {},
            textures: (params.textures as Record<string, { name: string; binding: number; sampler: "linear-repeat" | "linear-clamp" | "point" }>) ?? {},
            blendMode,
            cullMode,
          });
          ctx.materialLibrary.register(material);
        }

        undoRedo.execute({
          description: `create_material("${name}")`,
          undo: () => {
            ctx.materialLibrary.unregister(name);
          },
          redo: () => {
            ctx.materialLibrary.register(material);
          },
        });

        return jsonResult({
          name: material.name,
          shader: material.shader,
          blendMode: material.blendMode,
          cullMode: material.cullMode,
          uniforms: [...material.uniforms.keys()],
          textures: [...material.textures.keys()],
        });
      },
    },

    {
      def: {
        name: "modify_material",
        description: "Modify a material's uniform values.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Material name" },
            uniforms: {
              type: "object",
              description: "Uniform name → new value",
              properties: {},
            },
          },
          required: ["name", "uniforms"],
        },
      },
      handler: (params) => {
        const name = params.name as string;
        const material = ctx.materialLibrary.get(name);
        if (!material) return errorResult(`Material "${name}" not found`);

        const uniformChanges = params.uniforms as Record<string, unknown>;
        const oldValues: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(uniformChanges)) {
          oldValues[key] = material.getUniform(key);
          material.setUniform(key, value);
        }

        undoRedo.execute({
          description: `modify_material("${name}")`,
          undo: () => {
            for (const [key, value] of Object.entries(oldValues)) {
              material.setUniform(key, value);
            }
          },
          redo: () => {
            for (const [key, value] of Object.entries(uniformChanges)) {
              material.setUniform(key, value);
            }
          },
        });

        return jsonResult({ name, updated: Object.keys(uniformChanges) });
      },
    },

    {
      def: {
        name: "assign_material",
        description: "Assign a material to an entity's mesh.",
        inputSchema: {
          type: "object",
          properties: {
            entity: { type: "string", description: "Entity key" },
            material: { type: "string", description: "Material name" },
          },
          required: ["entity", "material"],
        },
      },
      handler: (params) => {
        const entityKey = params.entity as string;
        const entity = ctx.parseEntityKey(entityKey);
        if (!entity || !ctx.isEntityAlive(entity)) {
          return errorResult(`Entity ${entityKey} not found or dead`);
        }

        const materialName = params.material as string;
        const material = ctx.materialLibrary.get(materialName);
        if (!material) return errorResult(`Material "${materialName}" not found`);

        const oldMaterial = ctx.entityMaterials.get(entityKey) ?? null;
        ctx.entityMaterials.set(entityKey, materialName);

        undoRedo.execute({
          description: `assign_material(${entityKey}, ${materialName})`,
          undo: () => {
            if (oldMaterial) {
              ctx.entityMaterials.set(entityKey, oldMaterial);
            } else {
              ctx.entityMaterials.delete(entityKey);
            }
          },
          redo: () => {
            ctx.entityMaterials.set(entityKey, materialName);
          },
        });

        return jsonResult({ entity: entityKey, material: materialName });
      },
    },

    {
      def: {
        name: "list_materials",
        description: "List all registered materials and their properties.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => {
        const materials = ctx.materialLibrary.list().map((m) => ({
          name: m.name,
          shader: m.shader,
          blendMode: m.blendMode,
          cullMode: m.cullMode,
          uniforms: [...m.uniforms.keys()],
          textures: [...m.textures.keys()],
          uniformValues: Object.fromEntries(m.uniformValues),
        }));
        return jsonResult({ count: materials.length, materials });
      },
    },

    {
      def: {
        name: "hot_reload_shader",
        description: "Trigger a hot-reload of a WGSL shader file.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Shader file path" },
          },
          required: ["path"],
        },
      },
      handler: async (params) => {
        const path = params.path as string;

        const matchingMaterials = ctx.materialLibrary.list().filter((m) => m.shader === path);
        matchingMaterials.forEach((mat) => {
          ctx.materialHotReloader.watch(mat, path);
        });

        await ctx.materialHotReloader.checkNow();

        return jsonResult({
          hotReloaded: true,
          path,
          affectedMaterials: matchingMaterials.map((m) => m.name),
        });
      },
    },

  ];

  return tools;
}
