import {
  DEFAULT_CACHE_DIR,
  MANIFEST_FILENAME,
  createEmptyManifest, createLogger, packCacheKey,
  validateManifest, type AssetManifest,
  type AssetPackEntry,
  type BlobStoreConfig
} from "@downdraft/engine";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, relative, resolve, sep } from "path";
import { parseArgs, print, renderHelp, type CommandSchema } from "./args";
import { createBlobStore } from "./blob-store-s3";
import { getCommand } from "./usage";

const log = createLogger();

const ASSET_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".webp", ".ktx2",
  ".wav", ".mp3", ".ogg", ".flac",
  ".glb", ".gltf", ".obj", ".fbx",
  ".wgsl", ".json",
];

// Per-subcommand schemas for the assets subcommands that take flags.
const ADD_STORE_SCHEMA: CommandSchema = {
  positionals: [
    { name: "name", required: true, description: "Store name" },
    { name: "project", description: "Project path (default: current dir)" },
  ],
  flags: [
    { name: "bucket", type: "string", required: true, description: "S3 bucket name" },
    { name: "endpoint", type: "string", description: "S3-compatible endpoint URL" },
    { name: "region", type: "string", default: "us-east-1", description: "AWS region" },
    { name: "path-style", type: "boolean", description: "Use path-style addressing" },
  ],
};

const ADD_PACK_SCHEMA: CommandSchema = {
  positionals: [
    { name: "pack", required: true, description: "Pack name" },
    { name: "project", description: "Project path (default: current dir)" },
  ],
  flags: [
    { name: "version", type: "string", default: "1.0.0", description: "Pack version" },
    { name: "store", type: "string", required: true, description: "Store name (must exist in manifest)" },
    { name: "path", type: "string", description: "Remote path prefix (defaults to pack name)" },
  ],
};

const PUSH_SCHEMA: CommandSchema = {
  positionals: [{ name: "project", description: "Project path (default: current dir)" }],
  flags: [
    { name: "pack", type: "string", description: "Pack name to push (defaults to first pack)" },
    { name: "store", type: "string", description: "Store name to push to" },
    { name: "path", type: "string", description: "Remote path prefix override" },
    { name: "verbose", alias: "v", type: "boolean", description: "Verbose logging" },
  ],
};

const PULL_SCHEMA: CommandSchema = {
  positionals: [{ name: "project", description: "Project path (default: current dir)" }],
  flags: [
    { name: "verbose", alias: "v", type: "boolean", description: "Verbose logging" },
  ],
};

const LIST_SCHEMA: CommandSchema = {
  positionals: [{ name: "project", description: "Project path (default: current dir)" }],
  flags: [
    { name: "verbose", alias: "v", type: "boolean", description: "Verbose logging" },
  ],
};

const INIT_SCHEMA: CommandSchema = {
  positionals: [{ name: "project", description: "Project path (default: current dir)" }],
  flags: [],
};

export async function assets(args: string[]): Promise<void> {
  const entry = getCommand("assets")!;
  // The outer parse extracts the subcommand + project + --verbose.
  const parsed = parseArgs(args, entry.schema);
  if (parsed.help) {
    print(renderHelp(entry.usage, entry.schema));
    return;
  }

  const subcommand = parsed.positionals[0];
  const projectPath = parsed.positionals[1] ?? ".";
  const verbose = parsed.flags.verbose as boolean;

  switch (subcommand) {
    case "pull": {
      const sub = parseArgs(args.filter((a) => a !== "pull" && a !== projectPath), PULL_SCHEMA);
      if (sub.help) { print(renderHelp("draft assets pull [project]", PULL_SCHEMA)); return; }
      await pullAssets(projectPath, verbose);
      break;
    }
    case "push": {
      const sub = parseArgs(args.filter((a) => a !== "push" && a !== projectPath), PUSH_SCHEMA);
      if (sub.help) { print(renderHelp("draft assets push [project]", PUSH_SCHEMA)); return; }
      await pushAssets(projectPath, sub.flags, verbose);
      break;
    }
    case "list": {
      const sub = parseArgs(args.filter((a) => a !== "list" && a !== projectPath), LIST_SCHEMA);
      if (sub.help) { print(renderHelp("draft assets list [project]", LIST_SCHEMA)); return; }
      await listAssets(projectPath, verbose);
      break;
    }
    case "init": {
      const sub = parseArgs(args.filter((a) => a !== "init" && a !== projectPath), INIT_SCHEMA);
      if (sub.help) { print(renderHelp("draft assets init [project]", INIT_SCHEMA)); return; }
      await initManifest(projectPath);
      break;
    }
    case "add": {
      const sub = parseArgs(args.slice(1), ADD_PACK_SCHEMA);
      if (sub.help) { print(renderHelp("draft assets add <pack> [project]", ADD_PACK_SCHEMA)); return; }
      const packName = sub.positionals[0];
      const packProject = sub.positionals[1] ?? projectPath;
      await addPackParsed(packProject, packName, sub.flags);
      break;
    }
    case "add-store": {
      const sub = parseArgs(args.slice(1), ADD_STORE_SCHEMA);
      if (sub.help) { print(renderHelp("draft assets add-store <name> [project]", ADD_STORE_SCHEMA)); return; }
      const storeName = sub.positionals[0];
      const storeProject = sub.positionals[1] ?? projectPath;
      await addStoreParsed(storeProject, storeName, sub.flags);
      break;
    }
    default:
      print(renderHelp(entry.usage, entry.schema));
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

async function addStoreParsed(
  projectPath: string,
  name: string,
  flags: Record<string, string | boolean | number | string[]>,
): Promise<void> {
  if (!name) {
    log.error("assets", "Usage: draft assets add-store <name> --bucket=<> --endpoint=<> --region=<>");
    process.exit(1);
  }

  const bucket = flags.bucket as string;
  const endpoint = (flags.endpoint as string) || undefined;
  const region = (flags.region as string) || "us-east-1";
  const forcePathStyle = flags["path-style"] as boolean;

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

async function addPackParsed(
  projectPath: string,
  name: string,
  flags: Record<string, string | boolean | number | string[]>,
): Promise<void> {
  if (!name) {
    log.error("assets", "Usage: draft assets add <pack-name> --version=<> --store=<> --path=<>");
    process.exit(1);
  }

  const version = (flags.version as string) || "1.0.0";
  const store = flags.store as string;
  const path = (flags.path as string) || name;

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

  for (let _i = 0, _it = manifest.packs, _n = _it.length; _i < _n; _i++) { const pack = _it[_i];
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
      for (let _i = 0, _it = result.objects, _n = _it.length; _i < _n; _i++) { const obj = _it[_i];
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

async function pushAssets(
  projectPath: string,
  flags: Record<string, string | boolean | number | string[]>,
  verbose: boolean,
): Promise<void> {
  const manifest = loadManifest(projectPath);
  if (!manifest) return;

  const packName = (flags.pack as string) || undefined;
  const storeName = (flags.store as string) || undefined;
  const remotePath = (flags.path as string) || undefined;

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

  for (let _i = 0, _it = files, _n = _it.length; _i < _n; _i++) { const file = _it[_i];
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
  manifest.packs.forEach((pack) => {
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
  });

  // Cache dir
  log.info("assets", `\nCache: ${existsSync(cacheDir) ? relative(projectPath, cacheDir) : "(not created)"}`);

  if (verbose && existsSync(cacheDir)) {
    const allCached = collectAssetFiles(cacheDir);
    log.debug("assets", `  total cached files: ${allCached.length}`);
    allCached.forEach((f) => {
      log.debug("assets", `    ${relative(cacheDir, f)}`);
    });
  }
}

// ─── Utils ──────────────────────────────────────────────────────

function collectAssetFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir);
  for (let _i = 0, _it = entries, _n = _it.length; _i < _n; _i++) { const entry = _it[_i];
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
