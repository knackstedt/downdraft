import { AssetPluginLoader } from "@downdraft/core";
import type { AssetManager } from "@downdraft/core";
import { validatePluginManifest, type PluginManifest } from "@downdraft/core";

/** Minimal fake AssetManager for testing the loader. */
function makeFakeAssetManager(): AssetManager & {
  loaded: string[];
  searchPaths: string[];
} {
  const loaded: string[] = [];
  const searchPaths: string[] = [];
  return {
    loaded,
    searchPaths,
    addSearchPath(name: string, _basePath: string) {
      searchPaths.push(name);
    },
    removeSearchPath(name: string) {
      const i = searchPaths.indexOf(name);
      if (i >= 0) searchPaths.splice(i, 1);
      return true;
    },
    clearSearchPaths() {
      searchPaths.length = 0;
    },
    getSearchPaths() {
      return [];
    },
    resolveUriCandidates(uri: string) {
      return [uri];
    },
    registerLoader() {},
    registerCodec() {},
    getCodec() {
      return undefined;
    },
    async load(uri: string) {
      loaded.push(uri);
      return { uri };
    },
    loadWithProgress(uri: string) {
      loaded.push(uri);
      return Promise.resolve({ uri });
    },
    get(_uri: string) {
      return undefined;
    },
    isLoaded(_uri: string) {
      return false;
    },
    isLoading(_uri: string) {
      return false;
    },
    has(_uri: string) {
      return false;
    },
    async release(_uri: string) {},
    releaseSync(_uri: string) {},
    async unloadAll() {},
    getMemoryUsage() {
      return 0;
    },
    setMemoryBudget() {},
    setGlobalProgressCallback() {},
  } as unknown as AssetManager & { loaded: string[]; searchPaths: string[] };
}

const assetManifest: PluginManifest = {
  id: "overburden-crop-sprites-pack",
  name: "Crop Sprites Pack",
  version: "1.0.0",
  engineVersion: "^0.1.0",
  game: "downdraft-overburden",
  format: "asset",
  tier: "data",
  thread: "renderer",
  assets: {
    files: { "tex/golden-wheat": "./assets/golden-wheat.png" },
    textures: ["./assets/golden-wheat.png"],
    data: ["./assets/golden-wheat-crop.json"],
  },
};

describe("overburden-crop-sprites-pack plugin", () => {
  it("has a valid manifest", () => {
    const v = validatePluginManifest(assetManifest);
    expect(v.valid).toBe(true);
    expect(v.normalized?.format).toBe("asset");
    expect(v.normalized?.tier).toBe("data");
  });

  it("AssetPluginLoader registers a search path + loads declared assets", async () => {
    const am = makeFakeAssetManager();
    const loader = new AssetPluginLoader({
      assetManager: am,
      resolveBase: (_id, _source) => "/plugins/crop-sprites-pack",
    });
    const dispose = await loader.load(assetManifest, {} as any, { granted: new Set(), denied: [] });
    expect(am.searchPaths).toContain("plugin:overburden-crop-sprites-pack");
    // textures + data loaded
    expect(am.loaded).toContain("./assets/golden-wheat.png");
    expect(am.loaded).toContain("./assets/golden-wheat-crop.json");

    // Dispose removes the search path.
    dispose?.();
    expect(am.searchPaths).not.toContain("plugin:overburden-crop-sprites-pack");
  });
});
