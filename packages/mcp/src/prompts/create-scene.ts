import type { PromptRegistration } from "../types";

export function createCreateScenePrompt(): PromptRegistration[] {
  return [
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
  ];
}
