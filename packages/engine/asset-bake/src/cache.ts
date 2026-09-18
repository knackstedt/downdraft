// ============================================================================
// BakeCache — content-hash cache for baked assets.
// ============================================================================
//
// Stores baked output in `<gameDir>/.downdraft/bake/` keyed by a hash of the
// source file contents + the bake config version. A `manifest.json` maps
// source-relative-path → cache entry so we can detect hits without re-hashing
// on every build (we still verify the source hash to catch content changes).
//
// Set DOWNDRAFT_BAKE_FORCE=1 to bypass cache reads (always re-bake).
//

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { BAKE_CONFIG_VERSION, type ResolvedBakeOptions } from "./config";

export interface BakeCacheEntry {
  /** Source file path relative to the game root. */
  sourceRel: string;
  /** xxh64 of source file contents (hex string). */
  sourceHash: string;
  /** Source mtime (ms). Used as a fast-path pre-check. */
  sourceMtime: number;
  /** Source byte length. */
  sourceSize: number;
  /** Bake config version when this entry was created. */
  configVersion: number;
  /** Baked output filename inside the cache dir (e.g. "a1b2c3.glb"). */
  bakedFile: string;
  /** Baked output extension. */
  bakedExt: string;
  /** Baked byte length. */
  bakedSize: number;
  /** Baked MIME type. */
  bakedMime: string;
}

export interface BakeCacheManifest {
  version: number;
  entries: Record<string, BakeCacheEntry>;
}

export interface BakeCacheHit {
  /** Absolute path to the cached baked file. */
  path: string;
  ext: string;
  mimeType: string;
  size: number;
}

export class BakeCache {
  readonly root: string;
  readonly dir: string;
  private manifestPath: string;
  private manifest: BakeCacheManifest;
  private loaded = false;

  constructor(gameRoot: string) {
    this.root = gameRoot;
    this.dir = resolve(gameRoot, ".downdraft", "bake");
    this.manifestPath = join(this.dir, "manifest.json");
    this.manifest = { version: BAKE_CONFIG_VERSION, entries: {} };
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.manifestPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.manifestPath, "utf-8"));
      if (raw && typeof raw === "object" && raw.entries) {
        this.manifest = raw as BakeCacheManifest;
      }
    } catch {
      // Corrupt manifest — start fresh.
      this.manifest = { version: BAKE_CONFIG_VERSION, entries: {} };
    }
  }

  private save(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2) + "\n");
  }

  /**
   * Check the cache for a hit. Returns the cached baked file path if the
   * source content hash matches AND the config version matches. Returns null
   * on miss or when DOWNDRAFT_BAKE_FORCE=1.
   */
  get(sourceAbsPath: string, opts: ResolvedBakeOptions): BakeCacheHit | null {
    if (process.env.DOWNDRAFT_BAKE_FORCE === "1") return null;
    this.load();
    const sourceRel = relative(this.root, sourceAbsPath).split(sep).join("/");
    const entry = this.manifest.entries[sourceRel];
    if (!entry) return null;
    if (entry.configVersion !== BAKE_CONFIG_VERSION) return null;

    // Fast path: mtime unchanged → trust the stored hash without re-reading.
    let sourceHash: string;
    try {
      const st = statSync(sourceAbsPath);
      if (st.mtimeMs !== entry.sourceMtime || st.size !== entry.sourceSize) {
        sourceHash = hashFile(sourceAbsPath);
      } else {
        sourceHash = entry.sourceHash;
      }
    } catch {
      return null;
    }

    if (sourceHash !== entry.sourceHash) return null;

    const bakedPath = join(this.dir, entry.bakedFile);
    if (!existsSync(bakedPath)) return null;
    return { path: bakedPath, ext: entry.bakedExt, mimeType: entry.bakedMime, size: entry.bakedSize };
  }

  /**
   * Store baked output for a source file and return the cache hit.
   */
  put(
    sourceAbsPath: string,
    bakedBytes: Uint8Array,
    bakedExt: string,
    bakedMime: string,
    opts: ResolvedBakeOptions,
  ): BakeCacheHit {
    this.load();
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });

    const sourceRel = relative(this.root, sourceAbsPath).split(sep).join("/");
    const sourceHash = hashFile(sourceAbsPath);
    let st: { mtimeMs: number; size: number };
    try {
      const s = statSync(sourceAbsPath);
      st = { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      st = { mtimeMs: 0, size: 0 };
    }

    const hashName = sourceHash + "." + bakedExt;
    const bakedPath = join(this.dir, hashName);
    writeFileSync(bakedPath, bakedBytes);

    const entry: BakeCacheEntry = {
      sourceRel,
      sourceHash,
      sourceMtime: st.mtimeMs,
      sourceSize: st.size,
      configVersion: BAKE_CONFIG_VERSION,
      bakedFile: hashName,
      bakedExt,
      bakedSize: bakedBytes.byteLength,
      bakedMime,
    };
    this.manifest.entries[sourceRel] = entry;
    this.save();

    return { path: bakedPath, ext: bakedExt, mimeType: bakedMime, size: bakedBytes.byteLength };
  }

  /** Remove stale entries whose source files no longer exist. */
  pruneStale(): number {
    this.load();
    let removed = 0;
    for (const [rel, entry] of Object.entries(this.manifest.entries)) {
      const abs = resolve(this.root, ...rel.split("/"));
      if (!existsSync(abs)) {
        delete this.manifest.entries[rel];
        removed++;
        // Best-effort: remove the baked file too.
        const bakedPath = join(this.dir, entry.bakedFile);
        try {
          unlinkSync(bakedPath);
        } catch {}
      }
    }
    if (removed > 0) this.save();
    return removed;
  }
}

/** xxh64 hash of a file's contents (hex string, no prefix). */
export function hashFile(absPath: string): string {
  const buf = readFileSync(absPath);
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}
