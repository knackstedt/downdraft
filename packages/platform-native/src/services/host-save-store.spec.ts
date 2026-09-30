// HostSaveStore spec — the typed native save path. Verifies that a SaveState
// travels to FileSaveStore with no JSON round-trip and that real
// SaveResult/LoadResult metadata (bytes, gen, entityCount, timestamps) comes
// back — no JSON-string contract and no fabricated metadata.

import type { SaveState, SaveWarning } from "@downdraft/engine";
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostSaveStore } from "./host-save-store";
import { createInlineServices } from "./host-services";

const tmpRoot = mkdtempSync(join(tmpdir(), "dd-host-save-store-test-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const state: SaveState = {
  components: {
    world: { v: 1, data: { tick: 42, entities: [1, 2, 3] } },
    player: { v: 2, data: { hp: 100 } },
  },
  meta: {
    engineVersion: "0.4.0-test",
    timestamp: 1_700_000_000,
    entityCount: 7,
    playerCount: 2,
  },
};

describe("HostSaveStore", () => {
  it("save/load round-trip preserves real SaveResult + SaveMeta", async () => {
    // Host warning feed — HostSaveStore forwards warnings it receives via
    // subscribeWarnings to its own onWarning subscribers.
    const hostWarnings = new Set<(w: SaveWarning) => void>();
    const emitHostWarning = (w: SaveWarning) => hostWarnings.forEach((cb) => cb(w));
    const api = createInlineServices(emitHostWarning);
    await api.init({
      saveDir: join(tmpRoot, "saves"),
      cacheDbPath: join(tmpRoot, "cache.db"),
      engineVersion: "0.0.0-test",
    });
    const store = new HostSaveStore(api, (cb) => { hostWarnings.add(cb); });

    const sr = await store.save("slot-a", state);
    expect(sr.success).toBe(true);
    // Real metadata: non-zero byte count and generation (IpcSaveStore
    // hardcoded bytes: 0, gen: 1).
    expect(sr.bytes).toBeGreaterThan(0);
    expect(sr.gen).toBe(1);

    const lr = await store.load("slot-a");
    expect(lr.state?.components).toEqual(state.components);
    // SaveMeta survives the round trip.
    expect(lr.state?.meta.entityCount).toBe(7);
    expect(lr.state?.meta.playerCount).toBe(2);
    // The file header records the store's own packed engine version — it
    // reflects the engine that wrote the file, not the caller's string.
    expect(lr.state?.meta.engineVersion).toBe("0.0.0");
    expect(lr.state?.meta.timestamp).toBe(1_700_000_000);
    expect(lr.gen).toBe(1);

    // Second save succeeds (FileSaveStore is single-generation — gen stays 1;
    // the generational path is OPFS).
    const sr2 = await store.save("slot-a", state);
    expect(sr2.success).toBe(true);
    expect(sr2.gen).toBe(1);

    const infos = await store.listSaves();
    const info = infos.find((s) => s.slot === "slot-a");
    expect(info).toBeDefined();
    expect(info!.entityCount).toBe(7);
    expect(info!.fileSize).toBeGreaterThan(0);

    // Warning subscription forwards host warnings.
    const seen: SaveWarning[] = [];
    const unsub = store.onWarning((w) => seen.push(w));
    emitHostWarning({ kind: "corruption", slot: "slot-a", message: "hello" });
    expect(seen).toHaveLength(1);
    unsub();
    emitHostWarning({ kind: "backup_loaded", slot: "slot-a", message: "after unsub" });
    expect(seen).toHaveLength(1);

    expect(await store.deleteSave("slot-a")).toBe(true);
    expect((await store.load("slot-a")).state).toBeNull();
    await api.dispose();
  });
});
