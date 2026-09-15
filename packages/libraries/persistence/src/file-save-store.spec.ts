import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "./file-save-store";

// Test compression: prefix byte + copy
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

describe("FileSaveStore", () => {
  let testDir: string;
  let store: FileSaveStore;

  beforeEach(async () => {
    testDir = join(tmpdir(), `ddsave-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });
    store = new FileSaveStore({
      saveDir: testDir,
      engineVersion: "0.1.0",
      compress: testCompress,
      decompress: testDecompress,
      hash128: testHash,
    });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("saves and loads a game state", async () => {
    const components = {
      world: { v: 1, data: { timeOfDay: 0.5, seed: 12345 } },
      players: { v: 1, data: [{ name: "TestPlayer" }] },
    };

    const saveResult = await store.save("test-slot", {
      components,
      meta: {
        engineVersion: "0.1.0",
        timestamp: 1700000000,
        entityCount: 10,
        playerCount: 1,
      },
    });
    expect(saveResult.success).toBe(true);
    expect(saveResult.bytes).toBeGreaterThan(0);

    const loadResult = await store.load("test-slot");
    expect(loadResult.state).not.toBeNull();
    expect(loadResult.state!.components.world).toEqual(components.world);
    expect(loadResult.state!.components.players).toEqual(components.players);
  });

  it("returns null state for non-existent slot", async () => {
    const result = await store.load("nonexistent");
    expect(result.state).toBeNull();
  });

  it("rotates previous save to .bak on new save", async () => {
    const components = { world: { v: 1, data: { time: 0.1 } } };

    await store.save("rotate-test", {
      components,
      meta: { engineVersion: "0.1.0", timestamp: 1000, entityCount: 1, playerCount: 1 },
    });

    // Save again — should rotate first save to .bak
    await store.save("rotate-test", {
      components: { world: { v: 1, data: { time: 0.2 } } },
      meta: { engineVersion: "0.1.0", timestamp: 2000, entityCount: 1, playerCount: 1 },
    });

    // Load should get the latest save
    const result = await store.load("rotate-test");
    expect(result.state).not.toBeNull();
    expect((result.state!.components.world as any).data.time).toBe(0.2);
  });

  it("rotates blobs dir to .bak across repeated saves (no ENOTEMPTY)", async () => {
    const meta = { engineVersion: "0.1.0", timestamp: 1000, entityCount: 1, playerCount: 1 };
    const blobs = { tile: new ArrayBuffer(8) };

    // Save three times with blobs. The second save creates a .blobs.bak;
    // the third save must rotate the existing .blobs → .blobs.bak even though
    // .blobs.bak already exists and is non-empty (regression: previously
    // failed with ENOTEMPTY on Linux, leaving blobsDir in place and
    // breaking every subsequent autosave).
    for (let i = 0; i < 3; i++) {
      const r = await store.save(
        "blob-rotate",
        { components: { world: { v: 1, data: { n: i } } }, meta },
        { blobs },
      );
      expect(r.success).toBe(true);
    }

    // The latest blobs dir should exist and contain the blob
    const blobsDir = join(testDir, "blob-rotate.blobs");
    const files = await fs.readdir(blobsDir);
    expect(files).toContain("tile");

    // Load should return the latest state + blobs
    const result = await store.load("blob-rotate");
    expect(result.state).not.toBeNull();
    expect((result.state!.components.world as any).data.n).toBe(2);
    expect(result.blobs).toBeDefined();
    expect(result.blobs!.tile).toBeInstanceOf(ArrayBuffer);
  });

  it("falls back to .bak when primary is corrupted", async () => {
    const components = { world: { v: 1, data: { time: 0.5 } } };

    // Save twice to create a .bak
    await store.save("corrupt-test", {
      components,
      meta: { engineVersion: "0.1.0", timestamp: 1000, entityCount: 1, playerCount: 1 },
    });
    await store.save("corrupt-test", {
      components: { world: { v: 1, data: { time: 0.9 } } },
      meta: { engineVersion: "0.1.0", timestamp: 2000, entityCount: 1, playerCount: 1 },
    });

    // Corrupt the primary save file
    const savePath = join(testDir, "corrupt-test.ddsave");
    await fs.writeFile(savePath, new Uint8Array([0, 1, 2, 3]));

    // Should fall back to .bak
    const result = await store.load("corrupt-test");
    expect(result.state).not.toBeNull();
    expect((result.state!.components.world as any).data.time).toBe(0.5);
  });

  it("lists saves with metadata", async () => {
    await store.save("slot-a", {
      components: { world: { v: 1, data: {} } },
      meta: { engineVersion: "0.1.0", timestamp: 1000, entityCount: 5, playerCount: 1 },
    });
    await store.save("slot-b", {
      components: { world: { v: 1, data: {} } },
      meta: { engineVersion: "0.1.0", timestamp: 2000, entityCount: 10, playerCount: 2 },
    });

    const saves = await store.listSaves();
    expect(saves.length).toBe(2);
    // Sorted by timestamp descending
    expect(saves[0].slot).toBe("slot-b");
    expect(saves[0].entityCount).toBe(10);
    expect(saves[1].slot).toBe("slot-a");
    expect(saves[1].entityCount).toBe(5);
  });

  it("deletes save and backup", async () => {
    await store.save("delete-me", {
      components: { world: { v: 1, data: {} } },
      meta: { engineVersion: "0.1.0", timestamp: 1000, entityCount: 1, playerCount: 1 },
    });
    // Save again to create .bak
    await store.save("delete-me", {
      components: { world: { v: 1, data: {} } },
      meta: { engineVersion: "0.1.0", timestamp: 2000, entityCount: 1, playerCount: 1 },
    });

    const deleted = await store.deleteSave("delete-me");
    expect(deleted).toBe(true);

    const result = await store.load("delete-me");
    expect(result.state).toBeNull();
  });

  it("sanitizes slot names to prevent path traversal", async () => {
    await store.save("../../../etc/passwd", {
      components: { world: { v: 1, data: {} } },
      meta: { engineVersion: "0.1.0", timestamp: 1000, entityCount: 1, playerCount: 1 },
    });

    // The file should be in the save dir with sanitized name, not traversed
    const files = await fs.readdir(testDir);
    expect(files.some(f => f.includes("passwd"))).toBe(true);
    expect(files.some(f => f.includes(".."))).toBe(false);
  });

  it("emits warnings via callback", async () => {
    const warnings: any[] = [];
    store.onWarning((w) => warnings.push(w));

    // Load non-existent slot — should emit no_saves_found warning
    await store.load("no-such-slot");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some(w => w.kind === "no_saves_found")).toBe(true);
  });

  it("rejects forward-incompatible saves", async () => {
    // Create a store with engine version 0.2.0
    const futureStore = new FileSaveStore({
      saveDir: testDir,
      engineVersion: "0.2.0",
      compress: testCompress,
      decompress: testDecompress,
      hash128: testHash,
    });
    await futureStore.save("future-slot", {
      components: { world: { v: 1, data: {} } },
      meta: { engineVersion: "0.2.0", timestamp: 1000, entityCount: 1, playerCount: 1 },
    });

    // Try to load with the 0.1.0 store
    const warnings: any[] = [];
    store.onWarning((w) => warnings.push(w));
    const result = await store.load("future-slot");
    expect(result.state).toBeNull();
    expect(warnings.some(w => w.kind === "forward_incompatible")).toBe(true);
  });
});
