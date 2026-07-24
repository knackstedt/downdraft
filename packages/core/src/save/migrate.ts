import { SchemaRegistry } from "./schema.ts";
import { Serializer, type SaveData } from "./serializer.ts";
import type { World } from "../ecs/world.ts";

export class SaveSystem {
  private serializer: Serializer;
  private schemaRegistry: SchemaRegistry;

  constructor() {
    this.serializer = new Serializer();
    this.schemaRegistry = new SchemaRegistry();
  }

  getSchemaRegistry(): SchemaRegistry {
    return this.schemaRegistry;
  }

  save(world: World, sceneName: string): SaveData {
    return this.serializer.serialize(world, sceneName);
  }

  load(data: SaveData, world: World): void {
    this.serializer.deserialize(data, world, this.schemaRegistry);
  }

  saveToFile(world: World, sceneName: string, path: string): Promise<void> {
    const data = this.save(world, sceneName);
    const json = this.serializer.toJSON(data);
    return Bun.write(path, json);
  }

  async loadFromFile(path: string, world: World): Promise<void> {
    const json = await Bun.file(path).text();
    const data = this.serializer.fromJSON(json);
    this.load(data, world);
  }

  registerMigration(fromVersion: number, fn: (data: unknown) => unknown): void {
    this.schemaRegistry.registerMigration(fromVersion, fn);
  }
}
