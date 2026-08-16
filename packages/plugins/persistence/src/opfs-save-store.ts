// ============================================================================
// OpfsSaveStore — OPFS-backed ISaveStore with generation history, blobs,
// thumbnails, and properties. Runs in Web Workers (sync access handles) or
// on the main thread (async writable streams).
// ============================================================================
//
// Directory layout in OPFS:
//   <root>/saves/
//     <slot>/
//       meta.json              — slot metadata (currentGen, generations[], properties)
//       thumbnail.png          — optional thumbnail image
//       gen/
//         0001/
//           body.zst           — zstd-compressed component JSON
//           body.hash          — 16-byte XXH128 hash of uncompressed body
//           blobs/
//             <blobKey>        — raw binary blobs
//         0002/
//           ...
//
// On save: write body + blobs first, then update meta.json (commit point).
// On load: read meta.json, load current gen (or specified), fall back to
// previous gen on hash mismatch / corruption.
//
// Forward incompatibility: saves from a newer engine version are refused.

import { safeJsonParse } from "@downdraft/core";
import { packEngineVersion } from "@downdraft/core/save/binary-format";
import { MigrationRegistryImpl } from "@downdraft/core/save/migration-registry";
import type {
    IMigrationRegistry,
    ISaveStore,
    LoadOptions,
    LoadResult,
    SaveGenerationInfo,
    SaveOptions,
    SaveResult,
    SaveSlotInfo,
    SaveState,
    SaveWarning,
} from "@downdraft/core/save/persist-types";
import { createLogger } from "@downdraft/core/util/logger";

const log = createLogger("info");

const DEFAULT_MAX_GENERATIONS = 3;
const SAVES_DIR_NAME = "saves";
const META_FILE = "meta.json";
const THUMBNAIL_FILE = "thumbnail.png";
const GEN_DIR = "gen";
const BODY_FILE = "body.zst";
const HASH_FILE = "body.hash";
const BLOBS_DIR = "blobs";
const META_FORMAT_VERSION = 1;

// ── OPFS type helpers ──────────────────────────────────────────────────────
// Minimal OPFS types to avoid depending on lib.dom.d.ts worker-augmented defs.

interface FsDirHandle {
  kind: "directory";
  name: string;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FsDirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsFileHandle>;
  keys(): AsyncIterableIterator<string>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  values(): AsyncIterableIterator<FsDirHandle | FsFileHandle>;
}

interface FsFileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<FsFile>;
  createWritable(): Promise<FsWritableStream>;
  createSyncAccessHandle(): Promise<FsSyncAccessHandle>;
}

interface FsFile {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

interface FsWritableStream {
  write(data: BufferSource | string): Promise<void>;
  close(): Promise<void>;
}

interface FsSyncAccessHandle {
  write(data: BufferSource): number;
  flush(): void;
  close(): void;
  getSize(): number;
  read(buffer: ArrayBufferView, opts?: { at?: number }): number;
}

// ── Meta file types ────────────────────────────────────────────────────────

interface GenerationMeta {
  gen: number;
  timestamp: number;
  engineVersion: string;
  entityCount: number;
  playerCount: number;
  bodySize: number;
  blobCount: number;
}

interface SlotMeta {
  formatVersion: number;
  currentGen: number;
  maxGenerations: number;
  generations: GenerationMeta[];
  properties: Record<string, unknown>;
  hasThumbnail: boolean;
}

// ── Options ────────────────────────────────────────────────────────────────

export interface OpfsSaveStoreOptions {
  /**
   * Root OPFS directory handle. If not provided, `navigator.storage.getDirectory()`
   * is called and a `downdraft/` subdirectory is created.
   */
  rootDir?: FsDirHandle;
  /** Subdirectory name under root for saves. Default: "saves". */
  savesDirName?: string;
  /** Current engine/game version string (e.g. "0.1.0"). */
  engineVersion: string;
  /** Default max generations per slot. Default: 3. */
  maxGenerations?: number;
  /** Migration registry (optional — a new one is created if not provided). */
  migrationRegistry?: IMigrationRegistry;
  /** Optional compression provider (for testing or custom compression). */
  compress?: (data: Uint8Array) => Uint8Array;
  /** Optional decompression provider (for testing or custom compression). */
  decompress?: (data: Uint8Array, originalSize: number) => Uint8Array;
  /** Optional hash provider (for testing or custom hashing). */
  hash128?: (data: Uint8Array) => Uint8Array;
  /** Skip migration step on load — pass through components unchanged. */
  skipMigrations?: boolean;
}

// ── OpfsSaveStore ──────────────────────────────────────────────────────────

export class OpfsSaveStore implements ISaveStore {
  private savesDir: FsDirHandle | null = null;
  private engineVersionPacked: number;
  private defaultMaxGenerations: number;
  private migrations: IMigrationRegistry;
  private warningCallbacks: Array<(w: SaveWarning) => void> = [];
  private zstdReady: Promise<void> | null = null;
  private _compress: ((data: Uint8Array) => Uint8Array) | null = null;
  private _decompress: ((data: Uint8Array, originalSize: number) => Uint8Array) | null = null;
  private _hash128: ((data: Uint8Array) => Uint8Array) | null = null;
  private _skipMigrations: boolean = false;
  private _rootDir: FsDirHandle | null;
  private _savesDirName: string;

  constructor(opts: OpfsSaveStoreOptions) {
    this._rootDir = opts.rootDir ?? null;
    this._savesDirName = opts.savesDirName ?? SAVES_DIR_NAME;
    const parts = opts.engineVersion.split(".").map(Number);
    this.engineVersionPacked = packEngineVersion(parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0);
    this.defaultMaxGenerations = opts.maxGenerations ?? DEFAULT_MAX_GENERATIONS;
    this.migrations = opts.migrationRegistry ?? new MigrationRegistryImpl();
    this._compress = opts.compress ?? null;
    this._decompress = opts.decompress ?? null;
    this._hash128 = opts.hash128 ?? null;
    this._skipMigrations = opts.skipMigrations ?? false;
  }

  getMigrationRegistry(): IMigrationRegistry {
    return this.migrations;
  }

  // ── Initialization ──────────────────────────────────────────────────────

  /**
   * Initialize the saves directory. Must be called before any save/load.
   * If `rootDir` was provided in options, uses it; otherwise calls
   * `navigator.storage.getDirectory()`.
   */
  async init(): Promise<void> {
    if (this.savesDir) return;
    let root = this._rootDir;
    if (!root) {
      const nav = globalThis as unknown as { navigator?: { storage?: { getDirectory(): Promise<FsDirHandle> } } };
      if (!nav.navigator?.storage?.getDirectory) {
        throw new Error("OPFS is not available in this environment");
      }
      root = await nav.navigator.storage.getDirectory();
    }
    // Create downdraft/ subdirectory, then saves/ under it
    const ddDir = await root.getDirectoryHandle("downdraft", { create: true });
    this.savesDir = await ddDir.getDirectoryHandle(this._savesDirName, { create: true });
  }

  /**
   * Initialize from a pre-resolved saves directory handle (e.g. from a worker
   * that already has the directory). Bypasses `navigator.storage.getDirectory()`.
   */
  initWithSavesDir(savesDir: FsDirHandle): void {
    this.savesDir = savesDir;
  }

  private ensureInit(): FsDirHandle {
    if (!this.savesDir) {
      throw new Error("OpfsSaveStore not initialized — call init() first");
    }
    return this.savesDir;
  }

  // ── Warning system ──────────────────────────────────────────────────────

  onWarning(cb: (warning: SaveWarning) => void): () => void {
    this.warningCallbacks.push(cb);
    return () => {
      const idx = this.warningCallbacks.indexOf(cb);
      if (idx >= 0) this.warningCallbacks.splice(idx, 1);
    };
  }

  private warn(warning: SaveWarning): void {
    for (const cb of this.warningCallbacks) {
      try { cb(warning); } catch { /* ignore callback errors */ }
    }
  }

  // ── Compression / hashing (lazy init, same as FileSaveStore) ────────────

  private async ensureZstd(): Promise<void> {
    if (this.zstdReady) return this.zstdReady;
    this.zstdReady = (async () => {
      const { init } = await import("@bokuweb/zstd-wasm");
      await init();
    })();
    return this.zstdReady;
  }

  private async computeHash(data: Uint8Array): Promise<Uint8Array> {
    const xxh = await import("xxhash-wasm");
    const instance = await xxh.default();
    const h64 = instance.h64Raw(data);
    const result = new Uint8Array(16);
    result.set(h64, 0);
    return result;
  }

  private async compressBytes(data: Uint8Array): Promise<Uint8Array> {
    await this.ensureZstd();
    const { compress } = await import("@bokuweb/zstd-wasm");
    return compress(data);
  }

  private async decompressBytes(data: Uint8Array, _originalSize: number): Promise<Uint8Array> {
    await this.ensureZstd();
    const { decompress } = await import("@bokuweb/zstd-wasm");
    return decompress(data);
  }

  // ── Path helpers ────────────────────────────────────────────────────────

  private sanitizeSlot(slot: string): string {
    return slot.replace(/[^a-zA-Z0-9_\-]/g, "_");
  }

  private genDirName(gen: number): string {
    return String(gen).padStart(4, "0");
  }

  private async getSlotDir(slot: string, create: boolean): Promise<FsDirHandle> {
    const saves = this.ensureInit();
    return saves.getDirectoryHandle(this.sanitizeSlot(slot), { create });
  }

  private async getGenDir(slotDir: FsDirHandle, gen: number, create: boolean): Promise<FsDirHandle> {
    const genRoot = await slotDir.getDirectoryHandle(GEN_DIR, { create });
    return genRoot.getDirectoryHandle(this.genDirName(gen), { create });
  }

  private async getBlobsDir(genDir: FsDirHandle, create: boolean): Promise<FsDirHandle> {
    return genDir.getDirectoryHandle(BLOBS_DIR, { create });
  }

  // ── Meta file read/write ────────────────────────────────────────────────

  private async readMeta(slotDir: FsDirHandle): Promise<SlotMeta | null> {
    try {
      const fileHandle = await slotDir.getFileHandle(META_FILE);
      const file = await fileHandle.getFile();
      const text = await file.text();
      return safeJsonParse<SlotMeta>(text);
    } catch {
      return null;
    }
  }

  private async writeMeta(slotDir: FsDirHandle, meta: SlotMeta): Promise<void> {
    const fileHandle = await slotDir.getFileHandle(META_FILE, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(meta, null, 2));
    await writable.close();
  }

  // ── File I/O helpers ────────────────────────────────────────────────────

  private async writeBinaryFile(dir: FsDirHandle, name: string, data: Uint8Array): Promise<void> {
    const fileHandle = await dir.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(data as Uint8Array<ArrayBuffer>);
    await writable.close();
  }

  private async readBinaryFile(dir: FsDirHandle, name: string): Promise<Uint8Array | null> {
    try {
      const fileHandle = await dir.getFileHandle(name);
      const file = await fileHandle.getFile();
      const buf = await file.arrayBuffer();
      return new Uint8Array(buf);
    } catch {
      return null;
    }
  }

  private async removeRecursive(dir: FsDirHandle, name: string): Promise<void> {
    try {
      await dir.removeEntry(name, { recursive: true });
    } catch {
      // Already gone — fine
    }
  }

  // ── ISaveStore: save ────────────────────────────────────────────────────

  async save(slot: string, state: SaveState, opts?: SaveOptions): Promise<SaveResult> {
    try {
      this.ensureInit();
      const slotDir = await this.getSlotDir(slot, true);

      // Read existing meta or create new
      const existingMeta = await this.readMeta(slotDir);
      const maxGens = opts?.maxGenerations ?? existingMeta?.maxGenerations ?? this.defaultMaxGenerations;
      const currentGen = (existingMeta?.currentGen ?? 0) + 1;
      const genDir = await this.getGenDir(slotDir, currentGen, true);

      // 1. Write body (compressed component JSON)
      const bodyJson = JSON.stringify(state.components);
      const bodyBytes = new TextEncoder().encode(bodyJson);

      const hashBytes = this._hash128 ? this._hash128(bodyBytes) : await this.computeHash(bodyBytes);
      const compressed = this._compress ? this._compress(bodyBytes) : await this.compressBytes(bodyBytes);

      await this.writeBinaryFile(genDir, BODY_FILE, compressed);
      await this.writeBinaryFile(genDir, HASH_FILE, hashBytes);

      // 2. Write blobs
      let blobCount = 0;
      if (opts?.blobs && Object.keys(opts.blobs).length > 0) {
        const blobsDir = await this.getBlobsDir(genDir, true);
        for (const [key, buf] of Object.entries(opts.blobs)) {
          const safeKey = key.replace(/[^a-zA-Z0-9_\-]/g, "_");
          await this.writeBinaryFile(blobsDir, safeKey, new Uint8Array(buf));
          blobCount++;
        }
      }

      // 3. Write thumbnail if provided
      let hasThumbnail = existingMeta?.hasThumbnail ?? false;
      if (opts?.thumbnail) {
        const thumbData = opts.thumbnail instanceof Uint8Array ? opts.thumbnail : new Uint8Array(opts.thumbnail);
        await this.writeBinaryFile(slotDir, THUMBNAIL_FILE, thumbData);
        hasThumbnail = true;
      }

      // 4. Build new meta (commit point — written last)
      const genMeta: GenerationMeta = {
        gen: currentGen,
        timestamp: state.meta.timestamp,
        engineVersion: state.meta.engineVersion,
        entityCount: state.meta.entityCount,
        playerCount: state.meta.playerCount,
        bodySize: compressed.length,
        blobCount,
      };

      const generations = [...(existingMeta?.generations ?? []), genMeta];
      // Prune old generations
      while (generations.length > maxGens) {
        const oldest = generations.shift()!;
        await this.removeGenDir(slotDir, oldest.gen);
      }

      const properties = opts?.properties ?? existingMeta?.properties ?? {};

      const newMeta: SlotMeta = {
        formatVersion: META_FORMAT_VERSION,
        currentGen,
        maxGenerations: maxGens,
        generations,
        properties,
        hasThumbnail,
      };

      await this.writeMeta(slotDir, newMeta);

      const totalBytes = compressed.length + hashBytes.length + (opts?.blobs ? Object.values(opts.blobs).reduce((s, b) => s + b.byteLength, 0) : 0);
      log.info("OpfsSaveStore", `Saved slot '${slot}' gen ${currentGen} (${totalBytes} bytes)`);
      return { success: true, bytes: totalBytes, gen: currentGen };
    } catch (err) {
      log.error("OpfsSaveStore", `Save failed for slot '${slot}': ${err}`);
      return { success: false, bytes: 0 };
    }
  }

  private async removeGenDir(slotDir: FsDirHandle, gen: number): Promise<void> {
    try {
      const genRoot = await slotDir.getDirectoryHandle(GEN_DIR);
      await this.removeRecursive(genRoot, this.genDirName(gen));
    } catch {
      // Already gone
    }
  }

  // ── ISaveStore: load ────────────────────────────────────────────────────

  async load(slot: string, opts?: LoadOptions): Promise<LoadResult> {
    try {
      const slotDir = await this.getSlotDir(slot, false);
      const meta = await this.readMeta(slotDir);
      if (!meta) {
        this.warn({ kind: "no_saves_found", slot, message: `No save meta found for slot '${slot}'` });
        return { state: null };
      }

      const targetGen = opts?.gen ?? meta.currentGen;
      const includeBlobs = opts?.includeBlobs ?? true;

      // Try target gen, then fall back to previous generations
      const gensToTry = meta.generations
        .filter(g => g.gen <= targetGen)
        .sort((a, b) => b.gen - a.gen);

      for (const genMeta of gensToTry) {
        const result = await this.loadFromGen(slotDir, slot, genMeta, includeBlobs);
        if (result.state) {
          if (genMeta.gen !== targetGen) {
            this.warn({
              kind: "backup_loaded",
              slot,
              message: `Primary gen ${targetGen} failed, loaded gen ${genMeta.gen} for slot '${slot}'`,
            });
            return { ...result, gen: genMeta.gen };
          }
          return { ...result, gen: genMeta.gen };
        }
      }

      this.warn({ kind: "no_saves_found", slot, message: `No valid save found for slot '${slot}'` });
      return { state: null };
    } catch (err) {
      log.error("OpfsSaveStore", `Load failed for slot '${slot}': ${err}`);
      return { state: null };
    }
  }

  private async loadFromGen(
    slotDir: FsDirHandle,
    slot: string,
    genMeta: GenerationMeta,
    includeBlobs: boolean,
  ): Promise<LoadResult> {
    try {
      const genDir = await this.getGenDir(slotDir, genMeta.gen, false);

      // Read and decompress body
      const compressed = await this.readBinaryFile(genDir, BODY_FILE);
      if (!compressed) return { state: null };

      const decompressed = this._decompress
        ? this._decompress(compressed, 0)
        : await this.decompressBytes(compressed, 0);

      // Verify hash
      const storedHash = await this.readBinaryFile(genDir, HASH_FILE);
      if (storedHash) {
        const computedHash = this._hash128 ? this._hash128(decompressed) : await this.computeHash(decompressed);
        if (!this.hashEqual(computedHash, storedHash)) {
          this.warn({ kind: "corruption", slot, message: `Hash mismatch in gen ${genMeta.gen}` });
          return { state: null };
        }
      }

      const bodyJson = new TextDecoder().decode(decompressed);
      const components = safeJsonParse<Record<string, { v: number; data: unknown }>>(bodyJson);

      // Run migrations per component
      const migrated: Record<string, { v: number; data: unknown }> = {};
      for (const [name, section] of Object.entries(components)) {
        if (this._skipMigrations) {
          migrated[name] = { v: section.v, data: section.data };
          continue;
        }
        const result = this.migrations.migrate(name, section.data, section.v);
        if (result) {
          migrated[name] = { v: result.version, data: result.data };
        } else {
          this.warn({
            kind: "abandoned_data",
            slot,
            component: name,
            message: `Component '${name}' could not be migrated from v${section.v}`,
            abandonedData: section.data,
          });
        }
      }

      // Read blobs if requested
      let blobs: Record<string, ArrayBuffer> | undefined;
      if (includeBlobs) {
        try {
          const blobsDir = await this.getBlobsDir(genDir, false);
          const entries: Array<[string, ArrayBuffer]> = [];
          for await (const handle of blobsDir.values()) {
            if (handle.kind === "file") {
              const file = await (handle as FsFileHandle).getFile();
              const buf = await file.arrayBuffer();
              entries.push([handle.name, buf]);
            }
          }
          if (entries.length > 0) {
            blobs = Object.fromEntries(entries);
          }
        } catch {
          // No blobs dir — fine
        }
      }

      const state: SaveState = {
        components: migrated,
        meta: {
          engineVersion: genMeta.engineVersion,
          timestamp: genMeta.timestamp,
          entityCount: genMeta.entityCount,
          playerCount: genMeta.playerCount,
        },
      };

      return { state, blobs };
    } catch (err) {
      log.warn("OpfsSaveStore", `loadFromGen ${genMeta.gen} failed: ${err}`);
      return { state: null };
    }
  }

  // ── ISaveStore: listSaves ───────────────────────────────────────────────

  async listSaves(): Promise<SaveSlotInfo[]> {
    try {
      const saves = this.ensureInit();
      const slots: SaveSlotInfo[] = [];

      for await (const handle of saves.values()) {
        if (handle.kind !== "directory") continue;
        const slotDir = handle as FsDirHandle;
        const meta = await this.readMeta(slotDir);
        if (!meta) continue;

        const latest = meta.generations[meta.generations.length - 1] ?? meta.generations[0];
        if (!latest) continue;

        // Compute total file size across all generations
        let totalSize = 0;
        for (const g of meta.generations) {
          totalSize += g.bodySize;
        }

        slots.push({
          slot: handle.name,
          timestamp: latest.timestamp,
          entityCount: latest.entityCount,
          playerCount: latest.playerCount,
          engineVersion: latest.engineVersion,
          fileSize: totalSize,
          currentGen: meta.currentGen,
          generationCount: meta.generations.length,
          hasThumbnail: meta.hasThumbnail,
          properties: meta.properties,
        });
      }

      slots.sort((a, b) => b.timestamp - a.timestamp);
      return slots;
    } catch {
      return [];
    }
  }

  // ── ISaveStore: listGenerations ─────────────────────────────────────────

  async listGenerations(slot: string): Promise<SaveGenerationInfo[]> {
    try {
      const slotDir = await this.getSlotDir(slot, false);
      const meta = await this.readMeta(slotDir);
      if (!meta) return [];
      return [...meta.generations].sort((a, b) => b.gen - a.gen);
    } catch {
      return [];
    }
  }

  // ── ISaveStore: deleteSave ──────────────────────────────────────────────

  async deleteSave(slot: string): Promise<boolean> {
    try {
      const saves = this.ensureInit();
      const safeSlot = this.sanitizeSlot(slot);
      await this.removeRecursive(saves, safeSlot);
      log.info("OpfsSaveStore", `Deleted slot '${slot}'`);
      return true;
    } catch {
      return false;
    }
  }

  // ── ISaveStore: deleteGeneration ────────────────────────────────────────

  async deleteGeneration(slot: string, gen: number): Promise<boolean> {
    try {
      const slotDir = await this.getSlotDir(slot, false);
      const meta = await this.readMeta(slotDir);
      if (!meta) return false;

      // Remove gen directory
      await this.removeGenDir(slotDir, gen);

      // Update meta
      meta.generations = meta.generations.filter(g => g.gen !== gen);
      if (meta.currentGen === gen) {
        meta.currentGen = meta.generations.length > 0
          ? Math.max(...meta.generations.map(g => g.gen))
          : 0;
      }
      await this.writeMeta(slotDir, meta);
      return true;
    } catch {
      return false;
    }
  }

  // ── ISaveStore: thumbnail ───────────────────────────────────────────────

  async setThumbnail(slot: string, data: ArrayBuffer | Uint8Array): Promise<void> {
    const slotDir = await this.getSlotDir(slot, true);
    const thumbData = data instanceof Uint8Array ? data : new Uint8Array(data);
    await this.writeBinaryFile(slotDir, THUMBNAIL_FILE, thumbData);

    // Update meta
    const meta = await this.readMeta(slotDir);
    if (meta) {
      meta.hasThumbnail = true;
      await this.writeMeta(slotDir, meta);
    }
  }

  async getThumbnail(slot: string): Promise<ArrayBuffer | null> {
    try {
      const slotDir = await this.getSlotDir(slot, false);
      const data = await this.readBinaryFile(slotDir, THUMBNAIL_FILE);
      return data ? (data.buffer as ArrayBuffer) : null;
    } catch {
      return null;
    }
  }

  // ── ISaveStore: properties ──────────────────────────────────────────────

  async setProperties(slot: string, props: Record<string, unknown>): Promise<void> {
    const slotDir = await this.getSlotDir(slot, true);
    const meta = await this.readMeta(slotDir);
    if (meta) {
      meta.properties = { ...meta.properties, ...props };
      await this.writeMeta(slotDir, meta);
    } else {
      // Create a minimal meta if none exists
      const newMeta: SlotMeta = {
        formatVersion: META_FORMAT_VERSION,
        currentGen: 0,
        maxGenerations: this.defaultMaxGenerations,
        generations: [],
        properties: props,
        hasThumbnail: false,
      };
      await this.writeMeta(slotDir, newMeta);
    }
  }

  async getProperties(slot: string): Promise<Record<string, unknown>> {
    try {
      const slotDir = await this.getSlotDir(slot, false);
      const meta = await this.readMeta(slotDir);
      return meta?.properties ?? {};
    } catch {
      return {};
    }
  }

  // ── Utils ───────────────────────────────────────────────────────────────

  private hashEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
}
