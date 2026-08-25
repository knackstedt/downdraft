// ============================================================================
// FirebirdSaveStore — Firebird-backed ISaveStore implementation
// ============================================================================
//
// Stores save slots as rows in a Firebird database file (one .fdb per store),
// using firebird-wasm's FirebirdLite (Node.js native, embedded engine via
// libfbclient). Each slot keeps two generations: 0 = current, 1 = previous
// (backup). On load failure of generation 0 (hash mismatch, parse error,
// migration error), generation 1 is tried as fallback — mirroring FileSaveStore's
// `.bak` rotation.
//
// The compressed JSON body and the 16-byte XXH128 hash are stored as binary
// BLOBs. firebird-wasm returns BLOB columns as lazy `Blob` references tied to
// the transaction that fetched them, so loads run inside an explicit
// `db.transaction()` and read the BLOBs via the transaction's attachment
// (`openBlob` → `BlobStream.read`). The `attachment`/`transaction` fields are
// not on firebird-wasm's public type surface, so they are reached through a
// minimal cast — see `readBlobFully`.
//
// Requirements:
//   - libfbclient.so / fbclient.dll on the system library path.
//   - A writable Firebird lock/tmp directory. By default Firebird uses
//     /tmp/firebird (root/firebird-owned on most distros). If
//     FIREBIRD_LOCK / FIREBIRD_TMP are not already set, the constructor
//     points them at a per-user tmp dir so embedded mode works without root.
//
// This is an alternative storage backend for ISaveStore, useful when a single
// queryable database is preferred over many .ddsave files (e.g. listing,
// metadata queries, atomic multi-slot operations).

import { safeJsonParse } from "@downdraft/core/safety/json";
import { engineVersionString, packEngineVersion, type SaveHeader } from "@downdraft/core/save/binary-format";
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
import { FirebirdLite, type FirebirdLiteOptions, type FirebirdTransaction } from "firebird-wasm";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const log = createLogger("info");

// Minimal shapes of node-firebird-driver's Attachment / Transaction / Blob /
// BlobStream, used only to read BLOBs inside a firebird-wasm transaction.
// firebird-wasm does not expose these on its public API, so we reach them
// through the FirebirdTransaction's internal fields.
interface DriverBlob {
    id: Uint8Array;
}
interface DriverBlobStream {
    length: Promise<number>;
    read(buffer: Buffer): Promise<number>;
    close(): Promise<unknown>;
}
interface DriverAttachment {
    openBlob(transaction: unknown, blob: DriverBlob): Promise<DriverBlobStream>;
}
interface FirebirdTransactionInternals {
    attachment: DriverAttachment;
    transaction: unknown;
}

const SAVE_TABLE = "dd_saves";
const GEN_CURRENT = 0;
const GEN_BACKUP = 1;

export interface FirebirdSaveStoreOptions {
    /** Path to the Firebird database file (created on first use). */
    dbPath: string;
    /** Current engine/game version string (e.g. "0.1.0") */
    engineVersion: string;
    /** Firebird connect options (username/password/charset). Defaults to SYSDBA/masterkey. */
    firebirdOptions?: FirebirdLiteOptions;
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
    /**
     * Directory used for Firebird's lock + tmp files when FIREBIRD_LOCK /
     * FIREBIRD_TMP are unset. Defaults to a per-user subdir of the OS tmpdir.
     * Set to false to disable the override (use system defaults).
     */
    firebirdTmpRoot?: string | false;
}

export class FirebirdSaveStore implements ISaveStore {
    private db: FirebirdLite;
    private engineVersionPacked: number;
    private migrations: IMigrationRegistry;
    private warningCallbacks: Array<(w: SaveWarning) => void> = [];
    private zstdReady: Promise<void> | null = null;
    private _compress: ((data: Uint8Array) => Uint8Array) | null = null;
    private _decompress: ((data: Uint8Array, originalSize: number) => Uint8Array) | null = null;
    private _hash128: ((data: Uint8Array) => Uint8Array) | null = null;
    private _skipMigrations: boolean = false;
    private schemaReady: Promise<void> | null = null;

    constructor(opts: FirebirdSaveStoreOptions) {
        this.configureFirebirdEnv(opts.firebirdTmpRoot);
        this.db = new FirebirdLite(opts.dbPath, opts.firebirdOptions ?? { username: "SYSDBA", password: "masterkey" });
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

    /**
     * Firebird embedded writes a lock file to /tmp/firebird by default, which
     * is root/firebird-owned on most distros. Point FIREBIRD_LOCK / FIREBIRD_TMP
     * at a per-user tmp dir when they are not already configured.
     */
    private configureFirebirdEnv(root: string | false | undefined): void {
        if (root === false) return;
        if (process.env.FIREBIRD_LOCK && process.env.FIREBIRD_TMP) return;
        const base = root ?? join(tmpdir(), `firebird-${process.getuid?.() ?? "user"}`);
        const lockDir = join(base, "lock");
        const tmpDir = join(base, "tmp");
        try {
            mkdirSync(lockDir, { recursive: true });
        } catch {
            // ignore — best effort
        }
        try {
            mkdirSync(tmpDir, { recursive: true });
        } catch {
            // ignore — best effort
        }
        if (!process.env.FIREBIRD_LOCK) process.env.FIREBIRD_LOCK = lockDir;
        if (!process.env.FIREBIRD_TMP) process.env.FIREBIRD_TMP = tmpDir;
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

    private async ensureSchema(): Promise<void> {
        if (this.schemaReady) return this.schemaReady;
        this.schemaReady = (async () => {
            // Firebird 5 has no CREATE TABLE IF NOT EXISTS; guard with RDB$RELATIONS.
            const check = await this.db.query(
                `SELECT 1 FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = ? FETCH FIRST 1 ROWS ONLY`,
                [SAVE_TABLE.toUpperCase()],
            );
            if (check.rows.length > 0) return;
            await this.db.exec(`
                CREATE TABLE ${SAVE_TABLE} (
                    slot VARCHAR(255) NOT NULL,
                    generation INTEGER NOT NULL,
                    engine_version_packed INTEGER NOT NULL,
                    save_timestamp BIGINT NOT NULL,
                    entity_count INTEGER NOT NULL,
                    player_count INTEGER NOT NULL,
                    body_hash BLOB SUB_TYPE 0 NOT NULL,
                    uncompressed_length INTEGER NOT NULL,
                    compressed_body BLOB SUB_TYPE 0 NOT NULL,
                    file_size BIGINT NOT NULL,
                    updated_at BIGINT NOT NULL,
                    PRIMARY KEY (slot, generation)
                )
            `);
        })();
        return this.schemaReady;
    }

    async save(slot: string, state: SaveState): Promise<SaveResult> {
        try {
            await this.ensureSchema();
            const bodyJson = JSON.stringify(state.components);
            const bodyBytes = new TextEncoder().encode(bodyJson);

            const hashBytes = this._hash128 ? this._hash128(bodyBytes) : await this.computeHash(bodyBytes);
            const compressed = this._compress ? this._compress(bodyBytes) : await this.compressBytes(bodyBytes);
            const fileSize = compressed.length + hashBytes.length;

            const safeSlot = this.sanitizeSlot(slot);
            const now = Date.now();

            // Rotate previous generation 0 → generation 1, then insert new gen 0.
            // Rotation is a plain UPDATE of the generation column — the BLOB
            // columns stay in place, so no BLOB read/copy is needed on the save
            // path (reading BLOBs back through firebird-wasm's lazy references
            // is fragile under Bun's native-addon GC).
            await this.db.transaction(async (tx) => {
                // Drop the old backup.
                await tx.exec(`DELETE FROM ${SAVE_TABLE} WHERE slot = ? AND generation = ?`, [safeSlot, GEN_BACKUP]);
                // Promote the current row to backup by flipping its generation.
                await tx.exec(
                    `UPDATE ${SAVE_TABLE} SET generation = ? WHERE slot = ? AND generation = ?`,
                    [GEN_BACKUP, safeSlot, GEN_CURRENT],
                );
                // Insert the new current row.
                await tx.exec(
                    `INSERT INTO ${SAVE_TABLE}
                        (slot, generation, engine_version_packed, save_timestamp, entity_count, player_count,
                         body_hash, uncompressed_length, compressed_body, file_size, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        safeSlot,
                        GEN_CURRENT,
                        this.engineVersionPacked,
                        state.meta.timestamp,
                        state.meta.entityCount,
                        state.meta.playerCount,
                        Buffer.from(hashBytes),
                        bodyBytes.length,
                        Buffer.from(compressed),
                        fileSize,
                        now,
                    ],
                );
            });

            log.info("FirebirdSaveStore", `Saved slot '${slot}' (${fileSize} bytes)`);
            return { success: true, bytes: fileSize };
        } catch (err) {
            log.error("FirebirdSaveStore", `Save failed for slot '${slot}': ${err}`);
            return { success: false, bytes: 0 };
        }
    }

    async load(slot: string): Promise<LoadResult> {
        try {
            await this.ensureSchema();
            const safeSlot = this.sanitizeSlot(slot);

            const result = await this.loadGeneration(safeSlot, slot, GEN_CURRENT);
            if (result.state) return result;

            const bakResult = await this.loadGeneration(safeSlot, slot, GEN_BACKUP);
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
        } catch (err) {
            log.error("FirebirdSaveStore", `Load failed for slot '${slot}': ${err}`);
            return { state: null };
        }
    }

    private async loadGeneration(safeSlot: string, slot: string, generation: number): Promise<LoadResult> {
        try {
            // Read the row + its BLOBs inside a single transaction: firebird-wasm
            // returns BLOB columns as lazy references bound to the fetching
            // transaction, so they must be materialized before commit.
            return await this.db.transaction(async (tx) => {
                const res = await tx.query(
                    `SELECT engine_version_packed, save_timestamp, entity_count, player_count,
                            body_hash, uncompressed_length, compressed_body
                     FROM ${SAVE_TABLE} WHERE slot = ? AND generation = ?`,
                    [safeSlot, generation],
                );
                if (res.rows.length === 0) return { state: null };
                const row = res.rows[0] as Record<string, unknown>;

                const header: SaveHeader = {
                    magic: 0, // not stored in DB; irrelevant for load path
                    formatVersion: 0,
                    engineVersionPacked: row.ENGINE_VERSION_PACKED as number,
                    timestamp: Number(row.SAVE_TIMESTAMP),
                    entityCount: row.ENTITY_COUNT as number,
                    playerCount: row.PLAYER_COUNT as number,
                    bodyHash: await this.readBlobFully(tx, row.BODY_HASH as DriverBlob),
                    uncompressedBodyLength: row.UNCOMPRESSED_LENGTH as number,
                };

                if (header.engineVersionPacked > this.engineVersionPacked) {
                    const saveVer = engineVersionString(header.engineVersionPacked);
                    this.warn({
                        kind: "forward_incompatible",
                        slot,
                        message: `Save version ${saveVer} > engine version — refusing to load`,
                    });
                    return { state: null };
                }

                const compressedBody = await this.readBlobFully(tx, row.COMPRESSED_BODY as DriverBlob);
                const decompressed = this._decompress
                    ? this._decompress(compressedBody, header.uncompressedBodyLength)
                    : await this.decompressBytes(compressedBody, header.uncompressedBodyLength);

                const computedHash = this._hash128 ? this._hash128(decompressed) : await this.computeHash(decompressed);
                if (!this.hashEqual(computedHash, header.bodyHash)) {
                    this.warn({ kind: "corruption", slot, message: `Hash mismatch for slot '${slot}' (gen ${generation})` });
                    return { state: null };
                }

                const bodyJson = new TextDecoder().decode(decompressed);
                const components = safeJsonParse<Record<string, { v: number; data: unknown }>>(bodyJson);

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

                log.info("FirebirdSaveStore", `Loaded slot '${slot}' (gen ${generation})`);
                return { state };
            });
        } catch (err) {
            // Treat any error as "no valid save" so the backup path can be tried.
            log.warn("FirebirdSaveStore", `loadGeneration ${slot} gen ${generation} failed: ${err}`);
            return { state: null };
        }
    }

    async listSaves(): Promise<SaveSlotInfo[]> {
        try {
            await this.ensureSchema();
            const res = await this.db.query(
                `SELECT slot, save_timestamp, entity_count, player_count, engine_version_packed, file_size
                 FROM ${SAVE_TABLE} WHERE generation = ?
                 ORDER BY save_timestamp DESC`,
                [GEN_CURRENT],
            );
            return res.rows.map((row) => {
                const r = row as Record<string, unknown>;
                return {
                    slot: r.SLOT as string,
                    timestamp: Number(r.SAVE_TIMESTAMP),
                    entityCount: r.ENTITY_COUNT as number,
                    playerCount: r.PLAYER_COUNT as number,
                    engineVersion: engineVersionString(r.ENGINE_VERSION_PACKED as number),
                    fileSize: Number(r.FILE_SIZE),
                };
            });
        } catch {
            return [];
        }
    }

    async deleteSave(slot: string): Promise<boolean> {
        try {
            await this.ensureSchema();
            const safeSlot = this.sanitizeSlot(slot);
            // No row-count returned by exec; query first to determine existence.
            const before = await this.db.query(
                `SELECT 1 FROM ${SAVE_TABLE} WHERE slot = ? FETCH FIRST 1 ROWS ONLY`,
                [safeSlot],
            );
            if (before.rows.length === 0) return false;
            await this.db.exec(`DELETE FROM ${SAVE_TABLE} WHERE slot = ?`, [safeSlot]);
            return true;
        } catch (err) {
            log.error("FirebirdSaveStore", `deleteSave failed for slot '${slot}': ${err}`);
            return false;
        }
    }

    /** Close the underlying database connection. */
    async close(): Promise<void> {
        try {
            await this.db.close();
        } catch {
            // ignore
        }
    }

    private sanitizeSlot(slot: string): string {
        return slot.replace(/[^a-zA-Z0-9_\-]/g, "_");
    }

    private hashEqual(a: Uint8Array, b: Uint8Array): boolean {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    /**
     * Read a BLOB column value fully into a Uint8Array.
     *
     * firebird-wasm returns BLOB columns as lazy `Blob` references (`{ id,
     * attachment }`) bound to the transaction that fetched them. The
     * `FirebirdTransaction` class holds the driver `attachment` and
     * `transaction` as private fields and does not expose a blob-reading
     * helper, so we reach them through a cast and use the driver's
     * `Attachment.openBlob` → `BlobStream.read` API directly.
     */
    private async readBlobFully(tx: FirebirdTransaction, blobRef: DriverBlob): Promise<Uint8Array> {
        const internals = tx as unknown as FirebirdTransactionInternals;
        const stream = await internals.attachment.openBlob(internals.transaction, blobRef);
        try {
            const total = await stream.length;
            const chunks: Buffer[] = [];
            let remaining = total;
            const segSize = 65536;
            while (remaining > 0) {
                const buf = Buffer.alloc(Math.min(segSize, remaining));
                const n = await stream.read(buf);
                if (n <= 0) break;
                chunks.push(n === buf.length ? buf : buf.subarray(0, n));
                remaining -= n;
            }
            const out = Buffer.concat(chunks);
            return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
        } finally {
            await stream.close().catch(() => undefined);
        }
    }
}
