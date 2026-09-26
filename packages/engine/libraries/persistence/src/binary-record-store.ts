// ============================================================================
// BinaryRecordStore — versioned keyed binary records over OPFS.
//
// For incremental persistence that doesn't fit whole-state ISaveStore
// snapshots (e.g. voxel chunk worlds where only dirty regions are written).
// Callers work with `Map<string, Uint8Array>` — the store owns the file
// layout, the OPFS handle, and version validation.
//
// File layout (all integers little-endian):
//   [u32 magic] [u32 version] [u32 recordCount]
//   per record: [u32 keyByteLen] [u32 payloadByteLen] [key utf8] [payload]
//
// A version mismatch discards old records (or routes them through `migrate`)
// rather than failing — a stale-format save should never wedge the game.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger("info");

export interface BinaryRecordStoreOptions {
  /** File name within `directory` (e.g. "chunks.bin"). */
  fileName: string;
  /** Application magic — rejects files written by a different format. */
  magic: number;
  /** Current format version. */
  version: number;
  /** Directory path segments under the OPFS root. Default: root. */
  directory?: string[];
  /**
   * Root directory handle — defaults to `navigator.storage.getDirectory()`.
   * Injectable for tests and non-OPFS backends.
   */
  root?: FileSystemDirectoryHandle;
  /**
   * Optional migration for version-mismatched files. Receives the old
   * version + parsed records; return the replacement records (written under
   * the current version on next save) or null to discard.
   */
  migrate?: (
    fromVersion: number,
    records: Map<string, Uint8Array>,
  ) => Map<string, Uint8Array> | null | Promise<Map<string, Uint8Array> | null>;
  /** Log tag prefix. Default: "BinaryRecordStore". */
  logTag?: string;
}

export interface IBinaryRecordStore {
  /**
   * Read all records. Empty map when the file is absent, the magic doesn't
   * match, the version is rejected, or OPFS is unavailable.
   */
  readAll(): Promise<Map<string, Uint8Array>>;
  /**
   * Merge-write: upsert the given records, preserve all others. Returns the
   * number of records written (0 when the write failed — callers can retry
   * later without losing unsaved state).
   */
  write(records: Iterable<[string, Uint8Array]>): Promise<number>;
  /** Remove the given keys, preserving everything else. Returns removed count. */
  delete(keys: Iterable<string>): Promise<number>;
  /** Delete the backing file entirely. */
  deleteAll(): Promise<void>;
}

const HEADER_BYTES = 12;
const RECORD_HEADER_BYTES = 8; // keyLen(4) + payloadLen(4)

export class BinaryRecordStore implements IBinaryRecordStore {
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private tag: string;

  constructor(private opts: BinaryRecordStoreOptions) {
    this.tag = (opts.logTag ?? "BinaryRecordStore").replace(/^\[|\]$/g, "");
  }

  private async getRoot(): Promise<FileSystemDirectoryHandle | null> {
    if (this.opts.root) return this.opts.root;
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
      return null;
    }
    return navigator.storage.getDirectory();
  }

  private async getFileHandle(create: boolean): Promise<FileSystemFileHandle | null> {
    let dir = await this.getRoot();
    if (!dir) return null;
    for (const seg of this.opts.directory ?? []) {
      dir = await dir.getDirectoryHandle(seg, { create });
    }
    return dir.getFileHandle(this.opts.fileName, { create });
  }

  /** Parse the raw file bytes into a record map, or null if unreadable/foreign. */
  private parse(buf: ArrayBuffer): Map<string, Uint8Array> | null {
    if (buf.byteLength < HEADER_BYTES) return null;
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== this.opts.magic) return null;
    const count = dv.getUint32(8, true);
    const records = new Map<string, Uint8Array>();
    let offset = HEADER_BYTES;
    for (let i = 0; i < count; i++) {
      if (offset + RECORD_HEADER_BYTES > buf.byteLength) break;
      const keyLen = dv.getUint32(offset, true);
      const payloadLen = dv.getUint32(offset + 4, true);
      offset += RECORD_HEADER_BYTES;
      if (offset + keyLen + payloadLen > buf.byteLength) break;
      const key = this.decoder.decode(new Uint8Array(buf, offset, keyLen));
      offset += keyLen;
      // Copy the payload so the map doesn't retain the whole file buffer.
      records.set(key, new Uint8Array(buf.slice(offset, offset + payloadLen)));
      offset += payloadLen;
    }
    return records;
  }

  /**
   * Read + validate the file, returning records at the CURRENT version
   * (migrated if needed). Returns null when the file is absent or foreign.
   */
  private async readCurrent(): Promise<Map<string, Uint8Array> | null> {
    const handle = await this.getFileHandle(false).catch(() => null);
    if (!handle) return null;
    const buf = await (await handle.getFile()).arrayBuffer();
    if (buf.byteLength < HEADER_BYTES) return null;
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== this.opts.magic) return null;
    const version = dv.getUint32(4, true);
    const records = this.parse(buf);
    if (version === this.opts.version) return records ?? new Map();
    if (!this.opts.migrate) {
      log.warn(
        this.tag,
        `${this.opts.fileName}: discarding save with version ${version} (expected ${this.opts.version})`,
      );
      return new Map();
    }
    const migrated = await this.opts.migrate(version, records ?? new Map());
    return migrated ?? new Map();
  }

  private serialize(records: Map<string, Uint8Array>): ArrayBuffer {
    let total = HEADER_BYTES;
    const keys = new Map<string, Uint8Array>();
    for (const [key, payload] of records) {
      const keyBytes = this.encoder.encode(key);
      keys.set(key, keyBytes);
      total += RECORD_HEADER_BYTES + keyBytes.byteLength + payload.byteLength;
    }
    const buf = new ArrayBuffer(total);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    dv.setUint32(0, this.opts.magic, true);
    dv.setUint32(4, this.opts.version, true);
    dv.setUint32(8, records.size, true);
    let offset = HEADER_BYTES;
    for (const [key, payload] of records) {
      const keyBytes = keys.get(key)!;
      dv.setUint32(offset, keyBytes.byteLength, true);
      dv.setUint32(offset + 4, payload.byteLength, true);
      offset += RECORD_HEADER_BYTES;
      u8.set(keyBytes, offset);
      offset += keyBytes.byteLength;
      u8.set(payload, offset);
      offset += payload.byteLength;
    }
    return buf;
  }

  private async writeFile(records: Map<string, Uint8Array>): Promise<boolean> {
    const handle = await this.getFileHandle(true);
    if (!handle) return false;
    const writable = await handle.createWritable();
    // Uint8Array view — some writable impls accept only ArrayBufferView.
    await writable.write(new Uint8Array(this.serialize(records)));
    await writable.close();
    return true;
  }

  async readAll(): Promise<Map<string, Uint8Array>> {
    try {
      return (await this.readCurrent()) ?? new Map();
    } catch (e) {
      log.warn(this.tag, `readAll failed: ${e}`);
      return new Map();
    }
  }

  async write(records: Iterable<[string, Uint8Array]>): Promise<number> {
    try {
      const updates = new Map(records);
      if (updates.size === 0) return 0;
      const merged = (await this.readCurrent()) ?? new Map();
      for (const [key, payload] of updates) merged.set(key, payload);
      if (!(await this.writeFile(merged))) return 0;
      return updates.size;
    } catch (e) {
      log.warn(this.tag, `write failed: ${e}`);
      return 0;
    }
  }

  async delete(keys: Iterable<string>): Promise<number> {
    try {
      const merged = (await this.readCurrent()) ?? new Map();
      let removed = 0;
      for (const key of keys) removed += merged.delete(key) ? 1 : 0;
      if (removed === 0) return 0;
      if (!(await this.writeFile(merged))) return 0;
      return removed;
    } catch (e) {
      log.warn(this.tag, `delete failed: ${e}`);
      return 0;
    }
  }

  async deleteAll(): Promise<void> {
    try {
      let dir: FileSystemDirectoryHandle | null = await this.getRoot();
      if (!dir) return;
      for (const seg of this.opts.directory ?? []) {
        dir = await dir.getDirectoryHandle(seg).catch(() => null);
        if (!dir) return; // directory chain absent → file can't exist
      }
      await dir.removeEntry(this.opts.fileName).catch(() => {});
    } catch (e) {
      log.warn(this.tag, `deleteAll failed: ${e}`);
    }
  }
}

export function createBinaryRecordStore(opts: BinaryRecordStoreOptions): IBinaryRecordStore {
  return new BinaryRecordStore(opts);
}
