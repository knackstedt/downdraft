import {
  validatePluginManifest,
  type PluginManifest,
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
    for (const f of ["worker-js", "wasm", "quickjs"] as const) {
      const r = validatePluginManifest(
        validManifest({ format: f, entry: undefined, thread: f === "wasm" ? "own-worker" : "sim" }),
      );
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('requires an "entry"'))).toBe(true);
    }
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
