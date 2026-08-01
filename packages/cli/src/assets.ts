import { createLogger } from "@downdraft/core";
import {
  type AssetManifest,
  type AssetPackEntry,
  type BlobStoreConfig,
  DEFAULT_CACHE_DIR,
  MANIFEST_FILENAME,
  createEmptyManifest,
  packCacheKey,
  validateManifest,
} from "@downdraft/core";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, relative, resolve, sep } from "path";
import { createBlobStore } from "./blob-store-s3.ts";

const log = createLogger();

const ASSET_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".webp", ".ktx2",
  ".wav", ".mp3", ".ogg", ".flac",
  ".glb", ".gltf", ".obj", ".fbx",
  ".wgsl", ".json",
];

export async function assets(args: string[]): Promise<void> {
  const subcommand = args[0];
  const projectPath = args.find((a) => !a.startsWith("-") && a !== subcommand) ?? ".";
  const verbose = args.includes("--verbose") || args.includes("-v");

  switch (subcommand) {
    case "pull":
      await pullAssets(projectPath, verbose);
      break;
    case "push":
      await pushAssets(projectPath, args, verbose);
      break;
    case "list":
      await listAssets(projectPath, verbose);
      break;
    case "init":
      await initManifest(projectPath);
      break;
    case "add":
      await addPack(projectPath, args.slice(1));
      break;
    case "add-store":
      await addStore(projectPath, args.slice(1));
      break;
    default:
      log.info("assets", `DownDraft Asset Management

Usage: draft assets <command> [options]

Commands:
  init                Create an empty downdraft.assets.json manifest
  add-store <name>    Add a blob store backend to the manifest
                    Options: --bucket=<> --endpoint=<> --region=<> --path-style
  add <pack>          Add an asset pack to the manifest
                    Options: --version=<> --store=<> --path=<>
  pull [project]      Download all manifest packs to local cache
  push [project]      Upload local assets/ dir to configured store
                    Options: --pack=<> --store=<> --path=<>
  list [project]      Show manifest packs and local cache status

Options:
  --verbose, -v      Enable verbose logging
`);
      process.exit(1);
  }
}

// ─── Manifest helpers ──────────────────────────────────────────

function loadManifest(projectPath: string): AssetManifest | null {
  const manifestPath = resolve(projectPath, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    log.error("assets", `No manifest found at ${manifestPath}. Run 'draft assets init' first.`);
    return null;
  }
  const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
  if (!validateManifest(raw)) {
    log.error("assets", `Invalid manifest format at ${manifestPath}`);
    return null;
  }
  return raw;
}

function saveManifest(projectPath: string, manifest: AssetManifest): void {
  const manifestPath = resolve(projectPath, MANIFEST_FILENAME);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  log.info("assets", `Manifest saved → ${manifestPath}`);
}

function getCacheDir(projectPath: string, manifest: AssetManifest): string {
  const cacheDir = manifest.cacheDir ?? DEFAULT_CACHE_DIR;
  return resolve(projectPath, cacheDir);
}

function resolveStoreConfig(manifest: AssetManifest, storeName: string): BlobStoreConfig | null {
  const config = manifest.stores[storeName];
  if (!config) {
    log.error("assets", `Store "${storeName}" not found in manifest. Available: ${Object.keys(manifest.stores).join(", ") || "(none)"}`);
    return null;
  }
  // Override with env vars if not set in manifest
  return {
    ...config,
    accessKeyId: config.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY,
  };
}

// ─── init ──────────────────────────────────────────────────────

async function initManifest(projectPath: string): Promise<void> {
  const manifestPath = resolve(projectPath, MANIFEST_FILENAME);
  if (existsSync(manifestPath)) {
    log.warn("assets", `Manifest already exists at ${manifestPath}`);
    return;
  }
  const manifest = createEmptyManifest();
  saveManifest(projectPath, manifest);
}

// ─── add-store ─────────────────────────────────────────────────

async function addStore(projectPath: string, args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    log.error("assets", "Usage: draft assets add-store <name> --bucket=<> --endpoint=<> --region=<>");
    process.exit(1);
  }

  const bucket = args.find((a) => a.startsWith("--bucket="))?.split("=")[1];
  const endpoint = args.find((a) => a.startsWith("--endpoint="))?.split("=")[1];
  const region = args.find((a) => a.startsWith("--region="))?.split("=")[1] ?? "us-east-1";
  const forcePathStyle = args.includes("--path-style");

  if (!bucket) {
    log.error("assets", "--bucket=<> is required");
    process.exit(1);
  }

  const manifest = loadManifest(projectPath);
  if (!manifest) return;

  manifest.stores[name] = {
    bucket,
    endpoint,
    region,
    forcePathStyle,
  };

  saveManifest(projectPath, manifest);
  log.info("assets", `Added store "${name}" → ${endpoint ?? "AWS S3"} / ${bucket}`);
}

// ─── add ────────────────────────────────────────────────────────

async function addPack(projectPath: string, args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    log.error("assets", "Usage: draft assets add <pack-name> --version=<> --store=<> --path=<>");
    process.exit(1);
  }

  const version = args.find((a) => a.startsWith("--version="))?.split("=")[1] ?? "1.0.0";
  const store = args.find((a) => a.startsWith("--store="))?.split("=")[1];
  const path = args.find((a) => a.startsWith("--path="))?.split("=")[1] ?? name;

  if (!store) {
    log.error("assets", "--store=<> is required (must match a store name in manifest)");
    process.exit(1);
  }

  const manifest = loadManifest(projectPath);
  if (!manifest) return;

  const existing = manifest.packs.findIndex((p) => p.name === name);
  const entry: AssetPackEntry = { name, version, store, path };
  if (existing >= 0) {
    manifest.packs[existing] = entry;
    log.info("assets", `Updated pack "${name}" → ${store}/${path}@${version}`);
  } else {
    manifest.packs.push(entry);
    log.info("assets", `Added pack "${name}" → ${store}/${path}@${version}`);
  }

  saveManifest(projectPath, manifest);
}

// ─── pull ───────────────────────────────────────────────────────

async function pullAssets(projectPath: string, verbose: boolean): Promise<void> {
  const manifest = loadManifest(projectPath);
  if (!manifest) return;

  const cacheDir = getCacheDir(projectPath, manifest);
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }

  if (manifest.packs.length === 0) {
    log.info("assets", "No packs in manifest. Use 'draft assets add' to add one.");
    return;
  }

  log.info("assets", `
  ╔══════════════════════════════════════════╗
  ║   DownDraft — Asset Pull                 ║
  ╚══════════════════════════════════════════╝
  `);

  let totalFiles = 0;
  let totalBytes = 0;

  for (const pack of manifest.packs) {
    const storeConfig = resolveStoreConfig(manifest, pack.store);
    if (!storeConfig) continue;

    const store = createBlobStore(storeConfig);
    const prefix = pack.path.endsWith("/") ? pack.path : pack.path + "/";

    log.info("assets", `Pulling pack: ${pack.name}@${pack.version} from ${pack.store}/${prefix}`);

    let cursor: string | undefined;
    let packFiles = 0;
    let packBytes = 0;

    do {
      const result = await store.list({ prefix, cursor });
      for (const obj of result.objects) {
        const relPath = obj.key.slice(prefix.length);
        if (!relPath) continue;

        const cacheKey = packCacheKey(pack, relPath);
        const destPath = join(cacheDir, pack.name, pack.version, ...relPath.split("/"));

        if (existsSync(destPath)) {
          if (verbose) log.debug("assets", `  cached: ${relPath}`);
          continue;
        }

        if (destPath.includes(sep)) {
          const dir = destPath.slice(0, destPath.lastIndexOf(sep));
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        }

        const data = await store.get(obj.key);
        writeFileSync(destPath, data);

        packFiles++;
        packBytes += obj.size;
        if (verbose) {
          log.debug("assets", `  downloaded: ${relPath} (${formatBytes(obj.size)})`);
        }
      }
      cursor = result.truncated ? result.cursor : undefined;
    } while (cursor);

    log.info("assets", `  ${pack.name}: ${packFiles} files, ${formatBytes(packBytes)}`);
    totalFiles += packFiles;
    totalBytes += packBytes;
  }

  log.info("assets", `Pull complete: ${totalFiles} files, ${formatBytes(totalBytes)} → ${relative(projectPath, cacheDir)}`);
}

// ─── push ───────────────────────────────────────────────────────

async function pushAssets(projectPath: string, args: string[], verbose: boolean): Promise<void> {
  const manifest = loadManifest(projectPath);
  if (!manifest) return;

  const packName = args.find((a) => a.startsWith("--pack="))?.split("=")[1];
  const storeName = args.find((a) => a.startsWith("--store="))?.split("=")[1];
  const remotePath = args.find((a) => a.startsWith("--path="))?.split("=")[1];

  const assetsDir = resolve(projectPath, "assets");
  if (!existsSync(assetsDir)) {
    log.error("assets", `No assets directory found at ${assetsDir}`);
    process.exit(1);
  }

  let storeConfig: BlobStoreConfig | null = null;
  let pack: AssetPackEntry | undefined;

  if (packName) {
    pack = manifest.packs.find((p) => p.name === packName);
    if (!pack) {
      log.error("assets", `Pack "${packName}" not found in manifest`);
      process.exit(1);
    }
    storeConfig = resolveStoreConfig(manifest, pack.store);
    if (!storeConfig) process.exit(1);
  } else if (storeName) {
    storeConfig = resolveStoreConfig(manifest, storeName);
    if (!storeConfig) process.exit(1);
  } else if (manifest.packs.length > 0) {
    pack = manifest.packs[0];
    storeConfig = resolveStoreConfig(manifest, pack.store);
    if (!storeConfig) process.exit(1);
    log.info("assets", `No --pack specified, using first pack: ${pack.name}`);
  } else {
    log.error("assets", "No packs in manifest and no --store specified. Use 'draft assets add' or specify --store=<>.");
    process.exit(1);
  }

  const prefix = remotePath ?? pack?.path ?? packName ?? "assets";
  const normalizedPrefix = prefix.endsWith("/") ? prefix : prefix + "/";

  log.info("assets", `
  ╔══════════════════════════════════════════╗
  ║   DownDraft — Asset Push                 ║
  ╚══════════════════════════════════════════╝
  `);

  log.info("assets", `  Source:  ${assetsDir}`);
  log.info("assets", `  Target:  ${storeConfig.bucket}/${normalizedPrefix}`);

  const store = createBlobStore(storeConfig);
  const files = collectAssetFiles(assetsDir);

  let totalFiles = 0;
  let totalBytes = 0;

  for (const file of files) {
    const relPath = relative(assetsDir, file);
    const key = normalizedPrefix + relPath.split(sep).join("/");
    const data = readFileSync(file);

    const ext = file.split(".").pop()?.toLowerCase() ?? "";
    const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";

    await store.put(key, new Uint8Array(data), { contentType });
    totalFiles++;
    totalBytes += data.length;

    if (verbose) {
      log.debug("assets", `  uploaded: ${relPath} (${formatBytes(data.length)})`);
    }
  }

  log.info("assets", `Push complete: ${totalFiles} files, ${formatBytes(totalBytes)} → ${storeConfig.bucket}/${normalizedPrefix}`);
}

// ─── list ───────────────────────────────────────────────────────

async function listAssets(projectPath: string, verbose: boolean): Promise<void> {
  const manifest = loadManifest(projectPath);
  if (!manifest) return;

  const cacheDir = getCacheDir(projectPath, manifest);

  log.info("assets", `
  ╔══════════════════════════════════════════╗
  ║   DownDraft — Asset Status               ║
  ╚══════════════════════════════════════════╝
  `);

  // Stores
  log.info("assets", "Stores:");
  if (Object.keys(manifest.stores).length === 0) {
    log.info("assets", "  (none — run 'draft assets add-store')");
  }
  for (const [name, config] of Object.entries(manifest.stores)) {
    log.info("assets", `  ${name}: ${config.endpoint ?? "AWS S3"} / ${config.bucket}`);
  }

  // Packs
  log.info("assets", "\nPacks:");
  if (manifest.packs.length === 0) {
    log.info("assets", "  (none — run 'draft assets add')");
  }
  for (const pack of manifest.packs) {
    const packCachePath = join(cacheDir, pack.name, pack.version);
    let cachedFiles = 0;
    let cachedBytes = 0;
    if (existsSync(packCachePath)) {
      const cached = collectAssetFiles(packCachePath);
      cachedFiles = cached.length;
      cachedBytes = cached.reduce((sum, f) => sum + statSync(f).size, 0);
    }
    log.info("assets", `  ${pack.name}@${pack.version} → ${pack.store}/${pack.path}`);
    log.info("assets", `    cached: ${cachedFiles} files, ${formatBytes(cachedBytes)}`);
  }

  // Cache dir
  log.info("assets", `\nCache: ${existsSync(cacheDir) ? relative(projectPath, cacheDir) : "(not created)"}`);

  if (verbose && existsSync(cacheDir)) {
    const allCached = collectAssetFiles(cacheDir);
    log.debug("assets", `  total cached files: ${allCached.length}`);
    for (const f of allCached) {
      log.debug("assets", `    ${relative(cacheDir, f)}`);
    }
  }
}

// ─── Utils ──────────────────────────────────────────────────────

function collectAssetFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git") continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...collectAssetFiles(fullPath));
    } else {
      const ext = "." + (entry.split(".").pop() ?? "");
      if (ASSET_EXTENSIONS.includes(ext.toLowerCase())) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  ktx2: "image/ktx2",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  flac: "audio/flac",
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  obj: "model/obj",
  fbx: "model/fbx",
  wgsl: "text/wgsl",
  json: "application/json",
};
