// ============================================================================
// Benchmark: WASM (memory + IndexedDB) vs Native vs Rust Firebird save stores
// ============================================================================
//
// Run under Node+tsx (the native backend crashes Bun):
//   FIREBIRD_LOCK=/tmp/fb-$USER/lock FIREBIRD_TMP=/tmp/fb-$USER/tmp \
//     npx tsx packages/plugins/persistence/src/benchmark.ts
//
// Measures save + load latency across body sizes, plus export/import for
// cloud saves. Tests four configurations:
//   1. WASM memory://    — ephemeral, no persistence (reference baseline)
//   2. WASM IndexedDB    — with forced persist() after each save (fake-indexeddb polyfill)
//   3. Native .fdb       — node-firebird-native-api, real disk I/O
//   4. Rust .fdb         — rsfbclient NAPI addon, real disk I/O
//
// NOTE: The WASM+IndexedDB run uses fake-indexeddb (in-memory IndexedDB
// polyfill) because Node has no native IndexedDB. This means the WASM+IDB
// numbers include the full IndexedDB transaction + serialization overhead
// but NOT real disk I/O. In a real browser, IndexedDB writes to LevelDB
// on disk and would be slower. The Native and Rust backends write to real
// .fdb files with fsync.

// Set up IndexedDB polyfill before any WASM store imports use it.
import { indexedDB as fakeIDB, IDBKeyRange } from "fake-indexeddb";
globalThis.indexedDB = fakeIDB as unknown as IDBFactory;
globalThis.IDBKeyRange = IDBKeyRange as unknown as typeof IDBKeyRange;

import type { ISaveStore, SaveState } from "@downdraft/core/save/persist-types";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FirebirdBrowserSaveStore } from "./firebird-browser-save-store";
import { FirebirdRustSaveStore } from "./firebird-rust-save-store";
import { FirebirdSaveStore } from "./firebird-save-store";

// Use test compress/decompress (no zstd overhead — measures DB, not compression)
const noopCompress = (data: Uint8Array): Uint8Array => data;
const noopDecompress = (data: Uint8Array): Uint8Array => data;
const noopHash = (data: Uint8Array): Uint8Array => {
  const h = new Uint8Array(16);
  for (let i = 0; i < data.length; i++) h[i % 16] ^= data[i];
  return h;
};

interface BenchResult {
  label: string;
  bodySize: string;
  saveMs: number;
  loadMs: number;
  totalMs: number;
}

function makeState(bodySize: number): SaveState {
  const items = Math.max(1, Math.floor(bodySize / 50)); // ~50 bytes per item
  const data = new Array(items).fill(0).map((_, i) => ({
    id: i,
    name: `item-${i}`,
    pos: [i * 1.1, i * 2.2, i * 3.3],
    flags: i % 2 === 0,
  }));
  return {
    components: {
      world: { v: 1, data: { seed: 12345, time: 0.5 } },
      entities: { v: 1, data },
    },
    meta: { engineVersion: "0.1.0", timestamp: Date.now() / 1000, entityCount: items, playerCount: 1 },
  };
}

function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

async function benchStore(
  label: string,
  store: ISaveStore,
  bodySizes: number[],
  iterations: number,
  closeAfter: boolean = true,
  persistAfterSave: boolean = false,
): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  for (const bodySize of bodySizes) {
    const state = makeState(bodySize);
    const actualJson = JSON.stringify(state.components);
    const actualBytes = new TextEncoder().encode(actualJson).length;

    // Warmup
    await store.save("warmup", state);
    if (persistAfterSave) await (store as { persist?: () => Promise<void> }).persist?.();
    await store.load("warmup");

    let saveTotal = 0;
    let loadTotal = 0;
    for (let i = 0; i < iterations; i++) {
      const slot = `bench-${i}`;
      const t0 = performance.now();
      await store.save(slot, state);
      if (persistAfterSave) await (store as { persist?: () => Promise<void> }).persist?.();
      saveTotal += performance.now() - t0;

      const t1 = performance.now();
      await store.load(slot);
      loadTotal += performance.now() - t1;
    }

    const saveMs = saveTotal / iterations;
    const loadMs = loadTotal / iterations;
    results.push({
      label,
      bodySize: `${fmt(actualBytes)} JSON`,
      saveMs,
      loadMs,
      totalMs: saveMs + loadMs,
    });
    console.log(`  ${label} | ${fmt(actualBytes).padStart(7)} JSON | save ${saveMs.toFixed(1).padStart(7)}ms | load ${loadMs.toFixed(1).padStart(7)}ms | total ${(saveMs + loadMs).toFixed(1).padStart(7)}ms`);
  }
  if (closeAfter) await (store as { close?: () => Promise<void> }).close?.();
  return results;
}

async function main(): Promise<void> {
  const bodySizes = [1_000, 10_000, 100_000, 500_000, 1_000_000];
  const iterations = 5;
  const testDir = join(tmpdir(), `ddfb-bench-${Date.now()}`);
  await fs.mkdir(testDir, { recursive: true });

  console.log("\n=== Firebird Save Store Benchmark (4-way) ===\n");
  console.log(`Body sizes: ${bodySizes.map(fmt).join(", ")} (target JSON)`);
  console.log(`Iterations per size: ${iterations}`);
  console.log(`IndexedDB polyfill: fake-indexeddb (in-memory, no real disk I/O)\n`);

  // --- 1. WASM memory:// (ephemeral, no persistence — reference baseline) ---
  console.log("1. WASM memory:// (ephemeral, no persistence — reference):");
  const wasmMemStore = new FirebirdBrowserSaveStore({
    dbName: "memory://bench-mem",
    engineVersion: "0.1.0",
    compress: noopCompress,
    decompress: noopDecompress,
    hash128: noopHash,
    firebirdOptions: { autoPersist: false },
  });
  const wasmMemResults = await benchStore("WASM-mem", wasmMemStore, bodySizes, iterations, true);

  // --- 2. WASM IndexedDB (with forced persist after each save) ---
  console.log("\n2. WASM IndexedDB (forced persist() after each save):");
  const wasmIdbStore = new FirebirdBrowserSaveStore({
    dbName: `bench-idb-${Date.now()}`,
    engineVersion: "0.1.0",
    compress: noopCompress,
    decompress: noopDecompress,
    hash128: noopHash,
    firebirdOptions: { autoPersist: false },
  });
  const wasmIdbResults = await benchStore("WASM-idb", wasmIdbStore, bodySizes, iterations, false, true);

  // WASM IndexedDB cloud save export/import
  console.log("\n  WASM-IDB cloud save export/import:");
  const wasmIdbExportT0 = performance.now();
  const wasmIdbExported = await wasmIdbStore.exportDatabase();
  const wasmIdbExportMs = performance.now() - wasmIdbExportT0;
  console.log(`    exportDatabase: ${wasmIdbExportMs.toFixed(1)}ms (${fmt(wasmIdbExported.byteLength)})`);
  const wasmIdbImportT0 = performance.now();
  await wasmIdbStore.importDatabase(wasmIdbExported);
  const wasmIdbImportMs = performance.now() - wasmIdbImportT0;
  console.log(`    importDatabase: ${wasmIdbImportMs.toFixed(1)}ms`);
  const wasmIdbVerify = await wasmIdbStore.load("bench-0");
  console.log(`    post-import load: ${wasmIdbVerify.state ? "OK" : "FAIL"}`);
  await (wasmIdbStore as { close?: () => Promise<void> }).close?.();

  // --- 3. Native backend (FirebirdSaveStore, .fdb on disk) ---
  console.log("\n3. Native backend (FirebirdSaveStore, .fdb on disk, real fsync):");
  const nativeStore = new FirebirdSaveStore({
    dbPath: join(testDir, "bench-native.fdb"),
    engineVersion: "0.1.0",
    compress: noopCompress,
    decompress: noopDecompress,
    hash128: noopHash,
  });
  const nativeResults = await benchStore("Native  ", nativeStore, bodySizes, iterations);

  // --- 4. Rust backend (FirebirdRustSaveStore, .fdb on disk) ---
  console.log("\n4. Rust backend (FirebirdRustSaveStore, .fdb on disk, real fsync):");
  const rustStore = new FirebirdRustSaveStore({
    dbPath: join(testDir, "bench-rust.fdb"),
    engineVersion: "0.1.0",
    compress: noopCompress,
    decompress: noopDecompress,
    hash128: noopHash,
  });
  const rustResults = await benchStore("Rust    ", rustStore, bodySizes, iterations, false);

  // Rust cloud save export/import
  console.log("\n  Rust cloud save export/import:");
  const rustExportT0 = performance.now();
  const rustExported = await rustStore.exportDatabase();
  const rustExportMs = performance.now() - rustExportT0;
  console.log(`    exportDatabase: ${rustExportMs.toFixed(1)}ms (${fmt(rustExported.byteLength)})`);
  const rustImportT0 = performance.now();
  await rustStore.importDatabase(rustExported);
  const rustImportMs = performance.now() - rustImportT0;
  console.log(`    importDatabase: ${rustImportMs.toFixed(1)}ms`);
  const rustVerify = await rustStore.load("bench-0");
  console.log(`    post-import load: ${rustVerify.state ? "OK" : "FAIL"}`);
  await (rustStore as { close?: () => Promise<void> }).close?.();

  // --- Summary table ---
  console.log("\n=== Summary (4-way) ===\n");
  console.log("Size (JSON)    | W-mem save | W-idb save | Nat save | Rust save | W-mem load | W-idb load | Nat load | Rust load | W-mem total | W-idb total | Nat total | Rust total | W-idb/Nat | W-idb/Rust");
  console.log("-".repeat(175));
  for (let i = 0; i < wasmMemResults.length; i++) {
    const wm = wasmMemResults[i];
    const wi = wasmIdbResults[i];
    const n = nativeResults[i];
    const r = rustResults[i];
    const wiN = (wi.totalMs / n.totalMs).toFixed(1);
    const wiR = (wi.totalMs / r.totalMs).toFixed(1);
    console.log(
      `${wm.bodySize.padStart(13)} | ${wm.saveMs.toFixed(1).padStart(9)}ms | ${wi.saveMs.toFixed(1).padStart(9)}ms | ${n.saveMs.toFixed(1).padStart(7)}ms | ${r.saveMs.toFixed(1).padStart(8)}ms | ${wm.loadMs.toFixed(1).padStart(9)}ms | ${wi.loadMs.toFixed(1).padStart(9)}ms | ${n.loadMs.toFixed(1).padStart(7)}ms | ${r.loadMs.toFixed(1).padStart(8)}ms | ${wm.totalMs.toFixed(1).padStart(10)}ms | ${wi.totalMs.toFixed(1).padStart(10)}ms | ${n.totalMs.toFixed(1).padStart(8)}ms | ${r.totalMs.toFixed(1).padStart(9)}ms | ${wiN}x | ${wiR}x`,
    );
  }

  console.log(`\nCloud save (WASM-IDB): export ${wasmIdbExportMs.toFixed(1)}ms, import ${wasmIdbImportMs.toFixed(1)}ms (${fmt(wasmIdbExported.byteLength)})`);
  console.log(`Cloud save (Rust):     export ${rustExportMs.toFixed(1)}ms, import ${rustImportMs.toFixed(1)}ms (${fmt(rustExported.byteLength)})`);

  console.log("\nNOTE: WASM-IDB uses fake-indexeddb (in-memory). Real browser IndexedDB");
  console.log("      writes to LevelDB on disk and would be slower. Native and Rust");
  console.log("      backends write to real .fdb files with fsync.");

  await fs.rm(testDir, { recursive: true, force: true });
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("BENCH FAIL:", err);
  process.exit(1);
});
