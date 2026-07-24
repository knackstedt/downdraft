import type { World } from "../ecs/world.ts";
import type { Entity } from "../ecs/entity.ts";
import { SchemaRegistry } from "./schema.ts";

export interface SaveData {
  schemaVersion: number;
  scene: {
    name: string;
    entities: Array<{
      index: number;
      generation: number;
      components: Array<{ id: number; data: unknown }>;
    }>;
  };
  binaryBlobs?: Record<string, ArrayBuffer>;
}

export class Serializer {
  serialize(world: World, sceneName: string): SaveData {
    const entities: SaveData["scene"]["entities"] = [];

    for (let i = 0; i < world.entities.length; i++) {
      const meta = world.entities[i];
      if (!meta.alive) continue;

      const arch = world.archetypeById.get(meta.archetypeId);
      if (!arch) continue;

      const entity: Entity = { index: i, generation: meta.generation };
      const components: Array<{ id: number; data: unknown }> = [];

      for (const [cid, col] of arch.columns) {
        const row = arch.entities.findIndex(
          (e) => e.index === entity.index && e.generation === entity.generation,
        );
        if (row >= 0) {
          components.push({ id: cid, data: col[row] });
        }
      }

      entities.push({ index: i, generation: meta.generation, components });
    }

    return {
      schemaVersion: 1,
      scene: { name: sceneName, entities },
    };
  }

  deserialize(data: SaveData, world: World, schemaRegistry: SchemaRegistry): void {
    const migrated = schemaRegistry.migrate(data, data.schemaVersion) as SaveData;

    for (let i = 0; i < migrated.scene.entities.length; i++) {
      const entry = migrated.scene.entities[i];
      const components = new Map<number, unknown>();
      for (let j = 0; j < entry.components.length; j++) {
        components.set(entry.components[j].id, entry.components[j].data);
      }
      world.spawn(components);
    }
  }

  toJSON(data: SaveData): string {
    return JSON.stringify(data, (_key, value) => {
      if (value instanceof ArrayBuffer) {
        return { __type: "ArrayBuffer", __data: "" };
      }
      return value;
    }, 2);
  }

  fromJSON(json: string): SaveData {
    return JSON.parse(json);
  }
}
