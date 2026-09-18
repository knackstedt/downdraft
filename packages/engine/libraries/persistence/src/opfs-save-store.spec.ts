import type { SaveOptions, SaveState } from "@downdraft/engine";
import { beforeEach, describe, expect, it } from "bun:test";
import { createMockOpfsRoot, type MockDirHandle } from "./mock-opfs";
import { OpfsSaveStore } from "./opfs-save-store";

// ============================================================================
// Test compression: prefix byte + copy (same as file-save-store.spec.ts)
// ============================================================================
const testCompress = (data: Uint8Array): Uint8Array => {
  const result = new Uint8Array(data.length + 1);
  result[0] = 0x42;
  result.set(data, 1);
  return result;
};

const testDecompress = (data: Uint8Array, _originalSize: number): Uint8Array => {
  return data.slice(1);
};

// Test hash: XOR-based 16-byte hash
const testHash = (data: Uint8Array): Uint8Array => {
  const hash = new Uint8Array(16);
  for (let i = 0; i < data.length; i++) {
    hash[i % 16] ^= data[i];
  }
  return hash;
};

// ============================================================================
// Helpers
// ============================================================================

function makeState(entityCount: number = 42, playerCount: number = 1): SaveState {
  return {
    components: {
      world: { v: 1, data: { timeOfDay: 0.5, seed: 12345, tick: entityCount } },
      players: { v: 1, data: [{ name: "TestPlayer", health: 100 }] },
    },
    meta: {
      engineVersion: "0.1.0",
      timestamp: Date.now() / 1000,
      entityCount,
      playerCount,
    },
  };
}

function createStore(root: MockDirHandle): OpfsSaveStore {
  const store = new OpfsSaveStore({
    rootDir: root,
    engineVersion: "0.1.0",
    compress: testCompress,
    decompress: testDecompress,
    hash128: testHash,
    maxGenerations: 3,
  });
  return store;
}

// ============================================================================
// Tests
// ============================================================================

describe("OpfsSaveStore", () => {
  let root: MockDirHandle;
  let store: OpfsSaveStore;

  beforeEach(async () => {
    root = createMockOpfsRoot();
    store = createStore(root);
    await store.init();
  });

  it("saves and loads a game state", async () => {
    const state = makeState();
    const result = await store.save("slot1", state);
    expect(result.success).toBe(true);
    expect(result.gen).toBe(1);
    expect(result.bytes).toBeGreaterThan(0);

    const loaded = await store.load("slot1");
    expect(loaded.state).not.toBeNull();
    expect(loaded.state!.components.world).toBeDefined();
    expect(loaded.state!.components.world.v).toBe(1);
    expect((loaded.state!.components.world.data as any).seed).toBe(12345);
    expect(loaded.state!.meta.entityCount).toBe(42);
    expect(loaded.gen).toBe(1);
  });

  it("creates multiple generations and prunes old ones", async () => {
    // Save 4 times with maxGenerations=3
    for (let i = 0; i < 4; i++) {
      await store.save("slot1", makeState(i + 1));
    }

    const gens = await store.listGenerations("slot1");
    expect(gens.length).toBe(3);
    // Newest first
    expect(gens[0].gen).toBe(4);
    expect(gens[1].gen).toBe(3);
    expect(gens[2].gen).toBe(2);
    // Gen 1 should have been pruned
    expect(gens.find(g => g.gen === 1)).toBeUndefined();
  });

  it("falls back to previous generation on corruption", async () => {
    // Save twice
    await store.save("slot1", makeState(10));
    await store.save("slot1", makeState(20));

    // Corrupt the latest gen's body
    const savesDir = await root.getDirectoryHandle("downdraft");
    const slotDir = await savesDir.getDirectoryHandle("saves");
    const slot1Dir = await slotDir.getDirectoryHandle("slot1");
    const genDir = await slot1Dir.getDirectoryHandle("gen");
    const gen4Dir = await genDir.getDirectoryHandle("0002");
    const bodyFile = await gen4Dir.getFileHandle("body.zst", { create: true });
    const writable = await bodyFile.createWritable();
    await writable.write(new Uint8Array([0x00, 0x01, 0x02]));
    await writable.close();

    // Load should fall back to gen 1 with a backup_loaded warning
    let warning: any = null;
    store.onWarning((w) => { warning = w; });

    const loaded = await store.load("slot1");
    expect(loaded.state).not.toBeNull();
    expect(loaded.gen).toBe(1);
    expect((loaded.state!.components.world.data as any).tick).toBe(10);
    expect(warning).not.toBeNull();
    expect(warning.kind).toBe("backup_loaded");
  });

  it("stores and retrieves binary blobs", async () => {
    const blob1 = new ArrayBuffer(8);
    new Uint8Array(blob1).set([1, 2, 3, 4, 5, 6, 7, 8]);
    const blob2 = new ArrayBuffer(4);
    new Uint8Array(blob2).set([10, 20, 30, 40]);

    const opts: SaveOptions = {
      blobs: {
        blob_0_1: blob1,
        blob_0_2: blob2,
      },
    };

    await store.save("slot1", makeState(), opts);

    const loaded = await store.load("slot1");
    expect(loaded.blobs).toBeDefined();
    expect(Object.keys(loaded.blobs!).length).toBe(2);
    expect(loaded.blobs!["blob_0_1"]).toBeDefined();
    expect(new Uint8Array(loaded.blobs!["blob_0_1"])).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(new Uint8Array(loaded.blobs!["blob_0_2"])).toEqual(new Uint8Array([10, 20, 30, 40]));
  });

  it("skips blobs when includeBlobs is false", async () => {
    const blob = new ArrayBuffer(4);
    new Uint8Array(blob).set([1, 2, 3, 4]);

    await store.save("slot1", makeState(), { blobs: { test_blob: blob } });
    const loaded = await store.load("slot1", { includeBlobs: false });
    expect(loaded.blobs).toBeUndefined();
  });

  it("stores and retrieves thumbnails", async () => {
    const thumbData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header bytes

    await store.save("slot1", makeState(), { thumbnail: thumbData.buffer });

    const retrieved = await store.getThumbnail("slot1");
    expect(retrieved).not.toBeNull();
    expect(new Uint8Array(retrieved!)).toEqual(thumbData);
  });

  it("setThumbnail works independently of save", async () => {
    await store.save("slot1", makeState());
    const thumbData = new Uint8Array([0xff, 0xd8, 0xff]); // JPEG header bytes
    await store.setThumbnail("slot1", thumbData);

    const retrieved = await store.getThumbnail("slot1");
    expect(retrieved).not.toBeNull();
    expect(new Uint8Array(retrieved!)).toEqual(thumbData);
  });

  it("stores and retrieves properties", async () => {
    await store.save("slot1", makeState(), {
      properties: { gameMode: "creative", playtimeSeconds: 3600, worldName: "My Ocean" },
    });

    const props = await store.getProperties("slot1");
    expect(props.gameMode).toBe("creative");
    expect(props.playtimeSeconds).toBe(3600);
    expect(props.worldName).toBe("My Ocean");
  });

  it("setProperties merges with existing properties", async () => {
    await store.save("slot1", makeState(), {
      properties: { gameMode: "survival", playtimeSeconds: 100 },
    });
    await store.setProperties("slot1", { playtimeSeconds: 200, worldName: "Updated" });

    const props = await store.getProperties("slot1");
    expect(props.gameMode).toBe("survival"); // preserved
    expect(props.playtimeSeconds).toBe(200); // updated
    expect(props.worldName).toBe("Updated"); // added
  });

  it("listSaves returns multiple slots sorted by timestamp", async () => {
    await store.save("alpha", makeState(1));
    await new Promise(r => setTimeout(r, 10));
    await store.save("beta", makeState(2));
    await new Promise(r => setTimeout(r, 10));
    await store.save("gamma", makeState(3));

    const saves = await store.listSaves();
    expect(saves.length).toBe(3);
    // Newest first (gamma has highest timestamp)
    expect(saves[0].slot).toBe("gamma");
    expect(saves[2].slot).toBe("alpha");
    // Each should have generation info
    expect(saves[0].currentGen).toBe(1);
    expect(saves[0].generationCount).toBe(1);
    expect(saves[0].hasThumbnail).toBe(false);
  });

  it("listSaves includes thumbnail and properties info", async () => {
    await store.save("slot1", makeState(), {
      thumbnail: new Uint8Array([1, 2, 3]),
      properties: { gameMode: "creative" },
    });

    const saves = await store.listSaves();
    expect(saves.length).toBe(1);
    expect(saves[0].hasThumbnail).toBe(true);
    expect(saves[0].properties).toBeDefined();
    expect(saves[0].properties!.gameMode).toBe("creative");
  });

  it("deleteSave removes the entire slot", async () => {
    await store.save("slot1", makeState());
    expect((await store.listSaves()).length).toBe(1);

    const deleted = await store.deleteSave("slot1");
    expect(deleted).toBe(true);
    expect((await store.listSaves()).length).toBe(0);

    const loaded = await store.load("slot1");
    expect(loaded.state).toBeNull();
  });

  it("deleteGeneration removes a specific generation", async () => {
    await store.save("slot1", makeState(1));
    await store.save("slot1", makeState(2));

    const deleted = await store.deleteGeneration("slot1", 1);
    expect(deleted).toBe(true);

    const gens = await store.listGenerations("slot1");
    expect(gens.length).toBe(1);
    expect(gens[0].gen).toBe(2);

    // Current gen should still be 2
    const saves = await store.listSaves();
    expect(saves[0].currentGen).toBe(2);
  });

  it("loads a specific generation by number", async () => {
    await store.save("slot1", makeState(10));
    await store.save("slot1", makeState(20));

    // Load gen 1 specifically
    const loaded = await store.load("slot1", { gen: 1 });
    expect(loaded.state).not.toBeNull();
    expect(loaded.gen).toBe(1);
    expect((loaded.state!.components.world.data as any).tick).toBe(10);
  });

  it("returns null for non-existent slot", async () => {
    const loaded = await store.load("nonexistent");
    expect(loaded.state).toBeNull();
  });

  it("returns empty array for listGenerations on non-existent slot", async () => {
    const gens = await store.listGenerations("nonexistent");
    expect(gens).toEqual([]);
  });

  it("returns empty object for getProperties on non-existent slot", async () => {
    const props = await store.getProperties("nonexistent");
    expect(props).toEqual({});
  });

  it("returns null for getThumbnail on non-existent slot", async () => {
    const thumb = await store.getThumbnail("nonexistent");
    expect(thumb).toBeNull();
  });

  it("sanitizes slot names to prevent path traversal", async () => {
    // Slot names with special chars should be sanitized
    await store.save("..%2F..%2Fetc", makeState());
    const saves = await store.listSaves();
    // Should not have escaped the saves directory
    expect(saves.length).toBe(1);
    expect(saves[0].slot).toMatch(/^[a-zA-Z0-9_\-]+$/);
  });

  it("handles empty blobs gracefully", async () => {
    await store.save("slot1", makeState(), { blobs: {} });
    const loaded = await store.load("slot1");
    expect(loaded.state).not.toBeNull();
    // No blobs dir created, so blobs should be undefined
    expect(loaded.blobs).toBeUndefined();
  });

  it("preserves properties across saves when not re-specified", async () => {
    await store.save("slot1", makeState(), {
      properties: { gameMode: "creative", level: 5 },
    });
    // Save again without properties — should preserve existing
    await store.save("slot1", makeState(2));

    const props = await store.getProperties("slot1");
    expect(props.gameMode).toBe("creative");
    expect(props.level).toBe(5);
  });

  it("emits abandoned_data warning for unregistered component versions", async () => {
    // Save with a component at v3 but no migration registered
    const state: SaveState = {
      components: {
        custom: { v: 3, data: { foo: "bar" } },
      },
      meta: {
        engineVersion: "0.1.0",
        timestamp: Date.now() / 1000,
        entityCount: 0,
        playerCount: 0,
      },
    };

    await store.save("slot1", state);
    let warning: any = null;
    store.onWarning((w) => { warning = w; });

    const loaded = await store.load("slot1");
    // The component should be abandoned (no migration registered for v3)
    expect(loaded.state).not.toBeNull();
    expect(loaded.state!.components.custom).toBeUndefined();
    expect(warning).not.toBeNull();
    expect(warning.kind).toBe("abandoned_data");
    expect(warning.component).toBe("custom");
  });

  it("serializes concurrent saves to prevent overlapping writes", async () => {
    // Fire 5 saves concurrently. Without serialization, they would all read
    // the same existingMeta (currentGen=0), compute currentGen=1, and overwrite
    // the same gen directory — losing 4 of the 5 saves. With serialization,
    // each save sees the previous one's generation and increments correctly.
    const saves = await Promise.all(
      Array.from({ length: 5 }, (_, i) => store.save("slot1", makeState(i + 1))),
    );

    // All saves should succeed
    for (const result of saves) {
      expect(result.success).toBe(true);
    }

    // Generations should be 1, 2, 3, 4, 5 (not all 1)
    const gens = saves.map(r => r.gen);
    expect(gens).toEqual([1, 2, 3, 4, 5]);

    // The latest save should be gen 5
    const loaded = await store.load("slot1");
    expect(loaded.state).not.toBeNull();
    expect(loaded.gen).toBe(5);
    expect((loaded.state!.components.world.data as any).tick).toBe(5);
  });
});
