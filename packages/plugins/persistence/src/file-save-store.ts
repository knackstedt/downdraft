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

import {
    encodeHeader,
    engineVersionString,
    HEADER_SIZE,
    packEngineVersion,
    readHeaderFromFile,
    SAVE_FORMAT_VERSION,
    SAVE_MAGIC,
    type SaveHeader
} from "@downdraft/core/save/binary-format";
import { MigrationRegistryImpl } from "@downdraft/core/save/migration-registry";
import type {
    IMigrationRegistry,
    ISaveStore,
    LoadResult,
    SaveResult,
    SaveSlotInfo,
    SaveState,
    SaveWarning,
} from "@downdraft/core/save/persist-types";
import { createLogger } from "@downdraft/core/util/logger";
import { promises as fs } from "node:fs";
import { join } from "node:path";

const log = createLogger("info");

const SAVE_EXT = ".ddsave";
const BACKUP_EXT = ".ddsave.bak";

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
    return this.zstdReady;
  }

  private async computeHash(data: Uint8Array): Promise<Uint8Array> {
    const xxh = await import("xxhash-wasm");
    const instance = await xxh.default();
    const h64 = instance.h64Raw(data);
    // Pad 8-byte h64 to 16-byte hash
    const result = new Uint8Array(16);
    result.set(h64, 0);
    return result;
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

  async save(slot: string, state: SaveState): Promise<SaveResult> {
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

      // Rotate previous save to backup
      try {
        await fs.access(filePath);
        await fs.rename(filePath, bakPath);
      } catch {
        // No existing file — fine
      }

      // Write new save
      const fileBuf = new Uint8Array(headerBuf.byteLength + compressed.length);
      fileBuf.set(new Uint8Array(headerBuf), 0);
      fileBuf.set(compressed, headerBuf.byteLength);
      await fs.writeFile(filePath, fileBuf);

      log.info("FileSaveStore", `Saved slot '${slot}' (${fileBuf.length} bytes)`);
      return { success: true, bytes: fileBuf.length };
    } catch (err) {
      log.error("FileSaveStore", `Save failed for slot '${slot}': ${err}`);
      return { success: false, bytes: 0 };
    }
  }

  async load(slot: string): Promise<LoadResult> {
    const filePath = this.slotPath(slot);
    const bakPath = filePath + ".bak";

    const result = await this.loadFromFile(filePath, slot);
    if (result.state) return result;

    // Try backup
    const bakResult = await this.loadFromFile(bakPath, slot);
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

  private async loadFromFile(filePath: string, slot: string): Promise<LoadResult> {
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
      const components = JSON.parse(bodyJson) as Record<string, { v: number; data: unknown }>;

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
      return { state };
    } catch (err) {
      // File doesn't exist or other error — return null silently
      return { state: null };
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

        saves.push({
          slot: file.replace(SAVE_EXT, ""),
          timestamp: header.timestamp,
          entityCount: header.entityCount,
          playerCount: header.playerCount,
          engineVersion: engineVersionString(header.engineVersionPacked),
          fileSize: stat.size,
        });
      }

      saves.sort((a, b) => b.timestamp - a.timestamp);
      return saves;
    } catch {
      return [];
    }
  }

  async deleteSave(slot: string): Promise<boolean> {
    const filePath = this.slotPath(slot);
    const bakPath = filePath + ".bak";
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
    return deleted;
  }

  private slotPath(slot: string): string {
    // Sanitize slot name to prevent path traversal
    const safe = slot.replace(/[^a-zA-Z0-9_\-]/g, "_");
    return join(this.saveDir, safe + SAVE_EXT);
  }

  private hashEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
}
