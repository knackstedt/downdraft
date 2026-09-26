import {
    flattenExtensions,
    validatePluginManifest,
    type PluginManifest
} from "./manifest";

function validManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "test-plugin",
    name: "Test Plugin",
    version: "1.0.0",
    engineVersion: "^0.1.0",
    game: "test-game",
    format: "worker-js",
    tier: "native",
    thread: "sim",
    entry: "./src/index.ts",
    permissions: ["ecs", "events"],
    ...overrides,
  };
}

describe("validatePluginManifest", () => {
  it("accepts a valid native worker-js manifest", () => {
    const r = validatePluginManifest(validManifest());
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.normalized?.id).toBe("test-plugin");
  });

  it("rejects non-object", () => {
    const r = validatePluginManifest("nope");
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("JSON object");
  });

  it("rejects bad id (not kebab-case)", () => {
    const r = validatePluginManifest(validManifest({ id: "Bad_ID" }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("kebab-case"))).toBe(true);
  });

  it("rejects bad version (not semver)", () => {
    const r = validatePluginManifest(validManifest({ version: "1.0" }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.startsWith("version:"))).toBe(true);
  });

  it("rejects bad engineVersion (not a range)", () => {
    const r = validatePluginManifest(validManifest({ engineVersion: "latest" }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.startsWith("engineVersion:"))).toBe(true);
  });

  it("accepts '*' engineVersion", () => {
    const r = validatePluginManifest(validManifest({ engineVersion: "*" }));
    expect(r.valid).toBe(true);
  });

  it("rejects unknown format", () => {
    const r = validatePluginManifest(validManifest({ format: "python" as any }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.startsWith("format:"))).toBe(true);
  });

  it("forces wasm → own-worker and reports the mismatch", () => {
    const r = validatePluginManifest(
      validManifest({ format: "wasm", thread: "sim", entry: "./scorer.wasm" }),
    );
    // The rule fires (error reported) because thread wasn't own-worker.
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("wasm") && e.includes("own-worker"))).toBe(true);
  });

  it("accepts wasm with own-worker and normalizes thread", () => {
    const r = validatePluginManifest(
      validManifest({ format: "wasm", thread: "own-worker", entry: "./scorer.wasm" }),
    );
    expect(r.valid).toBe(true);
    expect(r.normalized?.thread).toBe("own-worker");
  });

  it("data tier requires asset format + no permissions + no entry", () => {
    const r = validatePluginManifest(
      validManifest({
        tier: "data",
        format: "worker-js",
        permissions: ["events"],
        entry: "./x.ts",
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('tier "data" requires format "asset"'))).toBe(true);
    expect(r.errors.some((e) => e.includes("must not request permissions"))).toBe(true);
    expect(r.errors.some((e) => e.includes("must not declare an entry"))).toBe(true);
  });

  it("asset format requires data tier + assets section + no entry", () => {
    const r = validatePluginManifest(
      validManifest({ format: "asset", tier: "script" }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('format "asset" requires tier "data"'))).toBe(true);
    expect(r.errors.some((e) => e.includes('requires an "assets" section'))).toBe(true);
  });

  it("accepts a valid asset manifest", () => {
    const r = validatePluginManifest(
      validManifest({
        format: "asset",
        tier: "data",
        thread: "renderer",
        entry: undefined,
        permissions: undefined,
        assets: { files: { "tex/bronze": "./bronze.png" }, textures: ["./bronze.png"] },
      }),
    );
    expect(r.valid).toBe(true);
    expect(r.normalized?.assets?.files["tex/bronze"]).toBe("./bronze.png");
  });

  it("script tier rejects native-only permissions", () => {
    const r = validatePluginManifest(
      validManifest({ tier: "script", permissions: ["ecs", "sab", "events"] }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('tier "script" allows only'))).toBe(true);
  });

  it("script tier accepts script-allowed permissions", () => {
    const r = validatePluginManifest(
      validManifest({
        tier: "script",
        format: "quickjs",
        thread: "renderer",
        permissions: ["events", "state", "tick", "log"],
      }),
    );
    expect(r.valid).toBe(true);
  });

  it("code-bearing formats require an entry", () => {
    (["worker-js", "wasm", "quickjs"] as const).forEach((f) => {
      const r = validatePluginManifest(
        validManifest({ format: f, entry: undefined, thread: f === "wasm" ? "own-worker" : "sim" }),
      );
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('requires an "entry"'))).toBe(true);
    });
  });

  it("rejects non-array provides/requires/dependencies", () => {
    const r = validatePluginManifest(validManifest({ provides: "nope" as any }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.startsWith("provides:"))).toBe(true);
  });

  it("rejects bad assets.files values", () => {
    const r = validatePluginManifest(
      validManifest({
        format: "asset",
        tier: "data",
        thread: "renderer",
        entry: undefined,
        assets: { files: { bad: 123 as any } },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('assets.files["bad"]'))).toBe(true);
  });
});

// ── mod.json (pack) shape: logic + extensions ──

describe("mod.json packs", () => {
  /** A mod.json with logic + extensions. The legacy format/tier/thread fields
   *  are still required by validatePluginManifest (it validates both shapes);
   *  a pure mod.json game would set them to match the logic. */
  function modManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
    return {
      id: "test-mod",
      name: "Test Mod",
      version: "1.0.0",
      engineVersion: "^0.1.0",
      game: "test-game",
      format: "worker-js",
      tier: "native",
      thread: "sim",
      logic: {
        format: "worker-js",
        thread: "sim",
        entry: "./src/index.ts",
        permissions: ["ecs", "events", "physics", "assets"],
      },
      extensions: {
        assets: [
          { kind: "mesh", id: "test-mod:crate", path: "./assets/crate.glb" },
          { kind: "texture", id: "test-mod:paint", path: "./assets/paint.png" },
        ],
        maps: [{ kind: "map" as any, id: "test-mod:arena", path: "./maps/arena.json" }],
        physics: [{ kind: "physics" as any, id: "test-mod:phys", path: "./physics/global.json" }],
        shaders: {
          postfx: [{
            kind: "shader-postfx" as any, id: "test-mod:acid", name: "Acid",
            wgsl: "./shaders/acid.wgsl", layout: "cc", order: "stylized",
          }],
          materials: [{
            kind: "shader-material" as any, id: "test-mod:iridescent",
            wgsl: "./shaders/iridescent.wgsl", uniforms: 64,
          }],
        },
      },
      ...overrides,
    };
  }

  it("accepts a valid mod.json with logic + extensions", () => {
    const r = validatePluginManifest(modManifest());
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.normalized?.logic?.format).toBe("worker-js");
    expect(r.normalized?.extensions?.assets?.length).toBe(2);
    expect(r.normalized?.extensions?.shaders?.postfx?.length).toBe(1);
  });

  it("rejects a logic extension with a bad format", () => {
    const r = validatePluginManifest(
      modManifest({ logic: { format: "python" as any, thread: "sim", entry: "./x" } }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.startsWith("logic.format:"))).toBe(true);
  });

  it("rejects a logic extension missing entry", () => {
    const r = validatePluginManifest(
      modManifest({ logic: { format: "wasm", thread: "own-worker", entry: "" as any } }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.startsWith("logic.entry:"))).toBe(true);
  });

  it("rejects an asset extension with a bad kind", () => {
    const m = modManifest();
    m.extensions!.assets = [{ kind: "audio" as any, id: "x", path: "./x" }];
    const r = validatePluginManifest(m);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("extensions.assets[0].kind:"))).toBe(true);
  });

  it("rejects a postfx shader with a bad layout", () => {
    const m = modManifest();
    m.extensions!.shaders!.postfx = [{
      kind: "shader-postfx" as any, id: "x", name: "X", wgsl: "./x.wgsl",
      layout: "zz" as any, order: "stylized",
    }];
    const r = validatePluginManifest(m);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("extensions.shaders.postfx[0].layout:"))).toBe(true);
  });

  it("rejects a postfx shader with a bad order", () => {
    const m = modManifest();
    m.extensions!.shaders!.postfx = [{
      kind: "shader-postfx" as any, id: "x", name: "X", wgsl: "./x.wgsl",
      layout: "cc", order: "bogus" as any,
    }];
    const r = validatePluginManifest(m);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("extensions.shaders.postfx[0].order:"))).toBe(true);
  });

  it("rejects a map extension missing path", () => {
    const m = modManifest();
    m.extensions!.maps = [{ kind: "map" as any, id: "x", path: 123 as any }];
    const r = validatePluginManifest(m);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("extensions.maps[0].path:"))).toBe(true);
  });

  it("normalizes a legacy plugin.json into logic + extensions", () => {
    // A legacy worker-js manifest with no logic/extensions should get logic
    // populated by the normalizer.
    const r = validatePluginManifest(validManifest());
    expect(r.valid).toBe(true);
    expect(r.normalized?.logic).toBeDefined();
    expect(r.normalized?.logic?.format).toBe("worker-js");
    expect(r.normalized?.logic?.entry).toBe("./src/index.ts");
  });

  it("normalizes a legacy asset plugin.json into extensions.assets", () => {
    const r = validatePluginManifest(
      validManifest({
        format: "asset",
        tier: "data",
        thread: "renderer",
        entry: undefined,
        permissions: [],
        assets: {
          files: { "tex/crate": "./assets/crate.glb" },
          meshes: ["./assets/crate.glb"],
          textures: ["./assets/paint.png"],
        },
      }),
    );
    expect(r.valid).toBe(true);
    expect(r.normalized?.extensions?.assets?.length).toBe(2);
    expect(r.normalized?.extensions?.assets?.[0].kind).toBe("mesh");
    expect(r.normalized?.extensions?.assets?.[1].kind).toBe("texture");
    // No logic for a data-tier asset plugin.
    expect(r.normalized?.logic).toBeUndefined();
  });

  it("flattenExtensions returns extensions in stable bucket order", () => {
    const r = validatePluginManifest(modManifest());
    const flat = flattenExtensions(r.normalized!);
    const buckets = flat.map((f) => f.bucket);
    expect(buckets).toEqual([
      "assets", "assets",
      "maps",
      "physics",
      "shader-postfx",
      "shader-material",
    ]);
  });

  it("flattenExtensions returns [] for a manifest with no extensions", () => {
    const r = validatePluginManifest(validManifest({ extensions: undefined }));
    const flat = flattenExtensions(r.normalized!);
    expect(flat).toEqual([]);
  });
});
