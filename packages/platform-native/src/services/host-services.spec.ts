// HostServices spec — exercises the services seam in both modes: inline
// (in-process impl) and worker (Bun Worker + RPC). Also covers the
// plugin-scoped facade.

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostServices, createInlineServices, scopeServicesForPlugin, type HostServices } from "./host-services";

const tmpRoot = mkdtempSync(join(tmpdir(), "dd-services-test-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const STATE = JSON.stringify({
  world: { v: 1, data: { tick: 42 } },
  player: { v: 1, data: { hp: 100 } },
});

function saveRoundTrip(api: ReturnType<typeof createInlineServices> | HostServices["api"]) {
  return async () => {
    expect(await api.saveGame("slot-a", STATE)).toBe(true);
    const loaded = await api.loadGame("slot-a");
    expect(JSON.parse(loaded!)).toEqual(JSON.parse(STATE));

    const saves = await api.listSaves();
    expect(saves.some((s) => s.slot === "slot-a")).toBe(true);

    await api.setProperties("slot-a", { label: "test" });
    expect(await api.getProperties("slot-a")).toMatchObject({ label: "test" });

    expect(await api.deleteSave("slot-a")).toBe(true);
    expect(await api.loadGame("slot-a")).toBeNull();
  };
}

describe("HostServices", () => {
  it("inline mode: save/load round-trip", async () => {
    const api = createInlineServices(() => {});
    await api.init({
      saveDir: join(tmpRoot, "inline-saves"),
      cacheDbPath: join(tmpRoot, "inline-cache.db"),
      engineVersion: "0.0.0-test",
    });
    await saveRoundTrip(api)();
    const entry = { settings: { quality: 2 }, sourceMtime: 1, sidecarMtime: 0, updatedAt: Date.now() };
    await api.importCacheSet("model.glb", entry);
    expect((await api.importCacheGet("model.glb"))?.settings).toEqual({ quality: 2 });
    await api.dispose();
  });

  it("worker mode: save/load round-trip over RPC", async () => {
    const svc: HostServices = await createHostServices({
      appId: `svc-test-${Date.now()}`,
      engineVersion: "0.0.0-test",
      mode: "worker",
    });
    // Point the worker's stores at the temp dir via a fresh init — the
    // factory already init'd with the appId's userData dir, so exercise the
    // real path instead of re-init: save/list/delete through the proxy.
    await saveRoundTrip(svc.api)();
    let warned = false;
    svc.onWarning(() => { warned = true; });
    await svc.dispose();
    expect(warned).toBe(false);
  });

  it("plugin scope: namespaces saves and hides host-only ops", async () => {
    const api = createInlineServices((w) => console.log("STORE WARNING:", w.kind, w.message));
    await api.init({
      saveDir: join(tmpRoot, "plugin-saves"),
      cacheDbPath: join(tmpRoot, "plugin-cache.db"),
      engineVersion: "0.0.0-test",
    });
    const plugin = scopeServicesForPlugin(api, "mymod");

    await plugin.saveGame("quicksave", STATE);
    // Raw API sees the namespaced slot; plugin sees its own view.
    const rawSaves = await api.listSaves();
    expect(rawSaves.some((s) => s.slot.startsWith("plugin-mymod--"))).toBe(true);
    expect((await plugin.listSaves()).some((s) => s.slot === "quicksave")).toBe(true);
    expect(await plugin.loadGame("quicksave")).not.toBeNull();
    expect(() => plugin.importCacheGet("x")).toThrow(/not available to plugins/);
    expect(() => plugin.init({} as any)).toThrow(/not available to plugins/);
    await api.dispose();
  });
});
