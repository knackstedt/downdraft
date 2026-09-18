// Specs for the BakeCache — content-hash manifest with mtime fast-path.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BakeCache, hashFile } from "./cache";
import { resolveOptions, BAKE_CONFIG_VERSION } from "./config";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "downdraft-bake-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("hashFile", () => {
  it("produces a stable hex hash for the same content", () => {
    const f1 = join(tmpDir, "a.bin");
    const f2 = join(tmpDir, "b.bin");
    writeFileSync(f1, Buffer.from("hello world"));
    writeFileSync(f2, Buffer.from("hello world"));
    expect(hashFile(f1)).toBe(hashFile(f2));
  });

  it("produces different hashes for different content", () => {
    const f1 = join(tmpDir, "a.bin");
    const f2 = join(tmpDir, "b.bin");
    writeFileSync(f1, Buffer.from("hello"));
    writeFileSync(f2, Buffer.from("world"));
    expect(hashFile(f1)).not.toBe(hashFile(f2));
  });
});

describe("BakeCache", () => {
  it("returns null on first get (cache miss)", () => {
    const cache = new BakeCache(tmpDir);
    const src = join(tmpDir, "model.glb");
    writeFileSync(src, Buffer.from("glb data"));
    expect(cache.get(src, resolveOptions())).toBeNull();
  });

  it("stores and retrieves baked output (cache hit)", () => {
    const cache = new BakeCache(tmpDir);
    const src = join(tmpDir, "model.glb");
    writeFileSync(src, Buffer.from("source glb data"));
    const baked = new Uint8Array([1, 2, 3, 4]);

    const hit = cache.put(src, baked, "glb", "model/gltf-binary", resolveOptions());
    expect(hit.ext).toBe("glb");
    expect(hit.mimeType).toBe("model/gltf-binary");
    expect(existsSync(hit.path)).toBe(true);
    expect(readFileSync(hit.path)).toEqual(Buffer.from(baked));

    // Second get should hit.
    const hit2 = cache.get(src, resolveOptions());
    expect(hit2).not.toBeNull();
    expect(hit2!.ext).toBe("glb");
    expect(hit2!.size).toBe(baked.byteLength);
  });

  it("misses when source content changes", () => {
    const cache = new BakeCache(tmpDir);
    const src = join(tmpDir, "model.glb");
    writeFileSync(src, Buffer.from("original data"));
    cache.put(src, new Uint8Array([1]), "glb", "model/gltf-binary", resolveOptions());

    // Modify source content.
    writeFileSync(src, Buffer.from("modified data"));
    expect(cache.get(src, resolveOptions())).toBeNull();
  });

  it("misses when config version changes", () => {
    const cache = new BakeCache(tmpDir);
    const src = join(tmpDir, "model.glb");
    writeFileSync(src, Buffer.from("data"));
    cache.put(src, new Uint8Array([1]), "glb", "model/gltf-binary", resolveOptions());

    // Simulate a config version bump by directly editing the manifest.
    const manifestPath = join(cache.dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const key = Object.keys(manifest.entries)[0];
    manifest.entries[key].configVersion = BAKE_CONFIG_VERSION + 999;
    writeFileSync(manifestPath, JSON.stringify(manifest));

    // New cache instance to force re-load.
    const cache2 = new BakeCache(tmpDir);
    expect(cache2.get(src, resolveOptions())).toBeNull();
  });

  it("bypasses cache when DOWNDRAFT_BAKE_FORCE=1", () => {
    const cache = new BakeCache(tmpDir);
    const src = join(tmpDir, "model.glb");
    writeFileSync(src, Buffer.from("data"));
    cache.put(src, new Uint8Array([1]), "glb", "model/gltf-binary", resolveOptions());

    process.env.DOWNDRAFT_BAKE_FORCE = "1";
    try {
      expect(cache.get(src, resolveOptions())).toBeNull();
    } finally {
      delete process.env.DOWNDRAFT_BAKE_FORCE;
    }
  });

  it("prunes stale entries for deleted source files", () => {
    const cache = new BakeCache(tmpDir);
    const src = join(tmpDir, "model.glb");
    writeFileSync(src, Buffer.from("data"));
    cache.put(src, new Uint8Array([1]), "glb", "model/gltf-binary", resolveOptions());

    // Delete the source file.
    rmSync(src);
    const removed = cache.pruneStale();
    expect(removed).toBe(1);

    // Manifest should no longer have the entry.
    const manifestPath = join(cache.dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(Object.keys(manifest.entries)).toHaveLength(0);
  });
});
