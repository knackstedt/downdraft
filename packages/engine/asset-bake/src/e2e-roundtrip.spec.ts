// E2E round-trip test: bake a real glTF → verify GLB has meshopt + basisu →
// feed KTX2 bytes through the runtime basisu codec → verify it transcodes.
//
// Run: bun test packages/engine/asset-bake/src/e2e-roundtrip.spec.ts

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bakeGltf } from "./bake-gltf";
import { resolveOptions } from "./config";

const REPO = join(import.meta.dir, "..", "..", "..", "..");
const MODEL_DIR = join(
  REPO,
  "games/to-the-ocean/src/assets/models/human/Universal Base Characters[Standard]/Hairstyles/Origin at 0/glTF (Godot)",
);
const MODEL = join(MODEL_DIR, "Eyebrows_Regular.gltf");

// MODEL lives in a separate game repo (games/ is gitignored) — skip when absent.
describe.skipIf(!existsSync(MODEL))("e2e: bake glTF round-trip", () => {
  it("bakes a real glTF into a GLB with meshopt + basisu extensions", async () => {
    const opts = resolveOptions();
    const log = (msg: string) => console.log(`  [e2e]${msg}`);
    const result = await bakeGltf(MODEL, opts, log);

    // Output is a GLB.
    expect(result.ext).toBe("glb");
    expect(result.mimeType).toBe("model/gltf-binary");
    expect(result.bytes.byteLength).toBeGreaterThan(0);
    expect(result.sourceSize).toBeGreaterThan(0);

    // Parse the GLB JSON chunk to verify extensions are present.
    const bytes = result.bytes;
    // GLB header: magic(4) + version(4) + length(4) = 12 bytes.
    const magic = new Uint8Array(bytes.buffer, bytes.byteOffset, 4);
    expect(String.fromCharCode(...magic)).toBe("glTF");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint32(4, true);
    expect(version).toBe(2);

    // First chunk: JSON. chunkLength(4) + chunkType(4) + data.
    const chunk0Len = view.getUint32(12, true);
    const chunk0Type = view.getUint32(16, true);
    expect(chunk0Type).toBe(0x4e4f534a); // "JSON"
    const jsonBytes = new Uint8Array(bytes.buffer, bytes.byteOffset + 20, chunk0Len);
    const jsonStr = new TextDecoder().decode(jsonBytes);
    const json = JSON.parse(jsonStr);

    console.log("  [e2e] extensions used:", json.extensionsUsed ?? []);
    console.log("  [e2e] extensions required:", json.extensionsRequired ?? []);
    console.log("  [e2e] textures:", json.textures?.length ?? 0);
    console.log("  [e2e] images:", json.images?.length ?? 0);
    console.log("  [e2e] bufferViews:", json.bufferViews?.length ?? 0);

    // meshopt compression should be present.
    expect(json.extensionsUsed).toContain("EXT_meshopt_compression");
    expect(json.extensionsRequired).toContain("EXT_meshopt_compression");

    // KHR_texture_basisu should be present (textures converted to KTX2).
    expect(json.extensionsUsed).toContain("KHR_texture_basisu");

    // Verify at least one texture has the basisu extension.
    const basisuTextures = (json.textures ?? []).filter(
      (t: any) => t.extensions?.["KHR_texture_basisu"],
    );
    expect(basisuTextures.length).toBeGreaterThan(0);

    // Find the KTX2 image bufferView and extract the bytes for runtime decode.
    const basisuTex = basisuTextures[0];
    const sourceIdx = basisuTex.extensions["KHR_texture_basisu"].source ?? basisuTex.source;
    const img = json.images[sourceIdx];
    expect(img.bufferView).toBeDefined();
    const bv = json.bufferViews[img.bufferView];
    console.log(`  [e2e] image bufferView: idx=${img.bufferView}, buffer=${bv.buffer}, byteOffset=${bv.byteOffset ?? 0}, byteLength=${bv.byteLength}`);

    // Find the BIN chunk (chunk type 0x004e4942 = "BIN\0").
    let binOffset = 20 + chunk0Len; // after JSON chunk
    const chunk1Len = view.getUint32(binOffset, true);
    const chunk1Type = view.getUint32(binOffset + 4, true);
    expect(chunk1Type).toBe(0x004e4942); // "BIN\0"
    const binStart = binOffset + 8;
    // The bufferView's byteOffset is relative to the start of its buffer.
    // In a GLB, buffer 0 is the BIN chunk data.
    const ktx2Start = binStart + (bv.byteOffset ?? 0);
    const ktx2Bytes = new Uint8Array(bytes.buffer, bytes.byteOffset + ktx2Start, bv.byteLength);

    // KTX2 12-byte file identifier: AB 4B 54 58 20 32 30 BB 0D 0A 1A 0A
    const ktx2Magic = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < ktx2Magic.length; i++) {
      expect(ktx2Bytes[i]).toBe(ktx2Magic[i]);
    }
    console.log("  [e2e] KTX2 bytes extracted:", ktx2Bytes.byteLength);

    // --- Runtime decode: feed KTX2 through the basisu codec ---
    const { createBasisuTextureCodec } = await import(
      "../../libraries/models/src/codecs/basisu-codec"
    );
    const codec = createBasisuTextureCodec();
    const decoded = await codec.decode({ data: ktx2Bytes, extension: {} });

    expect(decoded.width).toBeGreaterThan(0);
    expect(decoded.height).toBeGreaterThan(0);
    expect(decoded.format).toBe("rgba8unorm");
    expect(decoded.data.byteLength).toBeGreaterThan(0);
    // RGBA32: 4 bytes per pixel for the base mip level at least.
    expect(decoded.data.byteLength).toBeGreaterThanOrEqual(decoded.width * decoded.height * 4);
    console.log(
      `  [e2e] runtime transcode OK: ${decoded.width}x${decoded.height}, ` +
        `${decoded.data.byteLength} bytes, ${decoded.mipLevels} mip levels`,
    );
  }, 120000); // 2 min timeout — encoding is slow
});
