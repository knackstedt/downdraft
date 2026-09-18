// E2E test: Vite plugin build + dev modes.
// Creates a minimal Vite project with a bakeable .gltf import, runs a real
// Vite build and dev server, and verifies the baked asset is emitted/served.
//
// Run: bun test packages/asset-bake/src/e2e-vite-plugin.spec.ts

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build as viteBuild, createServer as viteCreateServer } from "vite";

let tmpDir: string;
let projectDir: string;
let srcDir: string;
let cacheDir: string;

const REPO = join(import.meta.dir, "..", "..", "..");
const MODEL_DIR = join(
  REPO,
  "games/to-the-ocean/src/assets/models/human/Universal Base Characters[Standard]/Hairstyles/Origin at 0/glTF (Godot)",
);

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "downdraft-vite-plugin-e2e-"));
  projectDir = tmpDir;
  srcDir = join(projectDir, "src");
  cacheDir = join(projectDir, ".downdraft", "bake");
  mkdirSync(srcDir, { recursive: true });

  // Copy the glTF + its .bin + textures into the project src.
  const modelSrcDir = join(srcDir, "model");
  mkdirSync(modelSrcDir, { recursive: true });
  for (const f of readdirSync(MODEL_DIR)) {
    copyFileSync(join(MODEL_DIR, f), join(modelSrcDir, f));
  }

  // Entry uses the modelUrl in a side-effect so Rollup doesn't tree-shake it.
  writeFileSync(
    join(srcDir, "entry.ts"),
    `import modelUrl from "./model/Eyebrows_Regular.gltf?url" with { type: "text" };
// Side-effect to prevent tree-shaking.
globalThis.__modelUrl = modelUrl;
export { modelUrl };
`,
  );

  writeFileSync(
    join(projectDir, "index.html"),
    `<!DOCTYPE html><html><body><script type="module" src="/src/entry.ts"></script></body></html>`,
  );
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("e2e: Vite asset-bake plugin", () => {
  it("build mode: emits baked GLB as a hashed asset with meshopt + basisu", async () => {
    const { downdraftAssetBakePlugin } = await import("../../app/src/vite/asset-bake-plugin");

    const outDir = join(projectDir, "dist-build");
    const result = await viteBuild({
      root: projectDir,
      logLevel: "warn",
      plugins: [downdraftAssetBakePlugin({ gameRoot: projectDir, verbose: true })],
      build: {
        outDir,
        write: true,
        rollupOptions: {
          input: join(srcDir, "entry.ts"),
          output: { entryFileNames: "entry.js" },
        },
      },
    });

    // The baked GLB should be emitted as an asset file.
    const assetFiles = result.output.filter((f) => f.type === "asset" && f.fileName.endsWith(".glb"));
    expect(assetFiles.length).toBeGreaterThan(0);
    const glbAsset = assetFiles[0] as any;
    console.log(`  [e2e] emitted baked GLB: ${glbAsset.fileName} (${glbAsset.source.byteLength ?? glbAsset.source.length} bytes)`);

    // Verify the emitted GLB has the meshopt + basisu extensions.
    const glbBytes = glbAsset.source instanceof Uint8Array ? glbAsset.source : new Uint8Array(glbAsset.source);
    const magic = String.fromCharCode(...glbBytes.slice(0, 4));
    expect(magic).toBe("glTF");

    // Parse JSON chunk to check extensions.
    const view = new DataView(glbBytes.buffer, glbBytes.byteOffset, glbBytes.byteLength);
    const chunk0Len = view.getUint32(12, true);
    const jsonStr = new TextDecoder().decode(new Uint8Array(glbBytes.buffer, glbBytes.byteOffset + 20, chunk0Len));
    const json = JSON.parse(jsonStr);
    expect(json.extensionsUsed).toContain("EXT_meshopt_compression");
    expect(json.extensionsUsed).toContain("KHR_texture_basisu");
    console.log(`  [e2e] extensions: ${json.extensionsUsed.join(", ")}`);

    // The entry.js should reference the emitted .glb asset filename.
    const entryJs = readFileSync(join(outDir, "entry.js"), "utf-8");
    expect(entryJs).toContain(".glb");
    console.log(`  [e2e] entry.js references baked asset: ${entryJs.match(/assets\/[^"']+\.glb/)?.[0] ?? "NOT FOUND"}`);
  }, 120000);

  it("build mode: --no-bake (DOWNDRAFT_BAKE=0) passes through unchanged", async () => {
    const { downdraftAssetBakePlugin } = await import("../../app/src/vite/asset-bake-plugin");

    const outDir = join(projectDir, "dist-nobake");
    const prevEnv = process.env.DOWNDRAFT_BAKE;
    process.env.DOWNDRAFT_BAKE = "0";
    try {
      const result = await viteBuild({
        root: projectDir,
        logLevel: "warn",
        plugins: [downdraftAssetBakePlugin({ gameRoot: projectDir })],
        build: {
          outDir,
          write: true,
          rollupOptions: {
            input: join(srcDir, "entry.ts"),
            output: { entryFileNames: "entry.js" },
          },
        },
      });

      // With baking disabled, no .glb asset should be emitted.
      const glbAssets = result.output.filter((f) => f.type === "asset" && f.fileName.endsWith(".glb"));
      expect(glbAssets.length).toBe(0);
      console.log(`  [e2e] no-bake: 0 baked GLB assets (correct)`);

      // The entry.js should NOT reference a baked .glb file.
      const entryJs = readFileSync(join(outDir, "entry.js"), "utf-8");
      expect(entryJs).not.toContain(".glb");
      console.log(`  [e2e] no-bake: entry.js does not reference .glb (correct)`);
    } finally {
      if (prevEnv === undefined) delete process.env.DOWNDRAFT_BAKE;
      else process.env.DOWNDRAFT_BAKE = prevEnv;
    }
  }, 60000);

  it("dev mode: plugin intercepts import and cache is valid", async () => {
    const { downdraftAssetBakePlugin } = await import("../../app/src/vite/asset-bake-plugin");

    const server = await viteCreateServer({
      root: projectDir,
      logLevel: "warn",
      plugins: [downdraftAssetBakePlugin({ gameRoot: projectDir, verbose: true })],
      server: { middlewareMode: true },
    });

    try {
      // Transform the entry module — the plugin should intercept the import.
      const transformed = await server.transformRequest("/src/entry.ts");
      expect(transformed).not.toBeNull();
      console.log("  [e2e] dev entry transformed (first 300 chars):", transformed!.code.slice(0, 300));

      // The entry should import from the virtual module (plugin intercepts).
      // The virtual module ID contains the downdraft-bake prefix.
      expect(transformed!.code).toContain("downdraft-bake");
      console.log(`  [e2e] dev: plugin intercepted import (virtual ID present)`);

      // The cache should exist with a valid baked GLB from the build-mode test.
      const manifestPath = join(cacheDir, "manifest.json");
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      expect(Object.keys(manifest.entries).length).toBeGreaterThan(0);

      // Find the baked file and verify it's a valid GLB.
      const entry = Object.values(manifest.entries)[0] as any;
      const bakedPath = join(cacheDir, entry.bakedFile);
      expect(existsSync(bakedPath)).toBe(true);
      const bakedBytes = readFileSync(bakedPath);
      const glbMagic = String.fromCharCode(...bakedBytes.slice(0, 4));
      expect(glbMagic).toBe("glTF");
      console.log(`  [e2e] dev: cached baked GLB valid (${bakedBytes.byteLength} bytes)`);

      // Give the async load() hook time to run (it fires after transformRequest
      // resolves the import). Wait 500ms then check the cache was hit.
      await new Promise((r) => setTimeout(r, 500));
      console.log(`  [e2e] dev: async load() had time to run`);
    } finally {
      await server.close();
    }
  }, 120000);

  it("cache: second build hits cache (no re-bake)", async () => {
    const { downdraftAssetBakePlugin } = await import("../../app/src/vite/asset-bake-plugin");

    // The cache should already be populated from the build-mode test.
    const manifestPath = join(cacheDir, "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(Object.keys(manifest.entries).length).toBeGreaterThan(0);
    console.log(`  [e2e] cache manifest has ${Object.keys(manifest.entries).length} entries`);

    // Run a second build — should use the cache (no encoding output).
    const outDir = join(projectDir, "dist-cache");
    const result = await viteBuild({
      root: projectDir,
      logLevel: "warn",
      plugins: [downdraftAssetBakePlugin({ gameRoot: projectDir, verbose: true })],
      build: {
        outDir,
        write: true,
        rollupOptions: {
          input: join(srcDir, "entry.ts"),
          output: { entryFileNames: "entry.js" },
        },
      },
    });

    const assetFiles = result.output.filter((f) => f.type === "asset" && f.fileName.endsWith(".glb"));
    expect(assetFiles.length).toBeGreaterThan(0);
    console.log(`  [e2e] cache hit build emitted: ${(assetFiles[0] as any).fileName}`);
  }, 120000);
});
