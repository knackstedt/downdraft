import type { PromptRegistration } from "../types.ts";

export function createAddEntityPrompt(): PromptRegistration[] {
  return [
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
  ];
}
