import { AssetManager } from "./manager.ts";

describe("AssetManager", () => {
  it("should load assets via registered loader", async () => {
    const mgr = new AssetManager();
    mgr.registerLoader("txt", async (uri) => `data:${uri}`);
    const data = await mgr.load("test.txt");
    expect(data).toBe("data:test.txt");
  });

  it("should ref-count on repeated loads", async () => {
    const mgr = new AssetManager();
    let loadCount = 0;
    mgr.registerLoader("txt", async (uri) => {
      loadCount++;
      return `data:${uri}`;
    });
    await mgr.load("a.txt");
    await mgr.load("a.txt");
    expect(loadCount).toBe(1);
  });

  it("should release assets when refCount hits zero", async () => {
    const mgr = new AssetManager();
    mgr.registerLoader("txt", async (uri) => `data:${uri}`);
    await mgr.load("a.txt");
    expect(mgr.has("a.txt")).toBe(true);
    await mgr.release("a.txt");
    expect(mgr.has("a.txt")).toBe(false);
  });

  it("should queue loads and respect maxConcurrentLoads", async () => {
    const mgr = new AssetManager({ maxConcurrentLoads: 2 });
    let concurrent = 0;
    let maxConcurrent = 0;
    mgr.registerLoader("txt", async (uri) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent--;
      return `data:${uri}`;
    });

    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 6; i++) {
      promises.push(mgr.load(`file${i}.txt`));
    }
    await Promise.all(promises);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it("should prioritize critical loads over normal", async () => {
    const mgr = new AssetManager({ maxConcurrentLoads: 1 });
    const loadOrder: string[] = [];
    mgr.registerLoader("txt", async (uri) => {
      await new Promise((r) => setTimeout(r, 10));
      loadOrder.push(uri);
      return `data:${uri}`;
    });

    mgr.load("normal1.txt", "normal");
    mgr.load("normal2.txt", "normal");
    const criticalPromise = mgr.load("critical.txt", "critical");
    await Promise.all([
      mgr.load("normal1.txt", "normal"),
      mgr.load("normal2.txt", "normal"),
      criticalPromise,
    ]);

    const criticalIdx = loadOrder.indexOf("critical.txt");
    const normal2Idx = loadOrder.indexOf("normal2.txt");
    expect(criticalIdx).toBeGreaterThanOrEqual(0);
    expect(normal2Idx).toBeGreaterThanOrEqual(0);
    expect(criticalIdx).toBeLessThan(normal2Idx);
  });

  it("should coalesce duplicate concurrent loads", async () => {
    const mgr = new AssetManager({ maxConcurrentLoads: 1 });
    let loadCount = 0;
    mgr.registerLoader("txt", async (uri) => {
      loadCount++;
      await new Promise((r) => setTimeout(r, 20));
      return `data:${uri}`;
    });

    const [a, b, c] = await Promise.all([
      mgr.load("same.txt"),
      mgr.load("same.txt"),
      mgr.load("same.txt"),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(loadCount).toBe(1);
  });

  it("should enforce memory budget with LRU eviction", async () => {
    const mgr = new AssetManager({ memoryBudget: 100 });
    let destroyed: string[] = [];
    mgr.registerLoader(
      "bin",
      async (uri) => new ArrayBuffer(40),
      (data) => {
        destroyed.push(`destroyed:${(data as ArrayBuffer).byteLength}`);
      },
    );

    await mgr.load("a.bin");
    await mgr.release("a.bin");
    await mgr.load("b.bin");
    await mgr.release("b.bin");
    await mgr.load("c.bin");

    expect(mgr.getMemoryUsage()).toBeLessThanOrEqual(100);
    expect(destroyed.length).toBeGreaterThan(0);
  });

  it("should call destructor on release", async () => {
    const mgr = new AssetManager();
    let destroyed = false;
    mgr.registerLoader(
      "txt",
      async (uri) => `data:${uri}`,
      () => {
        destroyed = true;
      },
    );
    await mgr.load("a.txt");
    await mgr.release("a.txt");
    expect(destroyed).toBe(true);
  });

  it("should track loading state", async () => {
    const mgr = new AssetManager({ maxConcurrentLoads: 1 });
    mgr.registerLoader("txt", async (uri) => {
      await new Promise((r) => setTimeout(r, 30));
      return `data:${uri}`;
    });

    const promise = mgr.load("slow.txt");
    expect(mgr.isLoading("slow.txt")).toBe(true);
    await promise;
    expect(mgr.isLoading("slow.txt")).toBe(false);
    expect(mgr.isLoaded("slow.txt")).toBe(true);
  });

  it("should cancel queued loads", async () => {
    const mgr = new AssetManager({ maxConcurrentLoads: 1 });
    mgr.registerLoader("txt", async (uri) => {
      await new Promise((r) => setTimeout(r, 50));
      return `data:${uri}`;
    });

    const slowPromise = mgr.load("slow.txt");
    const queuedPromise = mgr.load("queued.txt").catch(() => "cancelled");
    expect(mgr.isQueued("queued.txt")).toBe(true);
    expect(mgr.cancelLoad("queued.txt")).toBe(true);
    expect(mgr.isQueued("queued.txt")).toBe(false);

    await slowPromise;
    const result = await queuedPromise;
    expect(result).toBe("cancelled");
  });

  it("should reprioritize queued loads", async () => {
    const mgr = new AssetManager({ maxConcurrentLoads: 1 });
    mgr.registerLoader("txt", async (uri) => {
      await new Promise((r) => setTimeout(r, 10));
      return `data:${uri}`;
    });

    mgr.load("a.txt", "normal");
    mgr.load("b.txt", "normal");
    expect(mgr.reprioritize("b.txt", "critical")).toBe(true);
    expect(mgr.reprioritize("nonexistent.txt", "critical")).toBe(false);
    await mgr.unloadAll();
  });

  it("should report load stats", async () => {
    const mgr = new AssetManager({ maxConcurrentLoads: 2 });
    mgr.registerLoader("txt", async (uri) => `data:${uri}`);
    await mgr.load("a.txt");
    await mgr.load("b.txt");
    const stats = mgr.getLoadStats();
    expect(stats.loaded).toBe(2);
    expect(stats.queued).toBe(0);
    expect(stats.loading).toBe(0);
  });

  it("should unload all assets", async () => {
    const mgr = new AssetManager();
    let destroyedCount = 0;
    mgr.registerLoader(
      "txt",
      async (uri) => `data:${uri}`,
      () => { destroyedCount++; },
    );
    await mgr.load("a.txt");
    await mgr.load("b.txt");
    await mgr.unloadAll();
    expect(mgr.has("a.txt")).toBe(false);
    expect(mgr.has("b.txt")).toBe(false);
    expect(destroyedCount).toBe(2);
    expect(mgr.getMemoryUsage()).toBe(0);
  });

  it("should handle loadWithProgress for already-loaded assets", async () => {
    const mgr = new AssetManager();
    mgr.registerLoader("txt", async (uri) => `data:${uri}`);
    await mgr.load("a.txt");
    const data = await mgr.loadWithProgress("a.txt");
    expect(data).toBe("data:a.txt");
  });

  it("should reject on missing loader", async () => {
    const mgr = new AssetManager();
    await expect(mgr.load("unknown.xyz")).rejects.toThrow();
  });

  it("should resolve URIs through search paths", async () => {
    const mgr = new AssetManager();
    const seenUris: string[] = [];
    mgr.registerLoader("txt", async (uri) => {
      seenUris.push(uri);
      return `data:${uri}`;
    });
    mgr.addSearchPath("engine", "/engine/resources/");
    mgr.addSearchPath("game", "/game/assets/");

    await mgr.load("fonts/doto.txt");
    expect(seenUris[0]).toBe("/game/assets/fonts/doto.txt");
  });

  it("should try later search paths when earlier ones fail", async () => {
    const mgr = new AssetManager();
    const seenUris: string[] = [];
    mgr.registerLoader("txt", async (uri) => {
      seenUris.push(uri);
      if (uri.includes("/game/assets/")) throw new Error("not found");
      return `data:${uri}`;
    });
    mgr.addSearchPath("engine", "/engine/resources/");
    mgr.addSearchPath("game", "/game/assets/");

    const data = await mgr.load("shaders/default.txt");
    expect(seenUris).toContain("/game/assets/shaders/default.txt");
    expect(seenUris).toContain("/engine/resources/shaders/default.txt");
    expect(data).toBe("data:/engine/resources/shaders/default.txt");
  });

  it("should pass absolute URIs through without search path resolution", async () => {
    const mgr = new AssetManager();
    const seenUris: string[] = [];
    mgr.registerLoader("txt", async (uri) => {
      seenUris.push(uri);
      return `data:${uri}`;
    });
    mgr.addSearchPath("game", "/game/assets/");

    await mgr.load("/absolute/path/file.txt");
    expect(seenUris).toEqual(["/absolute/path/file.txt"]);
  });

  it("should pass protocol URIs through without search path resolution", async () => {
    const mgr = new AssetManager();
    const seenUris: string[] = [];
    mgr.registerLoader("txt", async (uri) => {
      seenUris.push(uri);
      return `data:${uri}`;
    });
    mgr.addSearchPath("game", "/game/assets/");

    await mgr.load("https://example.com/file.txt");
    expect(seenUris).toEqual(["https://example.com/file.txt"]);
  });

  it("should resolveUriCandidates with last-added search path first", () => {
    const mgr = new AssetManager();
    mgr.addSearchPath("engine", "/engine/resources/");
    mgr.addSearchPath("game", "/game/assets/");

    const candidates = mgr.resolveUriCandidates("textures/sky.png");
    expect(candidates[0]).toBe("/game/assets/textures/sky.png");
    expect(candidates[1]).toBe("/engine/resources/textures/sky.png");
    expect(candidates[2]).toBe("textures/sky.png");
  });

  it("should remove search paths by name", () => {
    const mgr = new AssetManager();
    mgr.addSearchPath("engine", "/engine/resources/");
    mgr.addSearchPath("game", "/game/assets/");

    expect(mgr.removeSearchPath("engine")).toBe(true);
    expect(mgr.getSearchPaths()).toHaveLength(1);
    expect(mgr.getSearchPaths()[0].name).toBe("game");
    expect(mgr.removeSearchPath("nonexistent")).toBe(false);
  });

  it("should clear all search paths", () => {
    const mgr = new AssetManager();
    mgr.addSearchPath("engine", "/engine/resources/");
    mgr.addSearchPath("game", "/game/assets/");

    mgr.clearSearchPaths();
    expect(mgr.getSearchPaths()).toHaveLength(0);
    expect(mgr.resolveUriCandidates("file.txt")).toEqual(["file.txt"]);
  });

  it("should accept search paths via constructor options", () => {
    const mgr = new AssetManager({
      searchPaths: [
        { name: "engine", basePath: "/engine/resources/" },
        { name: "game", basePath: "/game/assets/" },
      ],
    });
    expect(mgr.getSearchPaths()).toHaveLength(2);
    const candidates = mgr.resolveUriCandidates("file.txt");
    expect(candidates[0]).toBe("/game/assets/file.txt");
    expect(candidates[1]).toBe("/engine/resources/file.txt");
  });

  it("should replace search path when adding with same name", () => {
    const mgr = new AssetManager();
    mgr.addSearchPath("game", "/old/path/");
    mgr.addSearchPath("game", "/new/path/");

    expect(mgr.getSearchPaths()).toHaveLength(1);
    expect(mgr.getSearchPaths()[0].basePath).toBe("/new/path/");
  });

  it("should normalize base paths to end with /", () => {
    const mgr = new AssetManager();
    mgr.addSearchPath("game", "/game/assets");
    expect(mgr.getSearchPaths()[0].basePath).toBe("/game/assets/");
  });

  it("should cache by logical URI, not resolved path", async () => {
    const mgr = new AssetManager();
    let loadCount = 0;
    mgr.registerLoader("txt", async (uri) => {
      loadCount++;
      return `data:${uri}`;
    });
    mgr.addSearchPath("game", "/game/assets/");

    await mgr.load("file.txt");
    await mgr.load("file.txt");
    expect(loadCount).toBe(1);
    expect(mgr.has("file.txt")).toBe(true);
  });
});
