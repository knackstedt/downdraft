// ============================================================================
// FirebirdBrowserSaveStore — Firebird WASM-backed ISaveStore (renderer-side)
// ============================================================================
//
// Stores save slots as rows in a Firebird database running in WebAssembly via
// firebird-wasm's FirebirdBrowser. Unlike FirebirdSaveStore (Node native,
// libfbclient), this backend:
//
//   - Runs entirely in the renderer (no main-process IPC, no native addon).
//   - Uses the WASM-compiled Firebird engine + IndexedDB for persistence.
//   - Requires a Worker (the engine uses pthreads and blocks; a browser main
//     thread cannot block). The caller provides the Worker, built from
//     `firebird-wasm/browser/worker-entry`. For Node/test harnesses, the
//     Worker can be omitted (DirectTransport loads the WASM inline).
//   - Requires cross-origin isolation (COOP/COEP) for SharedArrayBuffer.
//     The engine's Electron window already sets these headers (window.ts).
//
// Storage strategy: The WASM backend cannot bind binary params (Uint8Array
// throws) and cannot bind string params to BLOB columns ("BLOB not supported
// for move operation"). SQL string literals for BLOBs work but exceed
// Firebird's statement length limit for large bodies. We therefore use a
// chunk table: the compressed body is base64-encoded, split into VARCHAR
// chunks (parameterized inserts, which DO work), and stored in a child table.
// The 16-byte hash is small enough (~24 base64 chars) to store as a BLOB via
// a SQL string literal. On read, chunks are concatenated in order and
// base64-decoded.
//
// No lazy blob references: the browser backend materializes everything across
// the Worker boundary, so loads are straightforward — no transaction-bound
// blob reading is needed (unlike the Node native backend).

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
import { FirebirdBrowser, type FirebirdBrowserOptions } from "firebird-wasm/browser";

const log = createLogger("info");

const SAVE_TABLE = "dd_saves";
const CHUNK_TABLE = "dd_save_chunks";
const GEN_CURRENT = 0;
const GEN_BACKUP = 1;
const CHUNK_SIZE = 7000; // VARCHAR(8000) with headroom for base64

export interface FirebirdBrowserSaveStoreOptions {
    /**
     * Logical database name. Used as the IndexedDB store name and the filename
     * inside the WASM engine's virtual filesystem.
     *
     * - A plain name (e.g. "saves") persists to IndexedDB automatically.
     * - `memory://name` creates an ephemeral database that leaves nothing
     *   behind (useful for tests).
     * - `opfs://name` writes pages straight to an OPFS file (no persist step).
     */
    dbName: string;
    /** Current engine/game version string (e.g. "0.1.0") */
    engineVersion: string;
    /** Options forwarded to FirebirdBrowser (worker, types, autoPersist, etc.) */
    firebirdOptions?: FirebirdBrowserOptions;
    /** Migration registry (optional — a new one is created if not provided) */
    migrationRegistry?: IMigrationRegistry;
    /** Optional compression provider (for testing or custom compression) */
    compress?: (data: Uint8Array) => Uint8Array;
    /** Optional decompression provider (for testing or custom compression) */
    decompress?: (data: Uint8Array, originalSize: number) => Uint8Array;
    /** Optional hash provider (for testing or custom hashing) */
    hash128?: (data: Uint8Array) => Uint8Array;
    /** Skip migration step on load — pass through components unchanged */
    skipMigrations?: boolean;
}

export class FirebirdBrowserSaveStore implements ISaveStore {
    private db: FirebirdBrowser;
    private engineVersionPacked: number;
    private migrations: IMigrationRegistry;
    private warningCallbacks: Array<(w: SaveWarning) => void> = [];
    private zstdReady: Promise<void> | null = null;
    private _compress: ((data: Uint8Array) => Uint8Array) | null = null;
    private _decompress: ((data: Uint8Array, originalSize: number) => Uint8Array) | null = null;
    private _hash128: ((data: Uint8Array) => Uint8Array) | null = null;
    private _skipMigrations: boolean = false;
    private schemaReady: Promise<void> | null = null;
    private dbName: string;
    private firebirdOptions: FirebirdBrowserOptions;

    constructor(opts: FirebirdBrowserSaveStoreOptions) {
        this.dbName = opts.dbName;
        this.firebirdOptions = opts.firebirdOptions ?? {};
        this.db = new FirebirdBrowser(opts.dbName, {
            autoPersist: true,
            ...opts.firebirdOptions,
        });
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
            const checkSaves = await this.db.query(
                `SELECT 1 FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = ? FETCH FIRST 1 ROWS ONLY`,
                [SAVE_TABLE.toUpperCase()],
            );
            if (checkSaves.rows.length === 0) {
                await this.db.exec(`
                    CREATE TABLE ${SAVE_TABLE} (
                        slot VARCHAR(255) NOT NULL,
                        generation INTEGER NOT NULL,
                        engine_version_packed INTEGER NOT NULL,
                        save_timestamp BIGINT NOT NULL,
                        entity_count INTEGER NOT NULL,
                        player_count INTEGER NOT NULL,
                        body_hash BLOB SUB_TYPE TEXT NOT NULL,
                        uncompressed_length INTEGER NOT NULL,
                        file_size BIGINT NOT NULL,
                        updated_at BIGINT NOT NULL,
                        PRIMARY KEY (slot, generation)
                    )
                `);
            }
            const checkChunks = await this.db.query(
                `SELECT 1 FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = ? FETCH FIRST 1 ROWS ONLY`,
                [CHUNK_TABLE.toUpperCase()],
            );
            if (checkChunks.rows.length === 0) {
                await this.db.exec(`
                    CREATE TABLE ${CHUNK_TABLE} (
                        slot VARCHAR(255) NOT NULL,
                        generation INTEGER NOT NULL,
                        chunk_idx INTEGER NOT NULL,
                        chunk_data VARCHAR(8000) NOT NULL,
                        PRIMARY KEY (slot, generation, chunk_idx)
                    )
                `);
            }
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

            // Hash is small (16 bytes → ~24 base64 chars); safe as a BLOB literal.
            const hashB64 = this.toBase64(hashBytes);
            // Body is base64-encoded and split into VARCHAR chunks for
            // parameterized inserts (the WASM backend can't bind to BLOBs,
            // and large literals exceed Firebird's statement length limit).
            const bodyB64 = this.toBase64(compressed);
            const chunks: string[] = [];
            for (let i = 0; i < bodyB64.length; i += CHUNK_SIZE) {
                chunks.push(bodyB64.slice(i, i + CHUNK_SIZE));
            }

            await this.db.transaction(async (tx) => {
                // Drop old backup (both metadata and chunks).
                await tx.exec(`DELETE FROM ${CHUNK_TABLE} WHERE slot = ? AND generation = ?`, [safeSlot, GEN_BACKUP]);
                await tx.exec(`DELETE FROM ${SAVE_TABLE} WHERE slot = ? AND generation = ?`, [safeSlot, GEN_BACKUP]);

                // Promote current row + chunks to backup by flipping generation.
                await tx.exec(
                    `UPDATE ${CHUNK_TABLE} SET generation = ? WHERE slot = ? AND generation = ?`,
                    [GEN_BACKUP, safeSlot, GEN_CURRENT],
                );
                await tx.exec(
                    `UPDATE ${SAVE_TABLE} SET generation = ? WHERE slot = ? AND generation = ?`,
                    [GEN_BACKUP, safeSlot, GEN_CURRENT],
                );

                // Insert new current metadata row (hash via literal — it's tiny).
                await tx.exec(
                    `INSERT INTO ${SAVE_TABLE}
                        (slot, generation, engine_version_packed, save_timestamp, entity_count, player_count,
                         body_hash, uncompressed_length, file_size, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, '${hashB64}', ?, ?, ?)`,
                    [
                        safeSlot,
                        GEN_CURRENT,
                        this.engineVersionPacked,
                        state.meta.timestamp,
                        state.meta.entityCount,
                        state.meta.playerCount,
                        bodyBytes.length,
                        fileSize,
                        now,
                    ],
                );

                // Insert body chunks (parameterized — VARCHAR params work).
                for (let i = 0; i < chunks.length; i++) {
                    await tx.exec(
                        `INSERT INTO ${CHUNK_TABLE} (slot, generation, chunk_idx, chunk_data) VALUES (?, ?, ?, ?)`,
                        [safeSlot, GEN_CURRENT, i, chunks[i]],
                    );
                }
            });

            log.info("FirebirdBrowserSaveStore", `Saved slot '${slot}' (${fileSize} bytes, ${chunks.length} chunks)`);
            return { success: true, bytes: fileSize };
        } catch (err) {
            log.error("FirebirdBrowserSaveStore", `Save failed for slot '${slot}': ${err}`);
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
            log.error("FirebirdBrowserSaveStore", `Load failed for slot '${slot}': ${err}`);
            return { state: null };
        }
    }

    private async loadGeneration(safeSlot: string, slot: string, generation: number): Promise<LoadResult> {
        try {
            const res = await this.db.query(
                `SELECT engine_version_packed, save_timestamp, entity_count, player_count,
                        body_hash, uncompressed_length
                 FROM ${SAVE_TABLE} WHERE slot = ? AND generation = ?`,
                [safeSlot, generation],
            );
            if (res.rows.length === 0) return { state: null };
            const row = res.rows[0] as Record<string, unknown>;

            const hashBytes = this.fromBase64(row.BODY_HASH as string);

            const header: SaveHeader = {
                magic: 0,
                formatVersion: 0,
                engineVersionPacked: row.ENGINE_VERSION_PACKED as number,
                timestamp: Number(row.SAVE_TIMESTAMP),
                entityCount: row.ENTITY_COUNT as number,
                playerCount: row.PLAYER_COUNT as number,
                bodyHash: hashBytes,
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

            // Read and reassemble body chunks.
            const chunkRes = await this.db.query(
                `SELECT chunk_data FROM ${CHUNK_TABLE} WHERE slot = ? AND generation = ? ORDER BY chunk_idx`,
                [safeSlot, generation],
            );
            if (chunkRes.rows.length === 0) {
                this.warn({ kind: "corruption", slot, message: `No body chunks for slot '${slot}' (gen ${generation})` });
                return { state: null };
            }
            const bodyB64 = chunkRes.rows.map((r) => (r as { CHUNK_DATA: string }).CHUNK_DATA).join("");
            const compressedBody = this.fromBase64(bodyB64);

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

            const state: SaveState = {
                components: migrated,
                meta: {
                    engineVersion: engineVersionString(header.engineVersionPacked),
                    timestamp: header.timestamp,
                    entityCount: header.entityCount,
                    playerCount: header.playerCount,
                },
            };

            log.info("FirebirdBrowserSaveStore", `Loaded slot '${slot}' (gen ${generation})`);
            return { state };
        } catch (err) {
            log.warn("FirebirdBrowserSaveStore", `loadGeneration ${slot} gen ${generation} failed: ${err}`);
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
            const before = await this.db.query(
                `SELECT 1 FROM ${SAVE_TABLE} WHERE slot = ? FETCH FIRST 1 ROWS ONLY`,
                [safeSlot],
            );
            if (before.rows.length === 0) return false;
            await this.db.exec(`DELETE FROM ${CHUNK_TABLE} WHERE slot = ?`, [safeSlot]);
            await this.db.exec(`DELETE FROM ${SAVE_TABLE} WHERE slot = ?`, [safeSlot]);
            return true;
        } catch (err) {
            log.error("FirebirdBrowserSaveStore", `deleteSave failed for slot '${slot}': ${err}`);
            return false;
        }
    }

    /** Force an IndexedDB persist (otherwise debounced after writes). */
    async persist(): Promise<void> {
        await this.db.persist();
    }

    // ── Cloud save support ──────────────────────────────────────────────
    //
    // The Firebird WASM engine stores its database in a virtual filesystem
    // backed by IndexedDB (or OPFS). For cloud saves, the entire database
    // image can be exported to a Uint8Array and written to disk via Electron
    // IPC (main process fs.writeFile). On restore, the bytes are passed to
    // loadDataDir to seed a new database.
    //
    // Flow:
    //   export → IPC → fs.writeFile(cloudPath) → cloud sync picks up file
    //   cloud sync restores file → IPC → fs.readFile → importFromBytes
    //
    // The export reads the **live** database (not the IndexedDB copy), so
    // unsaved writes are included. Call persist() first if you want the
    // IndexedDB copy to match.

    /**
     * Export the entire Firebird database as bytes, for cloud saves or
     * backup. Reads the live database image from the engine's virtual
     * filesystem — includes writes that haven't been persisted to IndexedDB
     * yet.
     *
     * @returns Full database image as a Uint8Array.
     */
    async exportDatabase(): Promise<Uint8Array> {
        return this.db.dumpDataDir();
    }

    /**
     * Replace the current database with the given bytes (from
     * {@link exportDatabase} or a cloud restore). Closes the current
     * connection, destroys the IndexedDB store, and reopens with the
     * provided image as the seed.
     *
     * The bytes must be a valid Firebird database image (page-aligned,
     * matching the engine's page size — 8192 by default).
     */
    async importDatabase(bytes: Uint8Array): Promise<void> {
        // Close the current connection and destroy the IndexedDB store so
        // the seed is not ignored (loadDataDir only seeds when no stored DB
        // exists).
        await this.db.close();
        // Reconstruct with the imported bytes as the seed. We use a new
        // FirebirdBrowser instance with loadDataDir.
        this.db = new FirebirdBrowser(this.dbName, {
            autoPersist: true,
            loadDataDir: bytes,
            ...this.firebirdOptions,
        });
        // Reset schema cache — the new DB may or may not have the schema.
        this.schemaReady = null;
        // Touch the DB to trigger lazy init + seed.
        await this.ensureSchema();
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

    private toBase64(bytes: Uint8Array): string {
        if (typeof Buffer !== "undefined") {
            return Buffer.from(bytes).toString("base64");
        }
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
    }

    private fromBase64(b64: string): Uint8Array {
        if (typeof Buffer !== "undefined") {
            const buf = Buffer.from(b64, "base64");
            return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        }
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }
}
