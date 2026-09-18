import { WorkshopFetcher, type WorkshopSource } from "./workshop";
import type { BlobStore } from "../assets/blob-store";

/** In-memory BlobStore for tests. */
function makeMemoryStore(files: Record<string, string>): BlobStore {
  const store: BlobStore = {
    async get(key) {
      const v = files[key];
      if (v === undefined) throw new Error(`not found: ${key}`);
      return new TextEncoder().encode(v);
    },
    async put(_key, _data) {},
    async delete(_key) {},
    async list() {
      return { objects: [], truncated: false };
    },
  };
  return store;
}

describe("WorkshopFetcher", () => {
  it("fetches + validates a plugin pack from a workshop manifest", async () => {
    const pluginJson = JSON.stringify({
      id: "test-asset-pack",
      name: "Test Asset Pack",
      version: "1.0.0",
      engineVersion: "^0.1.0",
      game: "test-game",
      format: "asset",
      tier: "data",
      thread: "renderer",
      assets: { files: { "tex/test": "./test.png" }, textures: ["./test.png"] },
    });
    const manifest = JSON.stringify({
      version: "1.0.0",
      packs: [],
      stores: {},
      plugins: [
        { id: "test-asset-pack", version: "1.0.0", store: "mem", path: "plugins/test-asset-pack" },
      ],
    });
    const store = makeMemoryStore({
      "workshop.json": manifest,
      "plugins/test-asset-pack/plugin.json": pluginJson,
    });
    const source: WorkshopSource = { store, manifestKey: "workshop.json" };
    const fetcher = new WorkshopFetcher({ cacheDir: "/tmp/test-cache" });
    fetcher.addSource(source);
    const result = await fetcher.fetchAll();
    expect(result.errors).toEqual([]);
    expect(result.manifests.length).toBe(1);
    expect(result.manifests[0].manifest.id).toBe("test-asset-pack");
    expect(result.manifests[0].manifest.format).toBe("asset");
    expect(result.manifests[0].cachePath).toBe("/tmp/test-cache/test-asset-pack@1.0.0");
  });

  it("rejects a plugin whose manifest id doesn't match the entry id", async () => {
    const pluginJson = JSON.stringify({
      id: "wrong-id",
      name: "Wrong",
      version: "1.0.0",
      engineVersion: "^0.1.0",
      game: "test-game",
      format: "asset",
      tier: "data",
      thread: "renderer",
      assets: { files: {} },
    });
    const manifest = JSON.stringify({
      version: "1.0.0",
      packs: [],
      stores: {},
      plugins: [{ id: "entry-id", version: "1.0.0", store: "mem", path: "p" }],
    });
    const store = makeMemoryStore({
      "workshop.json": manifest,
      "p/plugin.json": pluginJson,
    });
    const fetcher = new WorkshopFetcher({ cacheDir: "/tmp" });
    fetcher.addSource({ store, manifestKey: "workshop.json" });
    const result = await fetcher.fetchAll();
    expect(result.manifests.length).toBe(0);
    expect(result.errors[0].id).toBe("entry-id");
    expect(result.errors[0].error).toContain("does not match");
  });

  it("skips packs not in the subscription list", async () => {
    const pluginJson = JSON.stringify({
      id: "subscribed",
      name: "Sub",
      version: "1.0.0",
      engineVersion: "^0.1.0",
      game: "test-game",
      format: "asset",
      tier: "data",
      thread: "renderer",
      assets: { files: {} },
    });
    const pluginJson2 = JSON.stringify({
      id: "not-subscribed",
      name: "NotSub",
      version: "1.0.0",
      engineVersion: "^0.1.0",
      game: "test-game",
      format: "asset",
      tier: "data",
      thread: "renderer",
      assets: { files: {} },
    });
    const manifest = JSON.stringify({
      version: "1.0.0",
      packs: [],
      stores: {},
      plugins: [
        { id: "subscribed", version: "1.0.0", store: "mem", path: "a" },
        { id: "not-subscribed", version: "1.0.0", store: "mem", path: "b" },
      ],
    });
    const store = makeMemoryStore({
      "workshop.json": manifest,
      "a/plugin.json": pluginJson,
      "b/plugin.json": pluginJson2,
    });
    let subs = ["subscribed"];
    const fetcher = new WorkshopFetcher({
      cacheDir: "/tmp",
      loadSubscriptions: async () => subs,
      saveSubscriptions: async (ids) => { subs = ids; },
    });
    fetcher.addSource({ store, manifestKey: "workshop.json" });
    const result = await fetcher.fetchAll();
    expect(result.manifests.length).toBe(1);
    expect(result.manifests[0].manifest.id).toBe("subscribed");
  });

  it("handles a missing workshop manifest gracefully", async () => {
    const store = makeMemoryStore({});
    const fetcher = new WorkshopFetcher({ cacheDir: "/tmp" });
    fetcher.addSource({ store, manifestKey: "missing.json" });
    const result = await fetcher.fetchAll();
    expect(result.manifests).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("subscribe/unsubscribe updates the persisted list", async () => {
    let subs: string[] = [];
    const fetcher = new WorkshopFetcher({
      cacheDir: "/tmp",
      loadSubscriptions: async () => subs,
      saveSubscriptions: async (ids) => { subs = ids; },
    });
    await fetcher.subscribe("a");
    await fetcher.subscribe("b");
    await fetcher.subscribe("a"); // dedup
    expect(subs).toEqual(["a", "b"]);
    await fetcher.unsubscribe("a");
    expect(subs).toEqual(["b"]);
  });
});
