import { describe, it, expect } from "bun:test";
import { parseDdmeta, writeDdmeta, createDefaultDdmeta } from "./ddmeta";
import { parseUnityMeta } from "./unity-meta";
import { parseGodotImport } from "./godot-import";
import { parseBlenderExtras } from "./blender-extras";
import { resolveImportSettingsSync } from "./resolver";
import { createDefaultImportSettings } from "./types";
import type { ModelData } from "../types";

describe("parseDdmeta", () => {
  it("parses a complete .ddmeta.json", () => {
    const json = `{
      // My model settings
      "upAxis": "z",
      "units": "centimeters",
      "scale": 0.5,
      "rotation": [0, 0, 0, 1],
      "centerToOrigin": true,
      "autoFit": 2.0,
      "nodeTransforms": "apply"
    }`;
    const result = parseDdmeta(json);
    expect(result).not.toBeNull();
    expect(result!.upAxis).toBe("z");
    expect(result!.units).toBe("centimeters");
    expect(result!.scale).toBe(0.5);
    expect(result!.rotation).toEqual([0, 0, 0, 1]);
    expect(result!.centerToOrigin).toBe(true);
    expect(result!.autoFit).toBe(2.0);
    expect(result!.nodeTransforms).toBe("apply");
  });

  it("parses a minimal .ddmeta.json with only scale", () => {
    const json = `{ "scale": 2.0 }`;
    const result = parseDdmeta(json);
    expect(result).not.toBeNull();
    expect(result!.scale).toBe(2.0);
    expect(result!.upAxis).toBeUndefined();
  });

  it("returns null for invalid JSON", () => {
    expect(parseDdmeta("not json")).toBeNull();
    expect(parseDdmeta("")).toBeNull();
  });

  it("handles autoFit: null", () => {
    const json = `{ "autoFit": null }`;
    const result = parseDdmeta(json);
    expect(result).not.toBeNull();
    expect(result!.autoFit).toBeNull();
  });

  it("ignores invalid upAxis values", () => {
    const json = `{ "upAxis": "x" }`;
    const result = parseDdmeta(json);
    expect(result).not.toBeNull();
    expect(result!.upAxis).toBeUndefined();
  });
});

describe("writeDdmeta", () => {
  it("round-trips through parse", () => {
    const settings = createDefaultImportSettings("z", "centimeters");
    settings.scale = 0.5;
    settings.centerToOrigin = true;
    settings.autoFit = 2.0;
    const written = writeDdmeta(settings);
    const parsed = parseDdmeta(written);
    expect(parsed).not.toBeNull();
    expect(parsed!.upAxis).toBe("z");
    expect(parsed!.units).toBe("centimeters");
    expect(parsed!.scale).toBe(0.5);
    expect(parsed!.centerToOrigin).toBe(true);
    expect(parsed!.autoFit).toBe(2.0);
  });
});

describe("createDefaultDdmeta", () => {
  it("generates a valid .ddmeta.json with comments", () => {
    const defaults = createDefaultImportSettings("y", "meters");
    const text = createDefaultDdmeta("character.fbx", defaults);
    // Should contain comments
    expect(text).toContain("//");
    // Should be parseable
    const parsed = parseDdmeta(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.upAxis).toBe("y");
    expect(parsed!.units).toBe("meters");
  });
});

describe("parseUnityMeta", () => {
  it("parses a Unity ModelImporter .meta file", () => {
    const meta = `fileFormatVersion: 2
guid: 1234567890abcdef
ModelImporter:
  serializedVersion: 22202
  scaleFactor: 0.01
  useFileUnits: 1
  meshCompression: 0`;
    const result = parseUnityMeta(meta);
    expect(result).not.toBeNull();
    expect(result!.scale).toBe(0.01);
    expect(result!.source).toBe("unity");
  });

  it("returns null for non-ModelImporter .meta files", () => {
    const meta = `fileFormatVersion: 2
guid: 1234567890abcdef
TextureImporter:
  serializedVersion: 22202`;
    expect(parseUnityMeta(meta)).toBeNull();
  });

  it("returns null if scaleFactor is missing", () => {
    const meta = `fileFormatVersion: 2
guid: 1234567890abcdef
ModelImporter:
  serializedVersion: 22202`;
    expect(parseUnityMeta(meta)).toBeNull();
  });
});

describe("parseGodotImport", () => {
  it("parses a Godot .import file with scale", () => {
    const importText = `[remap]
importer="scene"
type="PackedScene"
path="res://.import/character.gltf-abc.scn"

[params]
scale=1.0
`;
    const result = parseGodotImport(importText);
    expect(result).not.toBeNull();
    expect(result!.scale).toBe(1.0);
    expect(result!.source).toBe("godot");
  });

  it("parses a Godot .import file with rotation", () => {
    const importText = `[remap]
importer="scene"
type="PackedScene"

[params]
rotation=0,90,0
`;
    const result = parseGodotImport(importText);
    expect(result).not.toBeNull();
    expect(result!.rotation).toBeDefined();
    expect(result!.rotation!.length).toBe(4);
  });

  it("returns null for non-3D importers", () => {
    const importText = `[remap]
importer="texture"
type="Texture2D"

[params]
scale=1.0
`;
    expect(parseGodotImport(importText)).toBeNull();
  });

  it("returns null for files without [remap]", () => {
    expect(parseGodotImport("not an import file")).toBeNull();
  });
});

describe("parseBlenderExtras", () => {
  it("detects Z-up from YUP: false", () => {
    const extras = {
      glTF2ExportSettings: { YUP: false },
    };
    const result = parseBlenderExtras(extras);
    expect(result).not.toBeNull();
    expect(result!.upAxis).toBe("z");
    expect(result!.source).toBe("blender");
  });

  it("detects Y-up from YUP: true", () => {
    const extras = {
      glTF2ExportSettings: { YUP: true },
    };
    const result = parseBlenderExtras(extras);
    expect(result).not.toBeNull();
    expect(result!.upAxis).toBe("y");
  });

  it("returns null when no glTF2ExportSettings present", () => {
    expect(parseBlenderExtras({})).toBeNull();
    expect(parseBlenderExtras(undefined)).toBeNull();
  });

  it("returns null when YUP is not set", () => {
    const extras = {
      glTF2ExportSettings: { something: "else" },
    };
    expect(parseBlenderExtras(extras)).toBeNull();
  });
});

describe("resolveImportSettingsSync", () => {
  it("uses parser-detected defaults", () => {
    const modelData: ModelData = {
      meshes: [],
      name: "test",
      format: "fbx",
      sourceUpAxis: "z",
      sourceUnits: "centimeters",
    };
    const settings = resolveImportSettingsSync(modelData);
    expect(settings.upAxis).toBe("z");
    expect(settings.units).toBe("centimeters");
    expect(settings.scale).toBe(1.0);
    expect(settings.source).toBe("parser");
  });

  it("defaults to Y-up/meters when parser didn't detect", () => {
    const modelData: ModelData = {
      meshes: [],
      name: "test",
      format: "obj",
    };
    const settings = resolveImportSettingsSync(modelData);
    expect(settings.upAxis).toBe("y");
    expect(settings.units).toBe("meters");
  });
});
