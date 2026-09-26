// ============================================================================
// downdraftAssetBakePlugin — Vite plugin that bakes assets at dev/build time.
// ============================================================================
//
// Intercepts `?url` (and bare) imports of bakeable asset extensions
// (.gltf/.glb/.wav/.mp3/.ogg/.flac), bakes them via @downdraft/engine/asset-bake
// (meshopt geometry + Basis KTX2 textures + normalized audio), caches the
// result in `<gameRoot>/.downdraft/bake/`, and emits/serves the optimized
// file. The runtime decodes the baked formats with its existing codecs.
//
// - build: emits the baked bytes as a hashed asset; the import resolves to
//   the emitted asset URL.
// - dev:   serves the cached baked file via a middleware under
//   `/__downdraft_bake__/`; the import resolves to that URL.
//
// Disabled entirely when `enabled === false` or `DOWNDRAFT_BAKE=0`. Forced
// re-bake (cache bypass) when `DOWNDRAFT_BAKE_FORCE=1`.
//
// The heavy @downdraft/engine/asset-bake package is dynamically imported inside
// `load()` so its deps (gltf-transform, meshoptimizer wasm, basisu encoder
// wasm, jimp) never enter the renderer bundle.
//

import { createLogger } from "@downdraft/engine/util/logger";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, resolve as resolvePath } from "node:path";
import type { Plugin } from "vite";

const log = createLogger("info");

/**
 * Bake options — mirrors the `AssetBakeOptions` type from
 * `@downdraft/engine/asset-bake/src/config`. Inlined here (rather than imported)
 * so this plugin file doesn't cross-reference the Node-only asset-bake
 * package at compile time (which would pull it into the web tsconfig).
 * The runtime import is dynamic: `await import("@downdraft/engine/asset-bake")`.
 */
export interface AssetBakeOptions {
  enabled?: boolean;
  gltf?: {
    enabled?: boolean;
    meshoptLevel?: "low" | "medium" | "high";
    prune?: boolean;
    dedup?: boolean;
    weld?: boolean;
    quantize?: boolean;
    textures?: {
      enabled?: boolean;
      codec?: "auto" | "uastc" | "etc1s";
      generateMipmap?: boolean;
      etc1sQuality?: number;
      uastcLevel?: number;
      uastcRdo?: boolean;
      maxSize?: number;
    };
  };
  audio?: {
    enabled?: boolean;
    target?: "ogg" | "mp3" | "wav" | "flac";
    bitrate?: number;
    sampleRate?: number;
    channels?: 0 | 1 | 2;
  };
  include?: string[];
  exclude?: string[];
}

const BAKEABLE_EXTS = new Set([".gltf", ".glb", ".wav", ".mp3", ".ogg", ".flac"]);
const VIRTUAL_PREFIX = "\0downdraft-bake:";

export interface AssetBakePluginOptions {
  /** Master enable. Default: true. */
  enabled?: boolean;
  /** Game root directory (where `.downdraft/bake/` lives). Default: Vite root. */
  gameRoot?: string;
  /** Bake options forwarded to @downdraft/engine/asset-bake. */
  options?: AssetBakeOptions;
  /** Verbose logging. */
  verbose?: boolean;
}

/** Local typed surface of the dynamically-imported bake package. */
interface BakeApi {
  bakeAsset: (
    sourceAbsPath: string,
    gameRoot: string,
    userOpts?: AssetBakeOptions,
    log?: (msg: string) => void,
  ) => Promise<{ path: string; ext: string; mimeType: string; size: number }>;
  isBakeable: (absPath: string, opts: unknown) => boolean;
  resolveOptions: (user?: AssetBakeOptions) => unknown;
}

export function downdraftAssetBakePlugin(opts: AssetBakePluginOptions = {}): Plugin {
  // Resolve enabled from env first, then option, then default true.
  const envFlag = process.env.DOWNDRAFT_BAKE;
  const enabled = envFlag === "0" ? false : envFlag === "1" ? true : (opts.enabled ?? true);
  const verbose = opts.verbose ?? false;

  let gameRoot: string;
  let isBuild = false;
  let bakeApi: BakeApi | null = null;
  // Map virtual id → baked file path (collected during load, used in dev).
  const virtualToPath = new Map<string, { path: string; mime: string }>();

  async function ensureBakeApi(): Promise<BakeApi> {
    if (bakeApi) return bakeApi;
    const mod = (await import("@downdraft/engine/asset-bake")) as unknown as BakeApi;
    bakeApi = mod;
    return mod;
  }

  return {
    name: "downdraft-asset-bake",
    enforce: "pre",

    configResolved(config) {
      gameRoot = opts.gameRoot ?? config.root;
      isBuild = config.command === "build";
      if (verbose && enabled) {
        config.logger.info(`[downdraft-asset-bake] enabled (${isBuild ? "build" : "serve"}), cache: ${resolvePath(gameRoot, ".downdraft", "bake")}`);
      }
    },

    resolveId(source, importer) {
      if (!enabled) return null;
      // Strip the ?url / ?raw query to inspect the extension.
      const cleanId = source.replace(/\?[^\n]*$/, "");
      const ext = extname(cleanId).toLowerCase();
      if (!BAKEABLE_EXTS.has(ext)) return null;
      // Resolve the absolute path of the source asset.
      if (!importer) return null;
      const abs = resolvePath(resolvePath(importer, ".."), cleanId);
      if (!existsSync(abs)) return null;
      return VIRTUAL_PREFIX + abs;
    },

    async load(id) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return null;
      if (!enabled) return null;

      const sourceAbs = id.slice(VIRTUAL_PREFIX.length);
      const api = await ensureBakeApi();

      const bakeLog = verbose
        ? (msg: string) => log.info("downdraft-asset-bake", `${basename(sourceAbs)}${msg}`)
        : undefined;

      const hit = await api.bakeAsset(sourceAbs, gameRoot, opts.options, bakeLog);
      virtualToPath.set(id, { path: hit.path, mime: hit.mimeType });

      // Read the baked bytes.
      const bakedBytes = readFileSync(hit.path);

      // Build mode: emit the baked file as a hashed asset.
      if (isBuild) {
        const hash = simpleHash(bakedBytes);
        const fileName = `assets/${basename(sourceAbs, extname(sourceAbs))}-${hash}.${hit.ext}`;
        this.emitFile({
          type: "asset",
          fileName,
          source: bakedBytes,
        });
        // For build, return the resolved URL relative to base.
        return `export default import.meta.env.BASE_URL + ${JSON.stringify(fileName)};`;
      }

      // Dev mode: serve via middleware. Return a URL under our prefix.
      const serveName = encodeURIComponent(basename(hit.path));
      return `export default "/__downdraft_bake__/${serveName}";`;
    },

    configureServer(server) {
      if (!enabled) return;
      // Serve baked files from the cache dir under /__downdraft_bake__/.
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith("/__downdraft_bake__/")) return next();
        const name = decodeURIComponent(req.url.slice("/__downdraft_bake__/".length).split("?")[0]);
        // Find the cached file by basename.
        const cacheDir = resolvePath(gameRoot, ".downdraft", "bake");
        const filePath = resolvePath(cacheDir, name);
        // Prevent path traversal.
        if (!filePath.startsWith(cacheDir)) {
          res.statusCode = 403;
          res.end();
          return;
        }
        if (!existsSync(filePath)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        const data = readFileSync(filePath);
        res.setHeader("Content-Type", mimeForExt(extname(name)) ?? "application/octet-stream");
        res.setHeader("Content-Length", data.byteLength);
        res.end(data);
      });
    },
  };
}

/** Stable short hash for asset filenames (not cryptographic). */
function simpleHash(bytes: Uint8Array | Buffer): string {
  let h = 0x811c9dc5;
  const len = Math.min(bytes.byteLength, 65536);
  for (let i = 0; i < len; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function mimeForExt(ext: string): string | undefined {
  const e = ext.toLowerCase();
  switch (e) {
    case ".glb": return "model/gltf-binary";
    case ".gltf": return "model/gltf+json";
    case ".ogg": return "audio/ogg";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".flac": return "audio/flac";
    case ".ktx2": return "image/ktx2";
    default: return undefined;
  }
}

// AssetBakeOptions is exported above (inlined, not re-exported from
// @downdraft/engine/asset-bake, to keep this file web-tsconfig-compatible).
