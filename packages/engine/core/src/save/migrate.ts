import { SchemaRegistry } from "./schema";
import { Serializer, type SaveData } from "./serializer";
import type { World } from "../ecs/world";
import { promises as fs } from "node:fs";

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

  async saveToFile(world: World, sceneName: string, path: string): Promise<number> {
    const data = this.save(world, sceneName);
    const json = this.serializer.toJSON(data);
    await fs.writeFile(path, json);
    return json.length;
  }

  async loadFromFile(path: string, world: World): Promise<void> {
    const json = await fs.readFile(path, "utf-8");
    const data = this.serializer.fromJSON(json);
    this.load(data, world);
  }

  registerMigration(fromVersion: number, fn: (data: unknown) => unknown): void {
    this.schemaRegistry.registerMigration(fromVersion, fn);
  }
}
