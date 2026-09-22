// ============================================================================
// FileSaveStore — filesystem-based ISaveStore implementation
// ============================================================================
//
// Saves are written as binary files with an uncompressed header (magic,
// format version, engine version, timestamp, entity/player counts, XXH128
// hash, uncompressed body length) followed by a zstd-compressed JSON body.
//
// On save, the previous file is rotated to `.bak`. On load failure (hash
// mismatch, parse error, migration error), the `.bak` is tried as fallback.
//
// Forward incompatibility: saves from a newer engine version are refused.
// Consumers should implement version backups for unstable releases.

import { safeJsonParse } from "@downdraft/engine";
import {
    encodeHeader,
    engineVersionString,
    HEADER_SIZE,
    packEngineVersion,
    readHeaderFromFile,
    SAVE_FORMAT_VERSION,
    SAVE_MAGIC,
    type SaveHeader
} from "@downdraft/engine/save/binary-format";
import { MigrationRegistryImpl } from "@downdraft/engine/save/migration-registry";
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
    SaveWarning
} from "@downdraft/engine/save/persist-types";
import { createLogger } from "@downdraft/engine/util/logger";
import { promises as fs } from "node:fs";
import { join } from "node:path";

const log = createLogger("info");

const SAVE_EXT = ".ddsave";
const BACKUP_EXT = ".ddsave.bak";
const THUMB_EXT = ".thumb";
const PROPS_EXT = ".props.json";
const BLOBS_DIR_SUFFIX = ".blobs";

export interface FileSaveStoreOptions {
  /** Directory to store save files (typically app.getPath("userData") + "/saves") */
  saveDir: string;
  /** Current engine/game version string (e.g. "0.1.0") */
  engineVersion: string;
  /** Migration registry (optional — a new one is created if not provided) */
  migrationRegistry?: IMigrationRegistry;
  /** Optional compression provider (for testing or custom compression) */
  compress?: (data: Uint8Array) => Uint8Array;
  /** Optional decompression provider (for testing or custom compression) */
  decompress?: (data: Uint8Array, originalSize: number) => Uint8Array;
  /** Optional hash provider (for testing or custom hashing) */
  hash128?: (data: Uint8Array) => Uint8Array;
  /** Skip migration step on load — pass through components unchanged (for pure storage layers) */
  skipMigrations?: boolean;
}

export class FileSaveStore implements ISaveStore {
  private saveDir: string;
  private engineVersionPacked: number;
  private migrations: IMigrationRegistry;
  private warningCallbacks: Array<(w: SaveWarning) => void> = [];
  private zstdReady: Promise<void> | null = null;
  private _compress: ((data: Uint8Array) => Uint8Array) | null = null;
  private _decompress: ((data: Uint8Array, originalSize: number) => Uint8Array) | null = null;
  private _hash128: ((data: Uint8Array) => Uint8Array) | null = null;
  private _skipMigrations: boolean = false;

  constructor(opts: FileSaveStoreOptions) {
    this.saveDir = opts.saveDir;
    const parts = opts.engineVersion.split(".").map(Number);
    this.engineVersionPacked = packEngineVersion(parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0);
    this.migrations = opts.migrationRegistry ?? new MigrationRegistryImpl();
    this._compress = opts.compress ?? null;
    this._decompress = opts.decompress ?? null;
    this._hash128 = opts.hash128 ?? null;
    this._skipMigrations = opts.skipMigrations ?? false;
  }

  getMigrationRegistry(): IMigrationRegistry {
    return this.migrations;
  }

  onWarning(cb: (warning: SaveWarning) => void): () => void {
    this.warningCallbacks.push(cb);
    return () => {
      const idx = this.warningCallbacks.indexOf(cb);
      if (idx >= 0) this.warningCallbacks.splice(idx, 1);
    };
  }

  private warn(warning: SaveWarning): void {
    for (const cb of this.warningCallbacks) {
      try {
        cb(warning);
      } catch {
        // ignore callback errors
      }
    }
  }

  private async ensureZstd(): Promise<void> {
    if (this.zstdReady) return this.zstdReady;
    this.zstdReady = (async () => {
      const { init } = await import("@bokuweb/zstd-wasm");
      await init();
    })();
    // Don't cache a rejection forever — a transient failure (missing wasm
    // asset, fs hiccup) would otherwise permanently break all saves.
    this.zstdReady.catch(() => { this.zstdReady = null; });
    return this.zstdReady;
  }

  private async computeHash(data: Uint8Array): Promise<Uint8Array> {
    // True XXH3-128 hash (16 bytes) — no longer padded h64.
    const { xxh3_128 } = await import("./hash-utils");
    return xxh3_128(data);
  }

  private async compressBytes(data: Uint8Array): Promise<Uint8Array> {
    await this.ensureZstd();
    const { compress } = await import("@bokuweb/zstd-wasm");
    return compress(data);
  }

  private async decompressBytes(data: Uint8Array, originalSize: number): Promise<Uint8Array> {
    await this.ensureZstd();
    const { decompress } = await import("@bokuweb/zstd-wasm");
    return decompress(data);
  }

  // Saves are serialized — concurrent save() calls (e.g. an autosave tick
  // racing a sim-emitted 'saved' event forwarded through the bridge) share
  // the same .tmp path and would otherwise rename-fail with ENOENT.
  private saveQueue: Promise<unknown> = Promise.resolve();

  async save(slot: string, state: SaveState, opts?: SaveOptions): Promise<SaveResult> {
    const run = this.saveQueue.then(() => this.doSave(slot, state, opts));
    this.saveQueue = run.catch(() => { /* error reported via SaveResult */ });
    return run;
  }

  private async doSave(slot: string, state: SaveState, opts?: SaveOptions): Promise<SaveResult> {
    try {
      await fs.mkdir(this.saveDir, { recursive: true });
      const bodyJson = JSON.stringify(state.components);
      const bodyBytes = new TextEncoder().encode(bodyJson);

      const hashBytes = this._hash128 ? this._hash128(bodyBytes) : await this.computeHash(bodyBytes);
      const compressed = this._compress ? this._compress(bodyBytes) : await this.compressBytes(bodyBytes);

      const header: SaveHeader = {
        magic: SAVE_MAGIC,
        formatVersion: SAVE_FORMAT_VERSION,
        engineVersionPacked: this.engineVersionPacked,
        timestamp: state.meta.timestamp,
        entityCount: state.meta.entityCount,
        playerCount: state.meta.playerCount,
        bodyHash: hashBytes,
        uncompressedBodyLength: bodyBytes.length,
      };

      const headerBuf = encodeHeader(header);
      const filePath = this.slotPath(slot);
      const bakPath = filePath + ".bak";
      const tmpPath = filePath + ".tmp";

      const blobsDir = this.blobsDirPath(slot);
      const bakBlobsDir = blobsDir + ".bak";
      const tmpBlobsDir = blobsDir + ".tmp";

      // Phase 1: Write everything to temp locations first.
      // If the process crashes here, the old save is still intact.
      // Clean up any stale temp blobs dir from a crashed previous save so its
      // leftover files don't get renamed into the final blobs dir.
      try { await fs.rm(tmpBlobsDir, { recursive: true, force: true }); } catch { /* ignore */ }
      const fileBuf = new Uint8Array(headerBuf.byteLength + compressed.length);
      fileBuf.set(new Uint8Array(headerBuf), 0);
      fileBuf.set(compressed, headerBuf.byteLength);
      await fs.writeFile(tmpPath, fileBuf);

      // Write blobs to temp dir
      let blobBytes = 0;
      if (opts?.blobs && Object.keys(opts.blobs).length > 0) {
        await fs.mkdir(tmpBlobsDir, { recursive: true });
        for (const [key, buf] of Object.entries(opts.blobs) as Array<[string, ArrayBuffer]>) {
          const safeKey = key.replace(/[^a-zA-Z0-9_\-]/g, "_");
          await fs.writeFile(join(tmpBlobsDir, safeKey), new Uint8Array(buf));
          blobBytes += buf.byteLength;
        }
      }

      // Phase 2: All writes succeeded — now rotate old → .bak, then rename .tmp → final.
      // This minimizes the crash-corruption window: the old save is only rotated
      // after the new save is fully written to .tmp.
      try {
        await fs.access(filePath);
        await fs.rename(filePath, bakPath);
      } catch {
        // No existing file — fine
      }
      try {
        await fs.access(blobsDir);
        // Remove a stale .bak blobs dir first: renaming a directory onto an
        // existing non-empty directory fails with ENOTEMPTY on Linux, which
        // would leave blobsDir in place and cause the .tmp → final rename
        // below to fail with ENOTEMPTY as well.
        try { await fs.rm(bakBlobsDir, { recursive: true, force: true }); } catch { /* ignore */ }
        await fs.rename(blobsDir, bakBlobsDir);
      } catch {
        // No existing blobs dir — fine
      }

      // Atomic rename: .tmp → final
      await fs.rename(tmpPath, filePath);
      // Rename temp blobs dir → final
      if (opts?.blobs && Object.keys(opts.blobs).length > 0) {
        await fs.rename(tmpBlobsDir, blobsDir);
      }

      // Write thumbnail if provided (not part of the atomic commit — thumbnail is non-critical)
      if (opts?.thumbnail) {
        const thumbData = opts.thumbnail instanceof Uint8Array ? opts.thumbnail : new Uint8Array(opts.thumbnail);
        await fs.writeFile(this.thumbPath(slot), thumbData);
      }

      // Write properties if provided (not part of the atomic commit — properties are non-critical)
      if (opts?.properties) {
        await fs.writeFile(this.propsPath(slot), JSON.stringify(opts.properties, null, 2));
      }

      log.info("FileSaveStore", `Saved slot '${slot}' (${fileBuf.length + blobBytes} bytes)`);
      return { success: true, bytes: fileBuf.length + blobBytes, gen: 1 };
    } catch (err) {
      log.error("FileSaveStore", `Save failed for slot '${slot}': ${err}`);
      return { success: false, bytes: 0 };
    }
  }

  async load(slot: string, opts?: LoadOptions): Promise<LoadResult> {
    const filePath = this.slotPath(slot);
    const bakPath = filePath + ".bak";
    const includeBlobs = opts?.includeBlobs ?? true;

    const result = await this.loadFromFile(filePath, slot, includeBlobs);
    if (result.state) return result;

    // Try backup
    const bakResult = await this.loadFromFile(bakPath, slot, includeBlobs);
    if (bakResult.state) {
      this.warn({
        kind: "backup_loaded",
        slot,
        message: `Primary save failed, loaded backup for slot '${slot}'`,
      });
      return bakResult;
    }

    this.warn({
      kind: "no_saves_found",
      slot,
      message: `No valid save found for slot '${slot}'`,
    });
    return { state: null };
  }

  private async loadFromFile(filePath: string, slot: string, includeBlobs: boolean): Promise<LoadResult> {
    try {
      const fileBuf = await fs.readFile(filePath);
      const header = readHeaderFromFile(fileBuf.buffer);
      if (!header) {
        this.warn({ kind: "corruption", slot, message: `Invalid header in ${filePath}` });
        return { state: null };
      }

      // Forward incompatibility check
      if (header.engineVersionPacked > this.engineVersionPacked) {
        const saveVer = engineVersionString(header.engineVersionPacked);
        this.warn({
          kind: "forward_incompatible",
          slot,
          message: `Save version ${saveVer} > engine version — refusing to load`,
        });
        return { state: null };
      }

      const compressedBody = new Uint8Array(fileBuf.buffer, HEADER_SIZE);
      const decompressed = this._decompress
        ? this._decompress(compressedBody, header.uncompressedBodyLength)
        : await this.decompressBytes(compressedBody, header.uncompressedBodyLength);

      // Verify hash
      const computedHash = this._hash128 ? this._hash128(decompressed) : await this.computeHash(decompressed);
      if (!this.hashEqual(computedHash, header.bodyHash)) {
        this.warn({ kind: "corruption", slot, message: `Hash mismatch in ${filePath}` });
        return { state: null };
      }

      const bodyJson = new TextDecoder().decode(decompressed);
      const components = safeJsonParse<Record<string, { v: number; data: unknown }>>(bodyJson);

      // Run migrations per component (or pass through if skipped)
      const migrated: Record<string, { v: number; data: unknown }> = {};
      const abandoned: Record<string, unknown> = {};

      for (const [name, section] of Object.entries(components)) {
        if (this._skipMigrations) {
          migrated[name] = { v: section.v, data: section.data };
          continue;
        }
        const result = this.migrations.migrate(name, section.data, section.v);
        if (result) {
          migrated[name] = { v: result.version, data: result.data };
        } else {
          // Mark as abandoned — keep data but don't load it
          abandoned[name] = section.data;
          this.warn({
            kind: "abandoned_data",
            slot,
            component: name,
            message: `Component '${name}' could not be migrated from v${section.v}`,
            abandonedData: section.data,
          });
        }
      }

      const state: SaveState = {
        components: migrated,
        meta: {
          engineVersion: engineVersionString(header.engineVersionPacked),
          timestamp: header.timestamp,
          entityCount: header.entityCount,
          playerCount: header.playerCount,
        },
      };

      log.info("FileSaveStore", `Loaded slot '${slot}'`);
      // Load blobs if requested
      let blobs: Record<string, ArrayBuffer> | undefined;
      if (includeBlobs) {
        blobs = await this.loadBlobs(slot);
        if (blobs && Object.keys(blobs).length === 0) blobs = undefined;
      }
      return { state, blobs, gen: 1 };
    } catch (err) {
      // File doesn't exist or other error — return null silently
      return { state: null };
    }
  }

  private async loadBlobs(slot: string): Promise<Record<string, ArrayBuffer> | undefined> {
    try {
      const blobsDir = this.blobsDirPath(slot);
      const files = await fs.readdir(blobsDir);
      const blobs: Record<string, ArrayBuffer> = {};
      for (const file of files) {
        const buf = await fs.readFile(join(blobsDir, file));
        blobs[file] = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      }
      return blobs;
    } catch {
      return undefined;
    }
  }

  async listSaves(): Promise<SaveSlotInfo[]> {
    try {
      const files = await fs.readdir(this.saveDir);
      const saves: SaveSlotInfo[] = [];

      for (const file of files) {
        if (!file.endsWith(SAVE_EXT)) continue;
        const filePath = join(this.saveDir, file);
        const stat = await fs.stat(filePath);
        const fileBuf = await fs.readFile(filePath);
        const header = readHeaderFromFile(fileBuf.buffer);
        if (!header) continue;

        const slotName = file.replace(SAVE_EXT, "");
        const hasThumbnail = await this.fileExists(this.thumbPath(slotName));
        const properties = await this.readProps(slotName);

        saves.push({
          slot: slotName,
          timestamp: header.timestamp,
          entityCount: header.entityCount,
          playerCount: header.playerCount,
          engineVersion: engineVersionString(header.engineVersionPacked),
          fileSize: stat.size,
          currentGen: 1,
          generationCount: 1,
          hasThumbnail,
          properties: Object.keys(properties).length > 0 ? properties : undefined,
        });
      }

      saves.sort((a, b) => b.timestamp - a.timestamp);
      return saves;
    } catch {
      return [];
    }
  }

  async listGenerations(slot: string): Promise<SaveGenerationInfo[]> {
    try {
      const filePath = this.slotPath(slot);
      const fileBuf = await fs.readFile(filePath);
      const header = readHeaderFromFile(fileBuf.buffer);
      if (!header) return [];
      const stat = await fs.stat(filePath);
      return [{
        gen: 1,
        timestamp: header.timestamp,
        engineVersion: engineVersionString(header.engineVersionPacked),
        entityCount: header.entityCount,
        playerCount: header.playerCount,
        bodySize: stat.size,
        blobCount: 0,
      }];
    } catch {
      return [];
    }
  }

  async deleteGeneration(slot: string, _gen: number): Promise<boolean> {
    // FileSaveStore only has one "generation" — deleting it deletes the slot
    if (_gen !== 1) return false;
    return this.deleteSave(slot);
  }

  async setThumbnail(slot: string, data: ArrayBuffer | Uint8Array): Promise<void> {
    const thumbData = data instanceof Uint8Array ? data : new Uint8Array(data);
    await fs.writeFile(this.thumbPath(slot), thumbData);
  }

  async getThumbnail(slot: string): Promise<ArrayBuffer | null> {
    try {
      const buf = await fs.readFile(this.thumbPath(slot));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch {
      return null;
    }
  }

  async setProperties(slot: string, props: Record<string, unknown>): Promise<void> {
    const existing = await this.readProps(slot);
    const merged = { ...existing, ...props };
    await fs.writeFile(this.propsPath(slot), JSON.stringify(merged, null, 2));
  }

  async getProperties(slot: string): Promise<Record<string, unknown>> {
    return this.readProps(slot);
  }

  private async readProps(slot: string): Promise<Record<string, unknown>> {
    try {
      const text = await fs.readFile(this.propsPath(slot), "utf-8");
      return safeJsonParse<Record<string, unknown>>(text);
    } catch {
      return {};
    }
  }

  private async fileExists(path: string): Promise<boolean> {
    try { await fs.access(path); return true; } catch { return false; }
  }

  async deleteSave(slot: string): Promise<boolean> {
    const filePath = this.slotPath(slot);
    const bakPath = filePath + ".bak";
    const tmpPath = filePath + ".tmp";
    let deleted = false;
    try {
      await fs.unlink(filePath);
      deleted = true;
    } catch {
      // ignore
    }
    try {
      await fs.unlink(bakPath);
      deleted = true;
    } catch {
      // ignore
    }
    try {
      await fs.unlink(tmpPath);
    } catch {
      // ignore — orphaned temp from a crashed save
    }
    // Clean up blobs, thumbnail, properties, and orphaned temp files
    try { await fs.rm(this.blobsDirPath(slot), { recursive: true, force: true }); } catch {}
    try { await fs.rm(this.blobsDirPath(slot) + ".bak", { recursive: true, force: true }); } catch {}
    try { await fs.rm(this.blobsDirPath(slot) + ".tmp", { recursive: true, force: true }); } catch {}
    try { await fs.unlink(this.thumbPath(slot)); } catch {}
    try { await fs.unlink(this.propsPath(slot)); } catch {}
    return deleted;
  }

  private slotPath(slot: string): string {
    // Sanitize slot name to prevent path traversal
    const safe = slot.replace(/[^a-zA-Z0-9_\-]/g, "_");
    return join(this.saveDir, safe + SAVE_EXT);
  }

  private blobsDirPath(slot: string): string {
    const safe = slot.replace(/[^a-zA-Z0-9_\-]/g, "_");
    return join(this.saveDir, safe + BLOBS_DIR_SUFFIX);
  }

  private thumbPath(slot: string): string {
    const safe = slot.replace(/[^a-zA-Z0-9_\-]/g, "_");
    return join(this.saveDir, safe + THUMB_EXT);
  }

  private propsPath(slot: string): string {
    const safe = slot.replace(/[^a-zA-Z0-9_\-]/g, "_");
    return join(this.saveDir, safe + PROPS_EXT);
  }

  private hashEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
}
