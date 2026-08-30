// ============================================================================
// bake-gltf.ts — glTF/GLB → meshopt-compressed GLB with Basis KTX2 textures.
// ============================================================================
//
// Pipeline (via @gltf-transform):
//   1. dedup   — remove duplicate accessors/textures
//   2. weld    — weld coincident vertices
//   3. prune   — remove unused nodes/materials/textures/cameras
//   4. quantize— quantize vertex attributes (prep for meshopt)
//   5. meshopt — EXT_meshopt_compression (geometry + animation)
//   6. ktx2    — KHR_texture_basisu (textures → Basis Universal KTX2)
//
// Output is a single self-contained .glb. The runtime decodes meshopt via
// meshopt-codec.ts and basisu KTX2 via basisu-codec.ts (which transcodes to
// BC7/RGBA32 through @h00w/basis-universal-transcoder).
//

import type { Document as GltfDocument } from "@gltf-transform/core";
import { NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRTextureBasisu } from "@gltf-transform/extensions";
import { dedup, meshopt, prune, weld } from "@gltf-transform/functions";
import { Jimp } from "jimp";
import { MeshoptEncoder } from "meshoptimizer";
import { statSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import type { BakeResult, ResolvedBakeOptions, TextureCodecMode } from "./config";

let encoderReady: Promise<void> | null = null;
function ensureMeshoptEncoder(): Promise<void> {
  if (!encoderReady) encoderReady = MeshoptEncoder.ready;
  return encoderReady;
}

/**
 * jimp-based image decoder for the ktx2-encoder (Node.js requires an
 * imageDecoder to turn PNG/JPG/WebP bytes into raw RGBA for the basisu
 * encoder). Avoids the heavy native `sharp` dependency.
 */
async function jimpImageDecoder(buffer: Uint8Array): Promise<{ width: number; height: number; data: Uint8Array }> {
  const img = await Jimp.read(Buffer.from(buffer));
  // Ensure RGBA. Jimp always stores 4 channels internally.
  const { data, width, height } = img.bitmap;
  return { width, height, data: new Uint8Array(data) };
}

/**
 * Bake a glTF/GLB file (by absolute path) into an optimized self-contained
 * GLB. External `.bin`/texture references are resolved relative to the source
 * file via NodeIO.read().
 */
export async function bakeGltf(
  sourceAbsPath: string,
  opts: ResolvedBakeOptions,
  log?: (msg: string) => void,
): Promise<BakeResult> {
  const ext = extname(sourceAbsPath).toLowerCase();
  if (ext !== ".gltf" && ext !== ".glb") {
    throw new Error(`bakeGltf: unsupported extension "${ext}" (${sourceAbsPath})`);
  }

  const srcSize = statSync(sourceAbsPath).size;
  const g = opts.gltf;
  const t = g.textures;

  await ensureMeshoptEncoder();

  const io = new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRTextureBasisu])
    .registerDependencies({ "meshopt.encoder": MeshoptEncoder });

  const document = await io.read(sourceAbsPath);
  const transforms: Array<Promise<unknown> | unknown> = [];

  // Geometry transforms (applied in order).
  if (g.dedup) await document.transform(dedup());
  if (g.weld) await document.transform(weld());
  if (g.prune) await document.transform(prune());
  if (g.quantize || g.meshoptLevel) {
    const level = g.meshoptLevel === "high" ? "high" : "medium";
    await document.transform(
      meshopt({ encoder: MeshoptEncoder, level: level as "medium" | "high" }),
    );
    log?.(`  meshopt: ${level}`);
  }

  // Texture transforms → Basis Universal KTX2.
  if (t.enabled) {
    await applyKtx2Textures(document, t.codec, t, log);
  }

  const outBytes = await io.writeBinary(document);
  log?.(`  glb: ${srcSize} → ${outBytes.byteLength} bytes`);

  return {
    bytes: outBytes,
    ext: "glb",
    mimeType: "model/gltf-binary",
    sourceSize: srcSize,
  };
}

/**
 * Apply KTX2/basisu texture compression. In "auto" mode, UASTC is used for
 * quality-sensitive slots (normal/ORM/emissive) and ETC1S for base color.
 */
async function applyKtx2Textures(
  document: GltfDocument,
  codec: TextureCodecMode,
  t: ResolvedBakeOptions["gltf"]["textures"],
  log?: (msg: string) => void,
): Promise<void> {
  // Lazily import the ktx2-encoder gltf-transform transform. It dynamically
  // selects the Node encoder path internally.
  const { ktx2 } = await import("ktx2-encoder/gltf-transform");

  const baseOpts = {
    generateMipmap: t.generateMipmap,
    imageDecoder: jimpImageDecoder,
    enableDebug: false,
  };

  if (codec === "uastc") {
    await document.transform(
      ktx2({
        ...baseOpts,
        isUASTC: true,
        uastcLDRQualityLevel: t.uastcLevel,
        enableRDO: t.uastcRdo,
      }),
    );
    log?.(`  textures: UASTC (all slots)`);
  } else if (codec === "etc1s") {
    await document.transform(
      ktx2({
        ...baseOpts,
        isUASTC: false,
        qualityLevel: t.etc1sQuality,
      }),
    );
    log?.(`  textures: ETC1S (all slots)`);
  } else {
    // "auto": UASTC for normal/ORM/emissive, ETC1S for base color.
    const qualitySlots = /^(normalTexture|occlusionTexture|metallicRoughnessTexture|emissiveTexture)$/;
    const colorSlots = /^(baseColorTexture)$/;
    await document.transform(
      ktx2({
        ...baseOpts,
        isUASTC: true,
        uastcLDRQualityLevel: t.uastcLevel,
        enableRDO: t.uastcRdo,
        slots: qualitySlots,
      }),
    );
    await document.transform(
      ktx2({
        ...baseOpts,
        isUASTC: false,
        qualityLevel: t.etc1sQuality,
        slots: colorSlots,
      }),
    );
    log?.(`  textures: UASTC (quality) + ETC1S (color)`);
  }
}

/** Re-export for tests that need the source dir. */
export function sourceDir(sourceAbsPath: string): string {
  return dirname(sourceAbsPath);
}
export function sourceBase(sourceAbsPath: string): string {
  return basename(sourceAbsPath);
}
