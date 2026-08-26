// Node-runnable verification of FirebirdSaveStore (Bun's native-addon handling
// crashes on the firebird driver, so this runs under `node --test` instead).
// Run: node --test packages/plugins/persistence/src/firebird-save-store.node-test.ts
//
// NOTE: requires tsx/ts-node for TS. We instead import the compiled store via
// bun's transpile-free path is not available under node, so this file uses
// plain runtime imports that node can load through the project's tsconfig
// paths? Node can't run .ts directly. Use `bun run` for transpile but node
// runtime? Instead we rely on `node --import tsx` if available, else fall back
// to a JS version. Simplest: keep this in TS and run with `bun` is the thing
// that crashes. So we run with `npx tsx --test`.

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FirebirdSaveStore } from "./firebird-save-store";

const testCompress = (data: Uint8Array): Uint8Array => {
  const r = new Uint8Array(data.length + 1);
  r[0] = 0x42;
  r.set(data, 1);
  return r;
};
const testDecompress = (data: Uint8Array): Uint8Array => data.slice(1);
const testHash = (data: Uint8Array): Uint8Array => {
  const h = new Uint8Array(16);
  for (let i = 0; i < data.length; i++) h[i % 16] ^= data[i];
  return h;
};

async function newStore(dir: string, version = "0.1.0"): Promise<FirebirdSaveStore> {
  return new FirebirdSaveStore({
    dbPath: join(dir, "saves.fdb"),
    engineVersion: version,
    compress: testCompress,
    decompress: testDecompress,
    hash128: testHash,
  });
}

describe("FirebirdSaveStore (node)", () => {
  let testDir: string;
  let store: FirebirdSaveStore;

  it("saves and loads a game state", async () => {
    testDir = join(tmpdir(), `ddfb-node-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });
    store = await newStore(testDir);
    const components = {
      world: { v: 1, data: { timeOfDay: 0.5, seed: 12345 } },
      players: { v: 1, data: [{ name: "TestPlayer" }] },
    };
    const r = await store.save("test-slot", {
      components,
      meta: { engineVersion: "0.1.0", timestamp: 1700000000, entityCount: 10, playerCount: 1 },
    });
    assert.equal(r.success, true);
    assert.ok(r.bytes > 0);
    const loaded = await store.load("test-slot");
    assert.ok(loaded.state);
    assert.deepEqual(loaded.state!.components.world, components.world);
    assert.deepEqual(loaded.state!.components.players, components.players);
  });

  it("round-trips a large body through a BLOB", async () => {
    const big = new Array(20000).fill(0).map((_, i) => ({ id: i, label: `item-${i}` }));
    await store.save("big-slot", {
      components: { inventory: { v: 1, data: big } },
      meta: { engineVersion: "0.1.0", timestamp: 1, entityCount: big.length, playerCount: 1 },
    });
    const loaded = await store.load("big-slot");
    assert.ok(loaded.state);
    const data = (loaded.state!.components.inventory as { data: { id: number }[] }).data;
    assert.equal(data.length, big.length);
    assert.equal(data[1234].id, 1234);
  });

  it("returns null state for non-existent slot", async () => {
    const r = await store.load("nonexistent");
    assert.equal(r.state, null);
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
    const r = await store.load("rotate-test");
    assert.ok(r.state);
    assert.equal((r.state!.components.world as { data: { time: number } }).data.time, 0.2);
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
    // Corrupt the primary (generation 0) body via a raw store on the same DB.
    const raw = await newStore(testDir);
    await (raw as unknown as { db: { exec: (s: string, p: unknown[]) => Promise<void> } }).db.exec(
      `UPDATE dd_saves SET compressed_body = ? WHERE slot = ? AND generation = ?`,
      [Buffer.from([0xff, 0xff, 0xff, 0xff]), "corrupt-test", 0],
    );
    await raw.close();
    const r = await store.load("corrupt-test");
    assert.ok(r.state);
    assert.equal((r.state!.components.world as { data: { time: number } }).data.time, 0.5);
  });

  it("lists saves with metadata", async () => {
    // Use a fresh isolated store so the list reflects only these two slots.
    const dir = join(tmpdir(), `ddfb-node-list-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(dir, { recursive: true });
    const s = await newStore(dir);
    await s.save("slot-a", {
      components: { world: { v: 1, data: {} } },
      meta: { engineVersion: "0.1.0", timestamp: 1000, entityCount: 5, playerCount: 1 },
    });
    await s.save("slot-b", {
      components: { world: { v: 1, data: {} } },
      meta: { engineVersion: "0.1.0", timestamp: 2000, entityCount: 10, playerCount: 2 },
    });
    const saves = await s.listSaves();
    assert.equal(saves.length, 2);
    assert.equal(saves[0].slot, "slot-b");
    assert.equal(saves[0].entityCount, 10);
    assert.equal(saves[1].slot, "slot-a");
    assert.equal(saves[1].entityCount, 5);
    await s.close();
    await fs.rm(dir, { recursive: true, force: true });
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
    assert.equal(deleted, true);
    const r = await store.load("delete-me");
    assert.equal(r.state, null);
  });

  it("sanitizes slot names", async () => {
    await store.save("../../../etc/passwd", {
      components: { world: { v: 1, data: { ok: true } } },
      meta: { engineVersion: "0.1.0", timestamp: 1000, entityCount: 1, playerCount: 1 },
    });
    const r = await store.load("../../../etc/passwd");
    assert.ok(r.state);
    assert.equal((r.state!.components.world as { data: { ok: boolean } }).data.ok, true);
  });

  it("emits warnings via callback", async () => {
    const warnings: { kind: string }[] = [];
    store.onWarning((w) => warnings.push(w));
    await store.load("no-such-slot");
    assert.ok(warnings.length > 0);
    assert.ok(warnings.some((w) => w.kind === "no_saves_found"));
  });

  it("rejects forward-incompatible saves", async () => {
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
    await future.close();
    const older = new FirebirdSaveStore({
      dbPath: join(futureDir, "future.fdb"),
      engineVersion: "0.1.0",
      compress: testCompress,
      decompress: testDecompress,
      hash128: testHash,
    });
    const warnings: { kind: string }[] = [];
    older.onWarning((w) => warnings.push(w));
    const r = await older.load("future-slot");
    await older.close();
    assert.equal(r.state, null);
    assert.ok(warnings.some((w) => w.kind === "forward_incompatible"));
  });

  it("cleanup", async () => {
    await store.close();
    await fs.rm(testDir, { recursive: true, force: true });
  });
});
