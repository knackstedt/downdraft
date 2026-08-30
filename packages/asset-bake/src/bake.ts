// ============================================================================
// bake.ts — dispatch baking by file extension, with cache integration.
// ============================================================================

import { extname } from "node:path";
import { readFileSync } from "node:fs";
import { BakeCache, type BakeCacheHit } from "./cache";
import { resolveOptions, type AssetBakeOptions, type BakeResult, type ResolvedBakeOptions } from "./config";
import { bakeGltf } from "./bake-gltf";
import { bakeAudio } from "./bake-audio";

const GLTF_EXTS = new Set([".gltf", ".glb"]);
const AUDIO_EXTS = new Set([".wav", ".mp3", ".ogg", ".flac"]);

/** All extensions the bake pipeline handles. */
export const BAKEABLE_EXTENSIONS = [...GLTF_EXTS, ...AUDIO_EXTS] as const;

export function isBakeable(absPath: string, opts: ResolvedBakeOptions): boolean {
  const ext = extname(absPath).toLowerCase();
  if (GLTF_EXTS.has(ext) && opts.gltf.enabled) return true;
  if (AUDIO_EXTS.has(ext) && opts.audio.enabled) return true;
  return false;
}

/**
 * Bake a single asset file (by absolute path). Uses the BakeCache for hits;
 * on miss, bakes and stores the result.
 *
 * @param sourceAbsPath  absolute path to the source asset.
 * @param gameRoot       absolute path to the game root (for the cache dir).
 * @param userOpts       user bake options (merged with defaults).
 * @param log            optional verbose logger.
 * @returns the cache hit (path to the baked file + metadata).
 */
export async function bakeAsset(
  sourceAbsPath: string,
  gameRoot: string,
  userOpts?: AssetBakeOptions,
  log?: (msg: string) => void,
): Promise<BakeCacheHit> {
  const opts = resolveOptions(userOpts);
  const cache = new BakeCache(gameRoot);

  const hit = cache.get(sourceAbsPath, opts);
  if (hit) {
    log?.(`  cache hit: ${hit.ext} (${hit.size} bytes)`);
    return hit;
  }

  const result = await bakeAssetFromBytes(sourceAbsPath, opts, log);
  return cache.put(sourceAbsPath, result.bytes, result.ext, result.mimeType, opts);
}

/**
 * Bake a single asset file without the cache (returns the baked bytes
 * directly). Useful for tests and one-off bakes.
 */
export async function bakeAssetFromBytes(
  sourceAbsPath: string,
  opts: ResolvedBakeOptions,
  log?: (msg: string) => void,
): Promise<BakeResult> {
  const ext = extname(sourceAbsPath).toLowerCase();
  if (GLTF_EXTS.has(ext)) {
    return bakeGltf(sourceAbsPath, opts, log);
  }
  if (AUDIO_EXTS.has(ext)) {
    return bakeAudio(sourceAbsPath, opts, log);
  }
  // Not bakeable — pass through unchanged.
  const data = readFileSync(sourceAbsPath);
  return {
    bytes: new Uint8Array(data),
    ext: ext.slice(1) || "bin",
    mimeType: "application/octet-stream",
    sourceSize: data.byteLength,
  };
}
