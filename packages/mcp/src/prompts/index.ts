import type { PromptRegistration } from "../types.ts";

export function createPrompts(): PromptRegistration[] {
  const prompts: PromptRegistration[] = [

    {
      def: {
        name: "create-scene",
        description: "Template for creating a new scene with entities, lighting, and camera",
        arguments: [
          { name: "sceneName", description: "Name of the scene to create", required: true },
          { name: "description", description: "Description of what the scene should contain" },
        ],
      },
      handler: (args) => {
        const sceneName = args.sceneName ?? "my-scene";
        const description = args.description ?? "a basic scene with lighting";

        return {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `Create a scene called "${sceneName}" that contains ${description}.

Steps:
1. Use create_scene to create a new scene named "${sceneName}"
2. Generate procedural meshes as needed (generate_procedural_mesh)
3. Spawn entities with Transform components (spawn_entity)
4. Assign meshes to entities (assign_mesh)
5. Create and assign materials (create_material, assign_material)
6. Add lighting (add_light or set_sun_angle)
7. Position the camera to frame the scene (set_camera)
8. Create a checkpoint (create_checkpoint)

Use the available MCP tools to accomplish each step.`,
              },
            },
          ],
        };
      },
    },

    {
      def: {
        name: "add-entity",
        description: "Template for adding a new entity to the current scene",
        arguments: [
          { name: "entityType", description: "Type of entity (cube, sphere, plane, custom)", required: true },
          { name: "position", description: "Position as 'x,y,z'" },
          { name: "material", description: "Material type (pbr, unlit, etc.)" },
        ],
      },
      handler: (args) => {
        const entityType = args.entityType ?? "cube";
        const position = args.position ?? "0,0,0";
        const material = args.material ?? "pbr";

        return {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `Add a ${entityType} entity to the scene at position (${position}) with a ${material} material.

Steps:
1. Generate a procedural ${entityType} mesh (generate_procedural_mesh)
2. Spawn an entity with a Transform component at position (${position}) (spawn_entity)
3. Assign the mesh to the entity (assign_mesh)
4. Create a ${material} material (create_material)
5. Assign the material to the entity (assign_material)
6. Verify with get_entity_state`,
              },
            },
          ],
        };
      },
    },

    {
      def: {
        name: "debug-frame",
        description: "Template for debugging why a frame is slow or rendering incorrectly",
        arguments: [
          { name: "symptom", description: "What's wrong (slow, black screen, flickering, etc.)", required: true },
        ],
      },
      handler: (args) => {
        const symptom = args.symptom ?? "the frame is slow";

        return {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `Debug why ${symptom}.

Steps:
1. Use profile_frame to get per-system timings and frame time
2. Use get_performance_history to see frame time trends
3. Use get_telemetry to check GC pauses, memory, and CPU per thread
4. Use get_scene_tree to verify entity count is expected
5. Use inspect_gpu to check buffer sizes and texture memory
6. If a specific system is slow, use inspect_object to examine related entities
7. Suggest optimizations based on findings`,
              },
            },
          ],
        };
      },
    },

  ];

  return prompts;
}
