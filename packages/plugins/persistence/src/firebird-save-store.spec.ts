import type { SaveWarning } from "@downdraft/core/save/persist-types";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FirebirdSaveStore } from "./firebird-save-store";

// NOTE: firebird-wasm's Node native backend (node-firebird-driver-native, which
// dlopens libfbclient and uses pthreads) crashes Bun's test runner with a
// native segfault during DB operations. The store logic is verified under Node
// instead — see firebird-save-store.node-test.ts, run with:
//   FIREBIRD_LOCK=/tmp/fb-$USER/lock FIREBIRD_TMP=/tmp/fb-$USER/tmp \
//     npx tsx --test packages/plugins/persistence/src/firebird-save-store.node-test.ts
// Under Bun this suite is skipped.
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const describeMaybe = isBun ? describe.skip : describe;

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

// Each test gets its own .fdb in a fresh tmp dir. firebird-wasm creates the
// database file on first connect.
async function newStore(testDir: string, engineVersion = "0.1.0"): Promise<FirebirdSaveStore> {
  const store = new FirebirdSaveStore({
    dbPath: join(testDir, "saves.fdb"),
    engineVersion,
    compress: testCompress,
    decompress: testDecompress,
    hash128: testHash,
  });
  return store;
}

describeMaybe("FirebirdSaveStore", () => {
  let testDir: string;
  let store: FirebirdSaveStore;

  beforeEach(async () => {
    testDir = join(tmpdir(), `ddfb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });
    store = await newStore(testDir);
  });

  afterEach(async () => {
    await store.close().catch(() => undefined);
    await fs.rm(testDir, { recursive: true, force: true });
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

  it("round-trips a large body through a BLOB", async () => {
    // ~256KB payload to exercise multi-segment BLOB reads (64KB segments).
    const big = new Array(20000).fill(0).map((_, i) => ({ id: i, label: `item-${i}` }));
    const components = { inventory: { v: 1, data: big } };

    await store.save("big-slot", {
      components,
      meta: { engineVersion: "0.1.0", timestamp: 1, entityCount: big.length, playerCount: 1 },
    });

    const loadResult = await store.load("big-slot");
    expect(loadResult.state).not.toBeNull();
    expect((loadResult.state!.components.inventory as { data: unknown[] }).data.length).toBe(big.length);
    expect((loadResult.state!.components.inventory as { data: { id: number }[] }).data[1234].id).toBe(1234);
  });

  it("returns null state for non-existent slot", async () => {
    const result = await store.load("nonexistent");
    expect(result.state).toBeNull();
  });

  it("rotates previous save to backup on new save", async () => {
    const components = { world: { v: 1, data: { time: 0.1 } } };

    await store.save("rotate-test", {
      components,
      meta: { engineVersion: "0.1.0", timestamp: 1000, entityCount: 1, playerCount: 1 },
    });

    // Save again — should rotate first save to backup (generation 1)
    await store.save("rotate-test", {
      components: { world: { v: 1, data: { time: 0.2 } } },
      meta: { engineVersion: "0.1.0", timestamp: 2000, entityCount: 1, playerCount: 1 },
    });

    // Load should get the latest save
    const result = await store.load("rotate-test");
    expect(result.state).not.toBeNull();
    expect((result.state!.components.world as { data: { time: number } }).data.time).toBe(0.2);
  });

  it("falls back to backup when primary is corrupted", async () => {
    const components = { world: { v: 1, data: { time: 0.5 } } };

    // Save twice to create a backup (generation 1)
    await store.save("corrupt-test", {
      components,
      meta: { engineVersion: "0.1.0", timestamp: 1000, entityCount: 1, playerCount: 1 },
    });
    await store.save("corrupt-test", {
      components: { world: { v: 1, data: { time: 0.9 } } },
      meta: { engineVersion: "0.1.0", timestamp: 2000, entityCount: 1, playerCount: 1 },
    });

    // Corrupt the primary (generation 0) body by writing a bad row directly
    // through a second store pointing at the same DB. We overwrite the
    // compressed_body BLOB with bytes that fail hash verification.
    const raw = new FirebirdSaveStore({
      dbPath: join(testDir, "saves.fdb"),
      engineVersion: "0.1.0",
      compress: testCompress,
      decompress: testDecompress,
      hash128: testHash,
    });
    // Insert a generation-0 row whose body won't match the stored hash.
    await (raw as unknown as { db: { exec: (s: string, p: unknown[]) => Promise<void> } }).db.exec(
      `UPDATE dd_saves SET compressed_body = ? WHERE slot = ? AND generation = ?`,
      [Buffer.from([0xff, 0xff, 0xff, 0xff]), "corrupt-test", 0],
    );
    await raw.close().catch(() => undefined);

    // Should fall back to backup (time 0.5)
    const result = await store.load("corrupt-test");
    expect(result.state).not.toBeNull();
    expect((result.state!.components.world as { data: { time: number } }).data.time).toBe(0.5);
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
    // Save again to create a backup generation
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
    // Path traversal characters are sanitized; the slot is still stored and
    // loadable by the same (sanitized) key the store uses internally.
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
    // Use a distinct DB so the 0.1.0 store doesn't share its schema/data.
    const futureDir = join(testDir, "future");
    await fs.mkdir(futureDir, { recursive: true });
    const future = new FirebirdSaveStore({
      dbPath: join(futureDir, "future.fdb"),
      engineVersion: "0.2.0",
      compress: testCompress,
      decompress: testDecompress,
      hash128: testHash,
    });
    await future.save("future-slot", {
      components: { world: { v: 1, data: {} } },
      meta: { engineVersion: "0.2.0", timestamp: 1000, entityCount: 1, playerCount: 1 },
    });
    await future.close().catch(() => undefined);

    // Open a 0.1.0 store against the future DB and try to load.
    const older = new FirebirdSaveStore({
      dbPath: join(futureDir, "future.fdb"),
      engineVersion: "0.1.0",
      compress: testCompress,
      decompress: testDecompress,
      hash128: testHash,
    });
    const warnings: SaveWarning[] = [];
    older.onWarning((w) => warnings.push(w));
    const result = await older.load("future-slot");
    await older.close().catch(() => undefined);
    expect(result.state).toBeNull();
    expect(warnings.some((w) => w.kind === "forward_incompatible")).toBe(true);
  });
});
