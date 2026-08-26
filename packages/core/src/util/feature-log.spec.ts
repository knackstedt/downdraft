// ============================================================================
// feature-log.spec.ts — encoder/decoder + schema stability tests
// ============================================================================
import { describe, expect, it } from "bun:test";
import {
  FEATURE_LOG_SCHEMA_VERSION,
  type FeatureLogData,
  condenseText,
  decodeFeatureLogLine,
  encodeFeatureLogJSON,
  encodeFeatureLogLine,
  encodeFeatureLogLines,
  encodeFeatures,
  featureCode,
  formatBytesShort,
} from "./feature-log";

const MAIN: FeatureLogData = {
  sv: FEATURE_LOG_SCHEMA_VERSION,
  scope: "main",
  v: "0.1.0",
  mode: "dev",
  os: "linux",
  osRel: "6.8.0-30-generic",
  arch: "x64",
  cpu: "AMD Ryzen 9 7950X",
  cpuCores: 16,
  mem: "64G",
  el: "31.6.0",
  chr: "126.0",
  node: "20.11.0",
  v8: "12.4.0",
  gpu: "NVIDIA RTX 4090",
  drv: "535.104",
  sw: "swiftshader,vulkan",
};

const RENDER: FeatureLogData = {
  sv: FEATURE_LOG_SCHEMA_VERSION,
  scope: "render",
  v: "0.1.0",
  mode: "dev",
  wgpu: "vendor=nvidia;dev=RTX 4090;fmt=bgra8unorm;feat=tsq,bc;lim=2d=16384",
  disp: "3840x2160@144",
  sf: 1,
  sab: 1,
  coi: 1,
  wk: "ok",
  plug: "physics-rapier,water,sand",
};

describe("encodeFeatureLogLine", () => {
  it("starts with dd<sv> prefix", () => {
    expect(encodeFeatureLogLine(MAIN).startsWith(`dd${FEATURE_LOG_SCHEMA_VERSION}|`)).toBe(true);
  });

  it("emits keys in the fixed key order", () => {
    const line = encodeFeatureLogLine(MAIN);
    const keys = line.split("|").slice(1).map((p) => p.split("=")[0]);
    // Fixed-order prefix for the fields present in MAIN.
    expect(keys).toEqual([
      "sv", "scope", "v", "mode", "os", "osRel", "arch", "cpu", "cpuCores",
      "mem", "el", "chr", "node", "v8", "gpu", "drv", "sw",
    ]);
  });

  it("omits absent optional fields", () => {
    const line = encodeFeatureLogLine(RENDER);
    // main-only fields are absent on the render line.
    expect(line).not.toContain("os=");
    expect(line).not.toContain("cpu=");
    expect(line).not.toContain("el=");
    // render-only fields are present.
    expect(line).toContain("wgpu=");
    expect(line).toContain("plug=");
  });

  it("is stable: same data -> same string", () => {
    expect(encodeFeatureLogLine(MAIN)).toBe(encodeFeatureLogLine(MAIN));
  });
});

describe("decodeFeatureLogLine", () => {
  it("round-trips a main line", () => {
    const line = encodeFeatureLogLine(MAIN);
    const decoded = decodeFeatureLogLine(line);
    expect(decoded).not.toBeNull();
    expect(decoded!.sv).toBe(FEATURE_LOG_SCHEMA_VERSION);
    expect(decoded!.scope).toBe("main");
    expect(decoded!.v).toBe("0.1.0");
    expect(decoded!.os).toBe("linux");
    expect(decoded!.cpuCores).toBe(16);
  });

  it("round-trips a render line", () => {
    const line = encodeFeatureLogLine(RENDER);
    const decoded = decodeFeatureLogLine(line);
    expect(decoded).not.toBeNull();
    expect(decoded!.scope).toBe("render");
    expect(decoded!.sab).toBe(1);
    expect(decoded!.sf).toBe(1);
  });

  it("returns null for non-feature-log lines", () => {
    expect(decodeFeatureLogLine("hello world")).toBeNull();
    expect(decodeFeatureLogLine("[GameRenderer] GPU timer pool supported")).toBeNull();
  });

  it("ignores unknown trailing keys (forward-compatible)", () => {
    const line = encodeFeatureLogLine(MAIN) + "|futureKey=xyz|another=1";
    const decoded = decodeFeatureLogLine(line);
    expect(decoded).not.toBeNull();
    // Known fields still parse.
    expect(decoded!.v).toBe("0.1.0");
    expect(decoded!.os).toBe("linux");
  });
});

describe("encodeFeatureLogLines", () => {
  it("joins main + render with newline", () => {
    const joined = encodeFeatureLogLines(MAIN, RENDER);
    const lines = joined.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith("dd1|")).toBe(true);
    expect(lines[1].startsWith("dd1|")).toBe(true);
    expect(lines[0]).toContain("scope=main");
    expect(lines[1]).toContain("scope=render");
  });

  it("handles null halves", () => {
    expect(encodeFeatureLogLines(null, RENDER)).toBe(encodeFeatureLogLine(RENDER));
    expect(encodeFeatureLogLines(MAIN, null)).toBe(encodeFeatureLogLine(MAIN));
    expect(encodeFeatureLogLines(null, null)).toBe("");
  });
});

describe("encodeFeatureLogJSON", () => {
  it("produces minified JSON", () => {
    const json = encodeFeatureLogJSON(MAIN);
    expect(JSON.parse(json).scope).toBe("main");
    expect(json).not.toContain("\n");
  });
});

describe("helpers", () => {
  it("condenseText trims and caps", () => {
    expect(condenseText("  AMD   Ryzen 9  ")).toBe("AMD Ryzen 9");
    const long = "x".repeat(100);
    expect(condenseText(long, 10).length).toBe(10);
    expect(condenseText(long, 10).endsWith("\u2026")).toBe(true);
  });

  it("formatBytesShort renders human units", () => {
    expect(formatBytesShort(0)).toBe("0");
    expect(formatBytesShort(1024)).toBe("1K");
    expect(formatBytesShort(68719476736)).toBe("64G");
    expect(formatBytesShort(1073741824)).toBe("1G");
  });

  it("featureCode maps known features to short codes", () => {
    expect(featureCode("timestamp-query")).toBe("tsq");
    expect(featureCode("texture-compression-bc")).toBe("bc");
    // Unknown features fall back to the raw name.
    expect(featureCode("some-future-feature")).toBe("some-future-feature");
  });

  it("encodeFeatures joins codes with commas", () => {
    expect(encodeFeatures(["timestamp-query", "texture-compression-bc"])).toBe("tsq,bc");
    expect(encodeFeatures([])).toBe("");
  });
});

describe("schema stability", () => {
  it("FEATURE_LOG_SCHEMA_VERSION is 1", () => {
    expect(FEATURE_LOG_SCHEMA_VERSION).toBe(1);
  });

  it("a golden main line is byte-stable", () => {
    // Snapshot guard: if the encoder changes field order or formatting, this
    // breaks loudly. Update intentionally when appending fields.
    const line = encodeFeatureLogLine(MAIN);
    expect(line).toBe(
      "dd1|sv=1|scope=main|v=0.1.0|mode=dev|os=linux|osRel=6.8.0-30-generic|arch=x64|cpu=AMD Ryzen 9 7950X|cpuCores=16|mem=64G|el=31.6.0|chr=126.0|node=20.11.0|v8=12.4.0|gpu=NVIDIA RTX 4090|drv=535.104|sw=swiftshader,vulkan",
    );
  });

  it("a golden render line is byte-stable", () => {
    const line = encodeFeatureLogLine(RENDER);
    expect(line).toBe(
      "dd1|sv=1|scope=render|v=0.1.0|mode=dev|wgpu=vendor=nvidia;dev=RTX 4090;fmt=bgra8unorm;feat=tsq,bc;lim=2d=16384|disp=3840x2160@144|sf=1|sab=1|coi=1|wk=ok|plug=physics-rapier,water,sand",
    );
  });
});
