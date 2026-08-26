// ============================================================================
// Mock IndexedDB — in-memory implementation of the IndexedDB async API
// (IDBFactory / IDBDatabase / IDBTransaction / IDBObjectStore / IDBRequest)
// for testing IndexedDBSaveStore without a real browser environment.
// ============================================================================
//
// Supports: open with onupgradeneeded, createObjectStore, transaction,
// objectStore put/get/getAll/delete/clear, request onsuccess/onerror,
// transaction oncomplete/onerror/onabort, db.objectStoreNames.contains.
//
// Structured-clone semantics are approximated with shallow copies; typed
// arrays are shared by reference (tests should copy on write if needed).

interface MockRecord {
    key: unknown;
    value: unknown;
}

// Approximate structured clone: preserve typed arrays and ArrayBuffers
// (nested inside objects/arrays), plain-copy everything else.
function cloneStructured(value: unknown): unknown {
    if (value === null || value === undefined || typeof value !== "object") return value;
    if (value instanceof ArrayBuffer) return value.slice(0);
    if (ArrayBuffer.isView(value)) {
        const view = value as unknown as { buffer: ArrayBuffer; byteOffset: number; byteLength: number; constructor: new (b: ArrayBuffer, o: number, l: number) => unknown };
        const buf = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
        return new view.constructor(buf, 0, view.byteLength);
    }
    if (Array.isArray(value)) return value.map((v) => cloneStructured(v));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = cloneStructured(v);
    }
    return out;
}

class MockObjectStore {
    name: string;
    keyPath: string | string[] | null;
    records: MockRecord[] = [];
    private autoIncrementCounter = 0;

    constructor(name: string, keyPath?: string | string[]) {
        this.name = name;
        this.keyPath = keyPath ?? null;
    }

    private extractKey(value: unknown, key?: unknown): unknown {
        if (key !== undefined) return key;
        if (this.keyPath === null) {
            // auto-increment out-of-line key
            return ++this.autoIncrementCounter;
        }
        if (Array.isArray(this.keyPath)) {
            return this.keyPath.map((p) => this.readPath(value, p));
        }
        return this.readPath(value, this.keyPath);
    }

    private readPath(obj: unknown, path: string): unknown {
        return path.split(".").reduce<unknown>((o, k) => (o === null || o === undefined ? o : (o as Record<string, unknown>)[k]), obj);
    }

    private findIndex(key: unknown): number {
        return this.records.findIndex((r) => JSON.stringify(r.key) === JSON.stringify(key));
    }

    put(value: unknown, key?: unknown): MockRequest {
        const k = this.extractKey(value, key);
        const idx = this.findIndex(k);
        const record = { key: k, value: this.clone(value) };
        if (idx >= 0) this.records[idx] = record;
        else this.records.push(record);
        return this.schedule(new MockRequest(value));
    }

    get(key: unknown): MockRequest {
        const idx = this.findIndex(key);
        const result = idx >= 0 ? this.records[idx].value : undefined;
        return this.schedule(new MockRequest(result));
    }

    getAll(): MockRequest {
        return this.schedule(new MockRequest(this.records.map((r) => r.value)));
    }

    delete(key: unknown): MockRequest {
        const idx = this.findIndex(key);
        if (idx >= 0) this.records.splice(idx, 1);
        return this.schedule(new MockRequest(undefined));
    }

    clear(): MockRequest {
        this.records = [];
        return this.schedule(new MockRequest(undefined));
    }

    /** Schedule onsuccess asynchronously (mimics real IDB request firing). */
    private schedule(req: MockRequest): MockRequest {
        queueMicrotask(() => req.fireSuccess());
        return req;
    }

    private clone(value: unknown): unknown {
        return cloneStructured(value);
    }
}

class MockRequest {
    result: unknown;
    error: unknown = null;
    onsuccess: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    readyState: "pending" | "done" = "pending";

    constructor(result: unknown) {
        this.result = result;
    }

    fireSuccess(): void {
        this.readyState = "done";
        if (this.onsuccess) this.onsuccess({ target: this });
    }

    fireError(): void {
        this.readyState = "done";
        this.error = new Error("mock idb error");
        if (this.onerror) this.onerror({ target: this });
    }
}

class MockTransaction {
    stores: MockObjectStore[];
    mode: IDBTransactionMode;
    oncomplete: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    private storeMap: Map<string, MockObjectStore>;

    constructor(stores: MockObjectStore[], mode: IDBTransactionMode) {
        this.stores = stores;
        this.mode = mode;
        this.storeMap = new Map(stores.map((s) => [s.name, s]));
        // Fire oncomplete after all pending request microtasks drain.
        // setTimeout(0) runs after the microtask queue, so request onsuccess
        // handlers (scheduled via queueMicrotask) fire first.
        setTimeout(() => this.fireComplete(), 0);
    }

    objectStore(name: string): MockObjectStore {
        const s = this.storeMap.get(name);
        if (!s) throw new Error(`objectStore "${name}" not in transaction`);
        return s;
    }

    fireComplete(): void {
        if (this.oncomplete) this.oncomplete();
    }

    fireError(): void {
        if (this.onerror) this.onerror();
    }
}

class MockDatabase {
    name: string;
    version: number;
    objectStoreNames: { contains(name: string): boolean; [k: string]: unknown; length: number } & Iterable<string>;
    private stores: Map<string, MockObjectStore> = new Map();

    constructor(name: string, version: number) {
        this.name = name;
        this.version = version;
        const names = this.stores;
        this.objectStoreNames = {
            length: 0,
            contains(name: string) {
                return names.has(name);
            },
            *[Symbol.iterator]() {
                for (const n of names.keys()) yield n;
            },
        } as MockDatabase["objectStoreNames"];
    }

    createObjectStore(name: string, opts?: { keyPath?: string | string[] }): MockObjectStore {
        if (this.stores.has(name)) throw new Error(`objectStore "${name}" already exists`);
        const store = new MockObjectStore(name, opts?.keyPath);
        this.stores.set(name, store);
        this.objectStoreNames.length = this.stores.size;
        return store;
    }

    deleteObjectStore(name: string): void {
        this.stores.delete(name);
        this.objectStoreNames.length = this.stores.size;
    }

    transaction(storeNames: string | string[], _mode: IDBTransactionMode): MockTransaction {
        const names = Array.isArray(storeNames) ? storeNames : [storeNames];
        const stores = names.map((n) => {
            const s = this.stores.get(n);
            if (!s) throw new Error(`objectStore "${n}" does not exist`);
            return s;
        });
        return new MockTransaction(stores, _mode);
    }

    close(): void {
        // no-op
    }

    getStore(name: string): MockObjectStore | undefined {
        return this.stores.get(name);
    }
}

class MockIDBFactory {
    private databases: Map<string, MockDatabase> = new Map();

    open(name: string, version: number = 1): {
        onupgradeneeded: ((ev: unknown) => void) | null;
        onsuccess: ((ev: unknown) => void) | null;
        onerror: ((ev: unknown) => void) | null;
        result: MockDatabase;
        error: unknown;
    } {
        let db = this.databases.get(name);
        const isNew = !db;
        if (isNew) {
            db = new MockDatabase(name, version);
            this.databases.set(name, db);
        }
        const req = {
            onupgradeneeded: null as ((ev: unknown) => void) | null,
            onsuccess: null as ((ev: unknown) => void) | null,
            onerror: null as ((ev: unknown) => void) | null,
            result: db as MockDatabase,
            error: null as unknown,
        };
        // Fire events asynchronously (microtask) to mimic real IDB.
        queueMicrotask(() => {
            if (isNew || db!.version !== version) {
                if (db!.version !== version && !isNew) {
                    db! = new MockDatabase(name, version);
                    this.databases.set(name, db!);
                    req.result = db!;
                }
                if (req.onupgradeneeded) req.onupgradeneeded({ target: req, oldVersion: 0 });
            }
            if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
    }

    deleteDatabase(name: string): { onsuccess: (() => void) | null; onerror: (() => void) | null } {
        this.databases.delete(name);
        const req = { onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
        queueMicrotask(() => {
            if (req.onsuccess) req.onsuccess();
        });
        return req;
    }
}

/**
 * Create a fresh mock IndexedDB factory. Each call returns an independent
 * in-memory database set (tests should call this in beforeEach).
 */
export function createMockIndexedDB(): MockIDBFactory {
    return new MockIDBFactory();
}

export type { MockDatabase, MockIDBFactory, MockObjectStore, MockRequest, MockTransaction };

