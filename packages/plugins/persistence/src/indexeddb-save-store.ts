// ============================================================================
// IndexedDBSaveStore — IndexedDB-backed ISaveStore with generation history,
// blobs, thumbnails, and properties. Runs in browser/renderer code.
// ============================================================================
//
// Object stores:
//   slots        (keyPath: "slot")        — SlotMeta per slot
//   generations  (keyPath: ["slot","gen"]) — compressed body + hash per gen
//   blobs        (keyPath: ["slot","gen","key"]) — raw binary blobs per gen
//   thumbnails   (keyPath: "slot")        — thumbnail image bytes per slot
//
// On save: write body + blobs + thumbnail first, then update slot meta
// (commit point). On load: read meta, load current gen (or specified), fall
// back to previous gens on hash mismatch / corruption.
//
// Forward incompatibility: saves from a newer engine version are refused.
// Mirrors OpfsSaveStore's semantics — see that file for design rationale.

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
const DEFAULT_DB_NAME = "downdraft-saves";
const DB_VERSION = 1;
const SLOTS_STORE = "slots";
const GENS_STORE = "generations";
const BLOBS_STORE = "blobs";
const THUMBS_STORE = "thumbnails";
const META_FORMAT_VERSION = 1;

// ── Meta types (same shape as OpfsSaveStore) ──────────────────────────────

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
    slot: string;
    currentGen: number;
    maxGenerations: number;
    generations: GenerationMeta[];
    properties: Record<string, unknown>;
    hasThumbnail: boolean;
}

interface GenRecord {
    slot: string;
    gen: number;
    body: Uint8Array; // compressed
    hash: Uint8Array; // 16-byte XXH128
    timestamp: number;
    engineVersion: string;
    entityCount: number;
    playerCount: number;
    bodySize: number;
    blobCount: number;
}

interface BlobRecord {
    slot: string;
    gen: number;
    key: string;
    data: ArrayBuffer;
}

interface ThumbRecord {
    slot: string;
    data: ArrayBuffer;
}

// ── Minimal IDB type helpers (avoid lib.dom.d.ts worker-augmented defs) ────

interface IdbRequest<T = unknown> {
    result: T;
    error: unknown;
    onsuccess: ((ev: unknown) => void) | null;
    onerror: ((ev: unknown) => void) | null;
}

interface IdbObjectStore {
    put(value: unknown, key?: unknown): IdbRequest;
    get(key: unknown): IdbRequest;
    getAll(): IdbRequest<unknown[]>;
    delete(key: unknown): IdbRequest;
    clear(): IdbRequest;
}

interface IdbTransaction {
    objectStore(name: string): IdbObjectStore;
    oncomplete: (() => void) | null;
    onerror: (() => void) | null;
    onabort: (() => void) | null;
}

interface IdbDatabase {
    objectStoreNames: { contains(name: string): boolean };
    createObjectStore(name: string, opts?: { keyPath?: string | string[] }): IdbObjectStore;
    transaction(stores: string | string[], mode: "readonly" | "readwrite"): IdbTransaction;
    close(): void;
}

interface IdbFactory {
    open(name: string, version?: number): {
        result: IdbDatabase;
        error: unknown;
        onupgradeneeded: ((ev: unknown) => void) | null;
        onsuccess: ((ev: unknown) => void) | null;
        onerror: ((ev: unknown) => void) | null;
    };
}

// ── Options ────────────────────────────────────────────────────────────────

export interface IndexedDBSaveStoreOptions {
    /** IndexedDB factory (defaults to globalThis.indexedDB). Useful for testing. */
    factory?: IdbFactory;
    /** Database name. Default: "downdraft-saves". */
    dbName?: string;
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

// ── IndexedDBSaveStore ─────────────────────────────────────────────────────

export class IndexedDBSaveStore implements ISaveStore {
    private db: IdbDatabase | null = null;
    private engineVersionPacked: number;
    private defaultMaxGenerations: number;
    private migrations: IMigrationRegistry;
    private warningCallbacks: Array<(w: SaveWarning) => void> = [];
    private zstdReady: Promise<void> | null = null;
    private _compress: ((data: Uint8Array) => Uint8Array) | null = null;
    private _decompress: ((data: Uint8Array, originalSize: number) => Uint8Array) | null = null;
    private _hash128: ((data: Uint8Array) => Uint8Array) | null = null;
    private _skipMigrations: boolean = false;
    private _factory: IdbFactory | null;
    private _dbName: string;

    constructor(opts: IndexedDBSaveStoreOptions) {
        this._factory = opts.factory ?? null;
        this._dbName = opts.dbName ?? DEFAULT_DB_NAME;
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
     * Open (and upgrade if needed) the IndexedDB database. Must be called
     * before any save/load. Uses globalThis.indexedDB unless a factory was
     * provided in options.
     */
    async init(): Promise<void> {
        if (this.db) return;
        const factory = this._factory ?? (globalThis as unknown as { indexedDB?: IdbFactory }).indexedDB;
        if (!factory) {
            throw new Error("IndexedDB is not available in this environment");
        }
        this.db = await new Promise<IdbDatabase>((resolve, reject) => {
            const req = factory.open(this._dbName, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(SLOTS_STORE)) {
                    db.createObjectStore(SLOTS_STORE, { keyPath: "slot" });
                }
                if (!db.objectStoreNames.contains(GENS_STORE)) {
                    db.createObjectStore(GENS_STORE, { keyPath: ["slot", "gen"] });
                }
                if (!db.objectStoreNames.contains(BLOBS_STORE)) {
                    db.createObjectStore(BLOBS_STORE, { keyPath: ["slot", "gen", "key"] });
                }
                if (!db.objectStoreNames.contains(THUMBS_STORE)) {
                    db.createObjectStore(THUMBS_STORE, { keyPath: "slot" });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    /** Initialize from a pre-opened database (e.g. for testing). */
    initWithDb(db: IdbDatabase): void {
        this.db = db;
    }

    private ensureDb(): IdbDatabase {
        if (!this.db) {
            throw new Error("IndexedDBSaveStore not initialized — call init() first");
        }
        return this.db;
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

    // ── Compression / hashing (lazy init, same as OpfsSaveStore) ────────────

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

    // ── IDB helpers ──────────────────────────────────────────────────────────

    private sanitizeSlot(slot: string): string {
        return slot.replace(/[^a-zA-Z0-9_-]/g, "_");
    }

    private reqToPromise<T>(req: IdbRequest<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    private txDone(tx: IdbTransaction): Promise<void> {
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(new Error("idb transaction error"));
            tx.onabort = () => reject(new Error("idb transaction aborted"));
        });
    }

    private async readSlotMeta(slot: string): Promise<SlotMeta | null> {
        const db = this.ensureDb();
        const tx = db.transaction(SLOTS_STORE, "readonly");
        const result = (await this.reqToPromise(tx.objectStore(SLOTS_STORE).get(slot))) as SlotMeta | undefined;
        return result ?? null;
    }

    private async writeSlotMeta(meta: SlotMeta): Promise<void> {
        const db = this.ensureDb();
        const tx = db.transaction(SLOTS_STORE, "readwrite");
        tx.objectStore(SLOTS_STORE).put(meta);
        await this.txDone(tx);
    }

    // ── ISaveStore: save ────────────────────────────────────────────────────

    async save(slot: string, state: SaveState, opts?: SaveOptions): Promise<SaveResult> {
        try {
            this.ensureDb();
            const safeSlot = this.sanitizeSlot(slot);

            const existingMeta = await this.readSlotMeta(safeSlot);
            const maxGens = opts?.maxGenerations ?? existingMeta?.maxGenerations ?? this.defaultMaxGenerations;
            const currentGen = (existingMeta?.currentGen ?? 0) + 1;

            // 1. Write body (compressed component JSON)
            const bodyJson = JSON.stringify(state.components);
            const bodyBytes = new TextEncoder().encode(bodyJson);

            const hashBytes = this._hash128 ? this._hash128(bodyBytes) : await this.computeHash(bodyBytes);
            const compressed = this._compress ? this._compress(bodyBytes) : await this.compressBytes(bodyBytes);

            // 2. Write blobs
            const blobEntries: BlobRecord[] = [];
            if (opts?.blobs) {
                for (const [key, buf] of Object.entries(opts.blobs)) {
                    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "_");
                    blobEntries.push({ slot: safeSlot, gen: currentGen, key: safeKey, data: buf });
                }
            }

            // 3. Write thumbnail if provided
            let hasThumbnail = existingMeta?.hasThumbnail ?? false;
            const thumbRecord: ThumbRecord | null = opts?.thumbnail
                ? { slot: safeSlot, data: (opts.thumbnail instanceof Uint8Array ? opts.thumbnail.buffer.slice(opts.thumbnail.byteOffset, opts.thumbnail.byteOffset + opts.thumbnail.byteLength) : opts.thumbnail) as ArrayBuffer }
                : null;
            if (thumbRecord) hasThumbnail = true;

            // Commit body + blobs + thumbnail in one transaction (before meta).
            const db = this.ensureDb();
            const stores = [GENS_STORE, BLOBS_STORE, THUMBS_STORE];
            const writeTx = db.transaction(stores, "readwrite");
            const genRecord: GenRecord = {
                slot: safeSlot,
                gen: currentGen,
                body: compressed,
                hash: hashBytes,
                timestamp: state.meta.timestamp,
                engineVersion: state.meta.engineVersion,
                entityCount: state.meta.entityCount,
                playerCount: state.meta.playerCount,
                bodySize: compressed.length,
                blobCount: blobEntries.length,
            };
            writeTx.objectStore(GENS_STORE).put(genRecord);
            for (const b of blobEntries) {
                writeTx.objectStore(BLOBS_STORE).put(b);
            }
            if (thumbRecord) {
                writeTx.objectStore(THUMBS_STORE).put(thumbRecord);
            }
            await this.txDone(writeTx);

            // 4. Build + write slot meta (commit point — written last)
            const genMeta: GenerationMeta = {
                gen: currentGen,
                timestamp: state.meta.timestamp,
                engineVersion: state.meta.engineVersion,
                entityCount: state.meta.entityCount,
                playerCount: state.meta.playerCount,
                bodySize: compressed.length,
                blobCount: blobEntries.length,
            };

            const generations = [...(existingMeta?.generations ?? []), genMeta];
            // Prune old generations
            while (generations.length > maxGens) {
                const oldest = generations.shift()!;
                await this.removeGenRecords(safeSlot, oldest.gen);
            }

            const properties = opts?.properties ?? existingMeta?.properties ?? {};

            const newMeta: SlotMeta = {
                formatVersion: META_FORMAT_VERSION,
                slot: safeSlot,
                currentGen,
                maxGenerations: maxGens,
                generations,
                properties,
                hasThumbnail,
            };
            await this.writeSlotMeta(newMeta);

            const totalBytes = compressed.length + hashBytes.length + (opts?.blobs ? Object.values(opts.blobs).reduce((s, b) => s + b.byteLength, 0) : 0);
            log.info("IndexedDBSaveStore", `Saved slot '${slot}' gen ${currentGen} (${totalBytes} bytes)`);
            return { success: true, bytes: totalBytes, gen: currentGen };
        } catch (err) {
            log.error("IndexedDBSaveStore", `Save failed for slot '${slot}': ${err}`);
            return { success: false, bytes: 0 };
        }
    }

    private async removeGenRecords(slot: string, gen: number): Promise<void> {
        try {
            const db = this.ensureDb();
            const tx = db.transaction([GENS_STORE, BLOBS_STORE], "readwrite");
            tx.objectStore(GENS_STORE).delete([slot, gen]);
            // Delete all blobs for this gen — getAll then delete each (no index).
            const blobs = (await this.reqToPromise(tx.objectStore(BLOBS_STORE).getAll())) as BlobRecord[];
            for (const b of blobs) {
                if (b.slot === slot && b.gen === gen) {
                    tx.objectStore(BLOBS_STORE).delete([slot, gen, b.key]);
                }
            }
            await this.txDone(tx);
        } catch {
            // Already gone — fine
        }
    }

    // ── ISaveStore: load ────────────────────────────────────────────────────

    async load(slot: string, opts?: LoadOptions): Promise<LoadResult> {
        try {
            const safeSlot = this.sanitizeSlot(slot);
            const meta = await this.readSlotMeta(safeSlot);
            if (!meta) {
                this.warn({ kind: "no_saves_found", slot, message: `No save meta found for slot '${slot}'` });
                return { state: null };
            }

            const targetGen = opts?.gen ?? meta.currentGen;
            const includeBlobs = opts?.includeBlobs ?? true;

            // Try target gen, then fall back to previous generations
            const gensToTry = meta.generations
                .filter((g) => g.gen <= targetGen)
                .sort((a, b) => b.gen - a.gen);

            for (const genMeta of gensToTry) {
                const result = await this.loadFromGen(safeSlot, slot, genMeta, includeBlobs);
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
            log.error("IndexedDBSaveStore", `Load failed for slot '${slot}': ${err}`);
            return { state: null };
        }
    }

    private async loadFromGen(
        safeSlot: string,
        slot: string,
        genMeta: GenerationMeta,
        includeBlobs: boolean,
    ): Promise<LoadResult> {
        try {
            const db = this.ensureDb();

            // Read + decompress body
            const genRecord = (await this.reqToPromise(
                db.transaction(GENS_STORE, "readonly").objectStore(GENS_STORE).get([safeSlot, genMeta.gen]),
            )) as GenRecord | undefined;
            if (!genRecord) return { state: null };

            const decompressed = this._decompress
                ? this._decompress(genRecord.body, 0)
                : await this.decompressBytes(genRecord.body, 0);

            // Verify hash
            if (genRecord.hash) {
                const computedHash = this._hash128 ? this._hash128(decompressed) : await this.computeHash(decompressed);
                if (!this.hashEqual(computedHash, genRecord.hash)) {
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
                const allBlobs = (await this.reqToPromise(
                    db.transaction(BLOBS_STORE, "readonly").objectStore(BLOBS_STORE).getAll(),
                )) as BlobRecord[];
                const slotBlobs = allBlobs.filter((b) => b.slot === safeSlot && b.gen === genMeta.gen);
                if (slotBlobs.length > 0) {
                    blobs = Object.fromEntries(slotBlobs.map((b) => [b.key, b.data]));
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
            log.warn("IndexedDBSaveStore", `loadFromGen ${genMeta.gen} failed: ${err}`);
            return { state: null };
        }
    }

    // ── ISaveStore: listSaves ───────────────────────────────────────────────

    async listSaves(): Promise<SaveSlotInfo[]> {
        try {
            const db = this.ensureDb();
            const metas = (await this.reqToPromise(
                db.transaction(SLOTS_STORE, "readonly").objectStore(SLOTS_STORE).getAll(),
            )) as SlotMeta[];

            const slots: SaveSlotInfo[] = [];
            for (const meta of metas) {
                const latest = meta.generations[meta.generations.length - 1] ?? meta.generations[0];
                if (!latest) continue;
                let totalSize = 0;
                for (const g of meta.generations) totalSize += g.bodySize;
                slots.push({
                    slot: meta.slot,
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
            const safeSlot = this.sanitizeSlot(slot);
            const meta = await this.readSlotMeta(safeSlot);
            if (!meta) return [];
            return [...meta.generations].sort((a, b) => b.gen - a.gen);
        } catch {
            return [];
        }
    }

    // ── ISaveStore: deleteSave ──────────────────────────────────────────────

    async deleteSave(slot: string): Promise<boolean> {
        try {
            const safeSlot = this.sanitizeSlot(slot);
            const meta = await this.readSlotMeta(safeSlot);
            const gens = meta?.generations ?? [];

            const db = this.ensureDb();
            const tx = db.transaction([SLOTS_STORE, GENS_STORE, BLOBS_STORE, THUMBS_STORE], "readwrite");
            tx.objectStore(SLOTS_STORE).delete(safeSlot);
            for (const g of gens) {
                tx.objectStore(GENS_STORE).delete([safeSlot, g.gen]);
            }
            // Delete blobs + thumbnail (getAll then filter, no index).
            const allBlobs = (await this.reqToPromise(tx.objectStore(BLOBS_STORE).getAll())) as BlobRecord[];
            for (const b of allBlobs) {
                if (b.slot === safeSlot) tx.objectStore(BLOBS_STORE).delete([safeSlot, b.gen, b.key]);
            }
            tx.objectStore(THUMBS_STORE).delete(safeSlot);
            await this.txDone(tx);

            log.info("IndexedDBSaveStore", `Deleted slot '${slot}'`);
            return true;
        } catch {
            return false;
        }
    }

    // ── ISaveStore: deleteGeneration ────────────────────────────────────────

    async deleteGeneration(slot: string, gen: number): Promise<boolean> {
        try {
            const safeSlot = this.sanitizeSlot(slot);
            const meta = await this.readSlotMeta(safeSlot);
            if (!meta) return false;

            await this.removeGenRecords(safeSlot, gen);

            meta.generations = meta.generations.filter((g) => g.gen !== gen);
            if (meta.currentGen === gen) {
                meta.currentGen = meta.generations.length > 0 ? Math.max(...meta.generations.map((g) => g.gen)) : 0;
            }
            await this.writeSlotMeta(meta);
            return true;
        } catch {
            return false;
        }
    }

    // ── ISaveStore: thumbnail ───────────────────────────────────────────────

    async setThumbnail(slot: string, data: ArrayBuffer | Uint8Array): Promise<void> {
        const safeSlot = this.sanitizeSlot(slot);
        const buf = data instanceof Uint8Array ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer : data;
        const db = this.ensureDb();
        const tx = db.transaction([THUMBS_STORE, SLOTS_STORE], "readwrite");
        tx.objectStore(THUMBS_STORE).put({ slot: safeSlot, data: buf } as ThumbRecord);
        await this.txDone(tx);

        const meta = await this.readSlotMeta(safeSlot);
        if (meta) {
            meta.hasThumbnail = true;
            await this.writeSlotMeta(meta);
        }
    }

    async getThumbnail(slot: string): Promise<ArrayBuffer | null> {
        try {
            const safeSlot = this.sanitizeSlot(slot);
            const db = this.ensureDb();
            const rec = (await this.reqToPromise(
                db.transaction(THUMBS_STORE, "readonly").objectStore(THUMBS_STORE).get(safeSlot),
            )) as ThumbRecord | undefined;
            return rec?.data ?? null;
        } catch {
            return null;
        }
    }

    // ── ISaveStore: properties ──────────────────────────────────────────────

    async setProperties(slot: string, props: Record<string, unknown>): Promise<void> {
        const safeSlot = this.sanitizeSlot(slot);
        const meta = await this.readSlotMeta(safeSlot);
        if (meta) {
            meta.properties = { ...meta.properties, ...props };
            await this.writeSlotMeta(meta);
        } else {
            const newMeta: SlotMeta = {
                formatVersion: META_FORMAT_VERSION,
                slot: safeSlot,
                currentGen: 0,
                maxGenerations: this.defaultMaxGenerations,
                generations: [],
                properties: props,
                hasThumbnail: false,
            };
            await this.writeSlotMeta(newMeta);
        }
    }

    async getProperties(slot: string): Promise<Record<string, unknown>> {
        try {
            const safeSlot = this.sanitizeSlot(slot);
            const meta = await this.readSlotMeta(safeSlot);
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
