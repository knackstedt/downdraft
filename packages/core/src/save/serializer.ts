import { getComponentName } from "../ecs/component";
import type { Entity } from "../ecs/entity";
import type { World } from "../ecs/world";
import { SchemaRegistry } from "./schema";

/** Maximum number of entities allowed in a deserialized scene. */
const MAX_ENTITY_COUNT = 1_000_000;
/** Maximum number of components per entity in a deserialized scene. */
const MAX_COMPONENTS_PER_ENTITY = 256;

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
    const binaryBlobs: Record<string, ArrayBuffer> = {};

    for (let i = 1; i < world.entities.length; i++) {
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
          const data = col[row];
          if (data instanceof ArrayBuffer) {
            const blobKey = `blob_${i}_${cid}`;
            binaryBlobs[blobKey] = data;
            components.push({ id: cid, data: { __blobRef: blobKey } });
          } else if (data instanceof Float32Array || data instanceof Float64Array ||
                     data instanceof Int32Array || data instanceof Uint32Array ||
                     data instanceof Uint8Array || data instanceof Int8Array ||
                     data instanceof Int16Array || data instanceof Uint16Array) {
            const blobKey = `blob_${i}_${cid}`;
            const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
            binaryBlobs[blobKey] = buf instanceof ArrayBuffer ? buf : new ArrayBuffer(buf.byteLength);
            new Uint8Array(binaryBlobs[blobKey]).set(new Uint8Array(buf));
            components.push({ id: cid, data: { __blobRef: blobKey } });
          } else {
            components.push({ id: cid, data });
          }
        }
      }

      entities.push({ index: i, generation: meta.generation, components });
    }

    return {
      schemaVersion: 1,
      scene: { name: sceneName, entities },
      binaryBlobs: Object.keys(binaryBlobs).length > 0 ? binaryBlobs : undefined,
    };
  }

  deserialize(data: SaveData, world: World, schemaRegistry: SchemaRegistry): void {
    const migrated = schemaRegistry.migrate(data, data.schemaVersion) as SaveData;
    const blobs = migrated.binaryBlobs ?? {};

    // Bounds validation — prevent OOM / integer overflow from malformed saves.
    const entityCount = migrated.scene.entities.length;
    if (entityCount > MAX_ENTITY_COUNT) {
      throw new RangeError(
        `deserialize: entity count ${entityCount} exceeds maximum ${MAX_ENTITY_COUNT}`,
      );
    }

    for (let i = 0; i < world.entities.length; i++) {
      const meta = world.entities[i];
      if (meta.alive) {
        world.despawn({ index: i, generation: meta.generation });
      }
    }
    world.flushCommands();

    for (let i = 0; i < migrated.scene.entities.length; i++) {
      const entry = migrated.scene.entities[i];

      // Validate component count per entity.
      if (entry.components.length > MAX_COMPONENTS_PER_ENTITY) {
        throw new RangeError(
          `deserialize: entity ${i} has ${entry.components.length} components, exceeds maximum ${MAX_COMPONENTS_PER_ENTITY}`,
        );
      }

      const components = new Map<number, unknown>();
      for (let j = 0; j < entry.components.length; j++) {
        const comp = entry.components[j];

        // Validate component ID exists in the component registry.
        const compName = getComponentName(comp.id);
        if (compName.startsWith("Unknown(")) {
          throw new Error(
            `deserialize: entity ${i} references unregistered component ID ${comp.id}`,
          );
        }

        if (comp.data && typeof comp.data === "object" && "__blobRef" in (comp.data as Record<string, unknown>)) {
          const ref = (comp.data as Record<string, string>).__blobRef;
          components.set(comp.id, blobs[ref] ?? new ArrayBuffer(0));
        } else {
          components.set(comp.id, comp.data);
        }
      }
      world.spawn(components);
    }
  }

  toJSON(data: SaveData): string {
    return JSON.stringify(data, (_key, value) => {
      if (value instanceof ArrayBuffer) {
        return { __type: "ArrayBuffer", __data: arrayBufferToBase64(value) };
      }
      if (typeof value === "object" && value !== null && value.buffer instanceof ArrayBuffer && !Array.isArray(value)) {
        return { __type: "TypedArray", __data: arrayBufferToBase64(value.buffer) };
      }
      return value;
    }, 2);
  }

  fromJSON(json: string): SaveData {
    return JSON.parse(json, (_key, value) => {
      if (value && typeof value === "object" && value.__type === "ArrayBuffer" && typeof value.__data === "string") {
        return base64ToArrayBuffer(value.__data);
      }
      if (value && typeof value === "object" && value.__type === "TypedArray" && typeof value.__data === "string") {
        return base64ToArrayBuffer(value.__data);
      }
      return value;
    });
  }

  toBinary(data: SaveData): ArrayBuffer {
    const json = this.toJSON(data);
    const encoder = new TextEncoder();
    return encoder.encode(json).buffer;
  }

  fromBinary(buffer: ArrayBuffer): SaveData {
    const decoder = new TextDecoder();
    return this.fromJSON(decoder.decode(buffer));
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
