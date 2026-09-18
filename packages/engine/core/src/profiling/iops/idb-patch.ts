// ============================================================================
// IndexedDB prototype patching — records IOPS for all IDB operations.
//
// Patches IDBFactory.prototype.open/databases, IDBDatabase.prototype.transaction/close,
// IDBTransaction.prototype.objectStore, IDBObjectStore.prototype.get/put/add/delete/
// getAll/getAllKeys/count/openCursor/openKeyCursor/clear, and IDBRequest timing
// (wraps onsuccess/onerror to measure resolve latency).
//
// Tags by db.name + objectStore.name + worker tag.
// ============================================================================

import {
    METRIC_IOPS_LATENCY,
    STORE_IDB,
    type ProfilingSABWriter,
} from "../profiling-sab";
import type { WarningEngine } from "../warnings";

export interface IdbPatchOptions {
  writer: ProfilingSABWriter;
  warningEngine?: WarningEngine | null;
  workerTag: number;
}

// IDB op kinds
export const IDB_OP_OPEN = 1;
export const IDB_OP_DATABASES = 2;
export const IDB_OP_TRANSACTION = 3;
export const IDB_OP_CLOSE = 4;
export const IDB_OP_OBJECT_STORE = 5;
export const IDB_OP_GET = 6;
export const IDB_OP_PUT = 7;
export const IDB_OP_ADD = 8;
export const IDB_OP_DELETE = 9;
export const IDB_OP_GET_ALL = 10;
export const IDB_OP_GET_ALL_KEYS = 11;
export const IDB_OP_COUNT = 12;
export const IDB_OP_OPEN_CURSOR = 13;
export const IDB_OP_OPEN_KEY_CURSOR = 14;
export const IDB_OP_CLEAR = 15;

interface OriginalIdbMethods {
  [key: string]: any;
}

let originalIdb: OriginalIdbMethods | null = null;
let currentWriter: ProfilingSABWriter | null = null;
let currentWarningEngine: WarningEngine | null = null;
let currentWorkerTag: number = 0;

/**
 * Patch IndexedDB prototypes to record IOPS.
 * Call this from the worker prelude before any worker code runs.
 */
export function patchIndexedDbPrototypes(opts: IdbPatchOptions): void {
  if (originalIdb) return; // already patched
  currentWriter = opts.writer;
  currentWarningEngine = opts.warningEngine ?? null;
  currentWorkerTag = opts.workerTag;

  originalIdb = {};
  const factoryProto = (globalThis as any).IDBFactory?.prototype;
  const dbProto = (globalThis as any).IDBDatabase?.prototype;
  const txProto = (globalThis as any).IDBTransaction?.prototype;
  const storeProto = (globalThis as any).IDBObjectStore?.prototype;

  if (factoryProto) {
    if (factoryProto.open) {
      originalIdb.open = factoryProto.open;
      factoryProto.open = wrapRequestMethod(IDB_OP_OPEN, factoryProto.open, (_self: any, args: any[]) => args[0] ?? "db");
    }
    if (factoryProto.databases) {
      originalIdb.databases = factoryProto.databases;
      factoryProto.databases = wrapAsyncMethod(IDB_OP_DATABASES, factoryProto.databases, () => "databases", () => 0);
    }
  }

  if (dbProto) {
    if (dbProto.transaction) {
      originalIdb.transaction = dbProto.transaction;
      dbProto.transaction = wrapSyncMethod(IDB_OP_TRANSACTION, dbProto.transaction, (self: any) => self?.name ?? "db", () => 0);
    }
    if (dbProto.close) {
      originalIdb.close = dbProto.close;
      dbProto.close = wrapSyncMethod(IDB_OP_CLOSE, dbProto.close, (self: any) => self?.name ?? "db", () => 0);
    }
  }

  if (txProto) {
    if (txProto.objectStore) {
      originalIdb.objectStore = txProto.objectStore;
      txProto.objectStore = wrapSyncMethod(IDB_OP_OBJECT_STORE, txProto.objectStore, (self: any) => self?.db?.name ?? "tx", () => 0);
    }
  }

  if (storeProto) {
    const wrapStore = (opKind: number, name: string, getBytes?: (result: any) => number) => {
      if (!storeProto[name]) return;
      if (originalIdb) originalIdb[name] = storeProto[name];
      storeProto[name] = wrapRequestMethod(opKind, storeProto[name], (self: any) => self?.name ?? "store", getBytes);
    };
    wrapStore(IDB_OP_GET, "get", (r: any) => r?.size ?? (r instanceof ArrayBuffer ? r.byteLength : 0));
    wrapStore(IDB_OP_PUT, "put", (_r: any) => 0);
    wrapStore(IDB_OP_ADD, "add", (_r: any) => 0);
    wrapStore(IDB_OP_DELETE, "delete", (_r: any) => 0);
    wrapStore(IDB_OP_GET_ALL, "getAll", (r: any) => Array.isArray(r) ? r.length : 0);
    wrapStore(IDB_OP_GET_ALL_KEYS, "getAllKeys", (r: any) => Array.isArray(r) ? r.length : 0);
    wrapStore(IDB_OP_COUNT, "count", (r: any) => typeof r === "number" ? r : 0);
    wrapStore(IDB_OP_OPEN_CURSOR, "openCursor");
    wrapStore(IDB_OP_OPEN_KEY_CURSOR, "openKeyCursor");
    wrapStore(IDB_OP_CLEAR, "clear");
  }
}

/** Restore original IndexedDB prototypes. */
export function unpatchIndexedDbPrototypes(): void {
  if (!originalIdb) return;
  const factoryProto = (globalThis as any).IDBFactory?.prototype;
  const dbProto = (globalThis as any).IDBDatabase?.prototype;
  const txProto = (globalThis as any).IDBTransaction?.prototype;
  const storeProto = (globalThis as any).IDBObjectStore?.prototype;

  if (factoryProto) {
    if (originalIdb.open) factoryProto.open = originalIdb.open;
    if (originalIdb.databases) factoryProto.databases = originalIdb.databases;
  }
  if (dbProto) {
    if (originalIdb.transaction) dbProto.transaction = originalIdb.transaction;
    if (originalIdb.close) dbProto.close = originalIdb.close;
  }
  if (txProto) {
    if (originalIdb.objectStore) txProto.objectStore = originalIdb.objectStore;
  }
  if (storeProto) {
    for (const name of ["get", "put", "add", "delete", "getAll", "getAllKeys", "count", "openCursor", "openKeyCursor", "clear"]) {
      if (originalIdb[name]) storeProto[name] = originalIdb[name];
    }
  }

  originalIdb = null;
  currentWriter = null;
  currentWarningEngine = null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Wrap an IDB method that returns an IDBRequest. We measure the time from
 * the call until the request's onsuccess/onerror fires (the actual op latency).
 */
function wrapRequestMethod(
  opKind: number,
  original: Function,
  getTag: (self: any, args: any[]) => string,
  getBytes?: (result: any) => number,
): Function {
  return function (this: any, ...args: any[]): any {
    if (!currentWriter) return original.apply(this, args);
    const tag = getTag(this, args);
    const t0 = performance.now();
    const request = original.apply(this, args);
    if (request && typeof request === "object") {
      const measure = () => {
        const latencyUs = Math.round((performance.now() - t0) * 1000);
        const bytes = getBytes ? getBytes(request.result) : 0;
        recordIdb(opKind, tag, bytes, latencyUs);
      };
      // Wrap onsuccess — use defineProperty to intercept the setter
      let _onsuccess: ((ev: Event) => void) | null = null;
      let _onerror: ((ev: Event) => void) | null = null;
      Object.defineProperty(request, "onsuccess", {
        get: () => _onsuccess,
        set: (fn: any) => {
          _onsuccess = fn ? (ev: Event) => { measure(); fn.call(request, ev); } : null;
        },
        configurable: true,
      });
      Object.defineProperty(request, "onerror", {
        get: () => _onerror,
        set: (fn: any) => {
          _onerror = fn ? (ev: Event) => { measure(); fn.call(request, ev); } : null;
        },
        configurable: true,
      });
    }
    return request;
  };
}

function wrapAsyncMethod(
  opKind: number,
  original: Function,
  getTag: (self: any) => string,
  getBytes: (result: any) => number,
): Function {
  return function (this: any, ...args: any[]): Promise<any> {
    if (!currentWriter) return original.apply(this, args);
    const tag = getTag(this);
    const t0 = performance.now();
    return original.apply(this, args).then((result: any) => {
      const latencyUs = Math.round((performance.now() - t0) * 1000);
      const bytes = getBytes(result);
      recordIdb(opKind, tag, bytes, latencyUs);
      return result;
    });
  };
}

function wrapSyncMethod(
  opKind: number,
  original: Function,
  getTag: (self: any) => string,
  getBytes: (result: any) => number,
): Function {
  return function (this: any, ...args: any[]): any {
    if (!currentWriter) return original.apply(this, args);
    const tag = getTag(this);
    const t0 = performance.now();
    const result = original.apply(this, args);
    const latencyUs = Math.round((performance.now() - t0) * 1000);
    const bytes = getBytes(result);
    recordIdb(opKind, tag, bytes, latencyUs);
    return result;
  };
}

function recordIdb(opKind: number, tag: string, bytes: number, latencyUs: number): void {
  if (!currentWriter) return;
  const tagHash = currentWriter.internTag(tag);
  currentWriter.pushIopsRecord({
    opKind,
    store: STORE_IDB,
    tagHash,
    bytes,
    latencyUs,
    ts: performance.now(),
    workerTag: currentWorkerTag,
  });
  if (currentWarningEngine) {
    currentWarningEngine.checkInstant(METRIC_IOPS_LATENCY, latencyUs, { tag });
  }
}
