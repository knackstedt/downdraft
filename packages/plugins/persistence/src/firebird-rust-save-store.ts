// ============================================================================
// FirebirdRustSaveStore — Rust-backed ISaveStore implementation
// ============================================================================
//
// Stores save slots as rows in a Firebird database file (one .fdb per store),
// using a Rust NAPI addon that wraps rsfbclient (Rust→libfbclient direct FFI).
// Each slot keeps two generations: 0 = current, 1 = previous (backup).
//
// This is the same concept as FirebirdSaveStore (native, via
// node-firebird-native-api) but the FFI boundary is Rust→C instead of
// Node→C, avoiding the napi_create_external_buffer overhead that dominates
// the native backend's BLOB I/O.
//
// Requirements:
//   - libfbclient.so on the system (loaded dynamically at runtime, no
//     compile-time link needed).
//   - FIREBIRD_LOCK / FIREBIRD_TMP pointing at a writable per-user dir.
//   - The Rust addon built: cd firebird-rust-addon && cargo build --release

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
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const nativeRequire = createRequire(import.meta.url);

const log = createLogger("info");

// ---------------------------------------------------------------------------
// Native addon loading
// ---------------------------------------------------------------------------

const ADDON_PATH = join(
    import.meta.dirname ?? __dirname,
    "..",
    "firebird-rust-addon",
    "target",
    "release",
    "firebird_rust_addon.linux-x64-gnu.node",
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _addon: any | null = null;
function getAddon() {
    if (_addon) return _addon;
    _addon = nativeRequire(ADDON_PATH);
    return _addon;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface FirebirdRustSaveStoreOptions {
    /** Path to the Firebird database file (created on first use). */
    dbPath: string;
    /** Current engine/game version string (e.g. "0.1.0") */
    engineVersion: string;
    /** Path to libfbclient.so. Defaults to /usr/lib/x86_64-linux-gnu/libfbclient.so on Linux. */
    libPath?: string;
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
    /**
     * Directory used for Firebird's lock + tmp files when FIREBIRD_LOCK /
     * FIREBIRD_TMP are unset. Defaults to a per-user subdir of the OS tmpdir.
     * Set to false to disable the override.
     */
    firebirdTmpRoot?: string | false;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RustHandle = any;

export class FirebirdRustSaveStore implements ISaveStore {
    private handle: RustHandle = null;
    private engineVersionPacked: number;
    private migrations: IMigrationRegistry;
    private warningCallbacks: Array<(w: SaveWarning) => void> = [];
    private zstdReady: Promise<void> | null = null;
    private _compress: ((data: Uint8Array) => Uint8Array) | null = null;
    private _decompress: ((data: Uint8Array, originalSize: number) => Uint8Array) | null = null;
    private _hash128: ((data: Uint8Array) => Uint8Array) | null = null;
    private _skipMigrations: boolean = false;
    private dbPath: string;
    private libPath: string;
    private schemaReady: Promise<void> | null = null;

    constructor(opts: FirebirdRustSaveStoreOptions) {
        this.configureFirebirdEnv(opts.firebirdTmpRoot);
        this.dbPath = opts.dbPath;
        this.libPath = opts.libPath ?? "/usr/lib/x86_64-linux-gnu/libfbclient.so";

        // Ensure parent dir exists
        const dir = dirname(opts.dbPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

        const addon = getAddon();
        this.handle = addon.FirebirdRustHandle.open(opts.dbPath, this.libPath);

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
            try { cb(warning); } catch { /* ignore */ }
        }
    }

    private configureFirebirdEnv(root: string | false | undefined): void {
        if (root === false) return;
        if (process.env.FIREBIRD_LOCK && process.env.FIREBIRD_TMP) return;
        const base = root ?? join(tmpdir(), `firebird-${process.getuid?.() ?? "user"}`);
        const lockDir = join(base, "lock");
        const tmpDir = join(base, "tmp");
        try { mkdirSync(lockDir, { recursive: true }); } catch { /* ignore */ }
        try { mkdirSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
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
            this.handle!.ensureSchema();
        })();
        return this.schemaReady;
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

    // ── ISaveStore ──────────────────────────────────────────────────────

    async save(slot: string, state: SaveState): Promise<SaveResult> {
        try {
            await this.ensureSchema();
            const bodyJson = JSON.stringify(state.components);
            const bodyBytes = new TextEncoder().encode(bodyJson);

            const hashBytes = this._hash128 ? this._hash128(bodyBytes) : await this.computeHash(bodyBytes);
            const compressed = this._compress ? this._compress(bodyBytes) : await this.compressBytes(bodyBytes);
            const fileSize = compressed.length + hashBytes.length;

            const safeSlot = this.sanitizeSlot(slot);
            this.handle!.saveSlot(
                safeSlot,
                this.engineVersionPacked,
                state.meta.timestamp,
                state.meta.entityCount,
                state.meta.playerCount,
                compressed,
                hashBytes,
            );

            log.info("FirebirdRustSaveStore", `Saved slot '${slot}' (${fileSize} bytes)`);
            return { success: true, bytes: fileSize };
        } catch (err) {
            log.error("FirebirdRustSaveStore", `Save failed for slot '${slot}': ${err}`);
            return { success: false, bytes: 0 };
        }
    }

    async load(slot: string): Promise<LoadResult> {
        try {
            await this.ensureSchema();
            const safeSlot = this.sanitizeSlot(slot);
            const data = this.handle!.loadSlot(safeSlot);
            if (!data) {
                this.warn({ kind: "no_saves_found", slot, message: `No valid save found for slot '${slot}'` });
                return { state: null };
            }

            const header: SaveHeader = {
                magic: 0,
                formatVersion: 0,
                engineVersionPacked: Number(data.engineVersionPacked),
                timestamp: data.timestamp,
                entityCount: data.entityCount,
                playerCount: data.playerCount,
                bodyHash: data.hash,
                uncompressedBodyLength: 0, // not stored separately in Rust schema
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

            const compressedBody = data.body as Uint8Array;
            const decompressed = this._decompress
                ? this._decompress(compressedBody, 0)
                : await this.decompressBytes(compressedBody, 0);

            const computedHash = this._hash128 ? this._hash128(decompressed) : await this.computeHash(decompressed);
            if (!this.hashEqual(computedHash, header.bodyHash)) {
                this.warn({ kind: "corruption", slot, message: `Hash mismatch for slot '${slot}' (gen ${data.generation})` });
                // Try backup
                if (data.generation === 0) {
                    const bakData = this.handle!.loadSlot(safeSlot);
                    if (bakData && bakData.generation === 1) {
                        this.warn({ kind: "backup_loaded", slot, message: `Loaded backup for slot '${slot}'` });
                        // Re-parse with backup data
                        const bakDecompressed = this._decompress
                            ? this._decompress(bakData.body as Uint8Array, 0)
                            : await this.decompressBytes(bakData.body as Uint8Array, 0);
                        const bakHash = this._hash128 ? this._hash128(bakDecompressed) : await this.computeHash(bakDecompressed);
                        if (this.hashEqual(bakHash, bakData.hash as Uint8Array)) {
                            return this.parseState(slot, bakData, bakDecompressed);
                        }
                    }
                }
                return { state: null };
            }

            return this.parseState(slot, data, decompressed);
        } catch (err) {
            log.error("FirebirdRustSaveStore", `Load failed for slot '${slot}': ${err}`);
            return { state: null };
        }
    }

    private parseState(slot: string, data: { engineVersionPacked: number; timestamp: number; entityCount: number; playerCount: number }, decompressed: Uint8Array): LoadResult {
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

        return {
            state: {
                components: migrated,
                meta: {
                    engineVersion: engineVersionString(Number(data.engineVersionPacked)),
                    timestamp: data.timestamp,
                    entityCount: data.entityCount,
                    playerCount: data.playerCount,
                },
            },
        };
    }

    async listSaves(): Promise<SaveSlotInfo[]> {
        try {
            await this.ensureSchema();
            const slots = this.handle!.listSlots();
            return slots.map((s: { slot: string; engineVersionPacked: number; timestamp: number; entityCount: number; playerCount: number }) => ({
                slot: s.slot,
                engineVersion: engineVersionString(Number(s.engineVersionPacked)),
                timestamp: s.timestamp,
                entityCount: s.entityCount,
                playerCount: s.playerCount,
            }));
        } catch (err) {
            log.error("FirebirdRustSaveStore", `listSaves failed: ${err}`);
            return [];
        }
    }

    async deleteSave(slot: string): Promise<boolean> {
        try {
            await this.ensureSchema();
            const safeSlot = this.sanitizeSlot(slot);
            return this.handle!.deleteSlot(safeSlot);
        } catch (err) {
            log.error("FirebirdRustSaveStore", `deleteSave failed for slot '${slot}': ${err}`);
            return false;
        }
    }

    // ── Cloud save support ──────────────────────────────────────────────

    async exportDatabase(): Promise<Uint8Array> {
        return this.handle!.exportDatabase();
    }

    async importDatabase(bytes: Uint8Array): Promise<void> {
        this.handle!.importDatabase(bytes);
        this.schemaReady = null; // schema already exists in imported DB
    }

    async close(): Promise<void> {
        try {
            this.handle?.close();
            this.handle = null;
        } catch { /* ignore */ }
    }
}
