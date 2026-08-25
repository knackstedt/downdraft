import type { SaveWarning } from "@downdraft/core/save/persist-types";
import { FirebirdBrowserSaveStore } from "./firebird-browser-save-store";

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

// Each test gets its own ephemeral memory:// database (no IndexedDB, no
// persistence between runs). The WASM engine loads once per process.
function newStore(engineVersion = "0.1.0"): FirebirdBrowserSaveStore {
  return new FirebirdBrowserSaveStore({
    dbName: `memory://test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    engineVersion,
    compress: testCompress,
    decompress: testDecompress,
    hash128: testHash,
    firebirdOptions: { autoPersist: false },
  });
}

describe("FirebirdBrowserSaveStore", () => {
  let store: FirebirdBrowserSaveStore;

  beforeEach(() => {
    store = newStore();
  });

  afterEach(async () => {
    await store.close().catch(() => undefined);
  });

  it("saves and loads a game state", async () => {
    const components = {
      world: { v: 1, data: { timeOfDay: 0.5, seed: 12345 } },
      players: { v: 1, data: [{ name: "TestPlayer" }] },
    };

    const saveResult = await store.save("test-slot", {
      components,
      meta: { engineVersion: "0.1.0", timestamp: 1700000000, entityCount: 10, playerCount: 1 },
    });
    expect(saveResult.success).toBe(true);
    expect(saveResult.bytes).toBeGreaterThan(0);

    const loadResult = await store.load("test-slot");
    expect(loadResult.state).not.toBeNull();
    expect(loadResult.state!.components.world).toEqual(components.world);
    expect(loadResult.state!.components.players).toEqual(components.players);
  });

  it("round-trips a large body through base64 BLOB storage", async () => {
    // ~256KB payload to exercise large base64 encoding + BLOB storage.
    const big = new Array(20000).fill(0).map((_, i) => ({ id: i, label: `item-${i}` }));
    const components = { inventory: { v: 1, data: big } };

    await store.save("big-slot", {
      components,
      meta: { engineVersion: "0.1.0", timestamp: 1, entityCount: big.length, playerCount: 1 },
    });

    const loadResult = await store.load("big-slot");
    expect(loadResult.state).not.toBeNull();
    const data = (loadResult.state!.components.inventory as { data: { id: number }[] }).data;
    expect(data.length).toBe(big.length);
    expect(data[1234].id).toBe(1234);
  });

  it("returns null state for non-existent slot", async () => {
    const result = await store.load("nonexistent");
    expect(result.state).toBeNull();
  });

  it("rotates previous save to backup on new save", async () => {
    await store.save("rotate-test", {
      components: { world: { v: 1, data: { time: 0.1 } } },
      meta: { engineVersion: "0.1.0", timestamp: 1000, entityCount: 1, playerCount: 1 },
    });
    await store.save("rotate-test", {
      components: { world: { v: 1, data: { time: 0.2 } } },
      meta: { engineVersion: "0.1.0", timestamp: 2000, entityCount: 1, playerCount: 1 },
    });
    const result = await store.load("rotate-test");
    expect(result.state).not.toBeNull();
    expect((result.state!.components.world as { data: { time: number } }).data.time).toBe(0.2);
  });

  it("falls back to backup when primary is corrupted", async () => {
    await store.save("corrupt-test", {
      components: { world: { v: 1, data: { time: 0.5 } } },
      meta: { engineVersion: "0.1.0", timestamp: 1000, entityCount: 1, playerCount: 1 },
    });
    await store.save("corrupt-test", {
      components: { world: { v: 1, data: { time: 0.9 } } },
      meta: { engineVersion: "0.1.0", timestamp: 2000, entityCount: 1, playerCount: 1 },
    });

    // Corrupt the primary (generation 0) body by overwriting its first chunk
    // with bad data that will fail hash verification on load.
    const raw = store as unknown as { db: { exec: (s: string) => Promise<unknown> } };
    await raw.db.exec(
      `UPDATE dd_save_chunks SET chunk_data = 'AAAA' WHERE slot = 'corrupt-test' AND generation = 0 AND chunk_idx = 0`,
    );

    const result = await store.load("corrupt-test");
    expect(result.state).not.toBeNull();
    expect((result.state!.components.world as { data: { time: number } }).data.time).toBe(0.5);
  });

  it("lists saves with metadata", async () => {
    // Use an isolated store so the list reflects only these two slots.
    const s = newStore();
    await s.save("slot-a", {
      components: { world: { v: 1, data: {} } },
      meta: { engineVersion: "0.1.0", timestamp: 1000, entityCount: 5, playerCount: 1 },
    });
    await s.save("slot-b", {
      components: { world: { v: 1, data: {} } },
      meta: { engineVersion: "0.1.0", timestamp: 2000, entityCount: 10, playerCount: 2 },
    });
    const saves = await s.listSaves();
    expect(saves.length).toBe(2);
    expect(saves[0].slot).toBe("slot-b");
    expect(saves[0].entityCount).toBe(10);
    expect(saves[1].slot).toBe("slot-a");
    expect(saves[1].entityCount).toBe(5);
    await s.close();
  });

  it("deletes save and backup", async () => {
    await store.save("delete-me", {
      components: { world: { v: 1, data: {} } },
      meta: { engineVersion: "0.1.0", timestamp: 1000, entityCount: 1, playerCount: 1 },
    });
    await store.save("delete-me", {
      components: { world: { v: 1, data: {} } },
      meta: { engineVersion: "0.1.0", timestamp: 2000, entityCount: 1, playerCount: 1 },
    });
    const deleted = await store.deleteSave("delete-me");
    expect(deleted).toBe(true);
    const result = await store.load("delete-me");
    expect(result.state).toBeNull();
  });

  it("sanitizes slot names", async () => {
    await store.save("../../../etc/passwd", {
      components: { world: { v: 1, data: { ok: true } } },
      meta: { engineVersion: "0.1.0", timestamp: 1000, entityCount: 1, playerCount: 1 },
    });
    const result = await store.load("../../../etc/passwd");
    expect(result.state).not.toBeNull();
    expect((result.state!.components.world as { data: { ok: boolean } }).data.ok).toBe(true);
  });

  it("emits warnings via callback", async () => {
    const warnings: SaveWarning[] = [];
    store.onWarning((w) => warnings.push(w));
    await store.load("no-such-slot");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.kind === "no_saves_found")).toBe(true);
  });

  it("rejects forward-incompatible saves", async () => {
    // Save with engine version 0.2.0, then load with a 0.1.0 store on the
    // same database. memory:// DBs are per-instance, so we reuse the same
    // store's DB by saving normally then swapping the version check: we
    // insert a metadata row directly with a high engine_version_packed and
    // a dummy body chunk, then load it with a 0.1.0 store.
    const older = newStore("0.1.0");
    // Ensure schema exists, then insert a row with engine_version_packed
    // for 0.2.0 (= packEngineVersion(0,2,0) = 8192).
    await older.save("dummy", {
      components: { world: { v: 1, data: {} } },
      meta: { engineVersion: "0.1.0", timestamp: 1, entityCount: 1, playerCount: 1 },
    });
    const raw = older as unknown as { db: { exec: (s: string) => Promise<unknown> } };
    // Overwrite the existing row's engine_version_packed to a future version.
    await raw.db.exec(
      `UPDATE dd_saves SET engine_version_packed = 8192 WHERE slot = 'dummy' AND generation = 0`,
    );
    const warnings: SaveWarning[] = [];
    older.onWarning((w) => warnings.push(w));
    const result = await older.load("dummy");
    expect(result.state).toBeNull();
    expect(warnings.some((w) => w.kind === "forward_incompatible")).toBe(true);
    await older.close();
  });
});
