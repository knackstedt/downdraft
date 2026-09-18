// ============================================================================
// OPFS prototype patching — records IOPS for all OPFS operations.
//
// Patches FileSystemDirectoryHandle.prototype.getDirectoryHandle/getFileHandle,
// FileSystemFileHandle.prototype.createSyncAccessHandle/createWritable/getFile,
// FileSystemSyncAccessHandle.prototype.write/read/flush/close,
// FileSystemWritableFileStream.prototype.write/close.
//
// Each wrapped call: t0=performance.now(), call original, t1, compute bytes
// (where knowable), intern the path tag, push an IopsRecord to the worker's
// IOPS ring, then call warningEngine.checkInstant("iops-latency", ...).
// ============================================================================

import {
    METRIC_IOPS_LATENCY,
    STORE_OPFS,
    type ProfilingSABWriter,
} from "../profiling-sab";
import type { WarningEngine } from "../warnings";

export interface IopsPatchOptions {
  writer: ProfilingSABWriter;
  warningEngine?: WarningEngine | null;
  workerTag: number;
}

// OPFS op kinds (u16 values stored in IopsRecord.opKind)
export const OPFS_OP_GET_DIR_HANDLE = 1;
export const OPFS_OP_GET_FILE_HANDLE = 2;
export const OPFS_OP_CREATE_SYNC_ACCESS_HANDLE = 3;
export const OPFS_OP_CREATE_WRITABLE = 4;
export const OPFS_OP_GET_FILE = 5;
export const OPFS_OP_SYNC_WRITE = 6;
export const OPFS_OP_SYNC_READ = 7;
export const OPFS_OP_SYNC_FLUSH = 8;
export const OPFS_OP_SYNC_CLOSE = 9;
export const OPFS_OP_STREAM_WRITE = 10;
export const OPFS_OP_STREAM_CLOSE = 11;

/** Original prototype methods, saved for unpatching. */
interface OriginalOpfsMethods {
  getDirectoryHandle?: any;
  getFileHandle?: any;
  createSyncAccessHandle?: any;
  createWritable?: any;
  getFile?: any;
  syncWrite?: any;
  syncRead?: any;
  syncFlush?: any;
  syncClose?: any;
  streamWrite?: any;
  streamClose?: any;
}

let originalOpfs: OriginalOpfsMethods | null = null;
let currentWriter: ProfilingSABWriter | null = null;
let currentWarningEngine: WarningEngine | null = null;
let currentWorkerTag: number = 0;

/**
 * Patch OPFS prototypes to record IOPS.
 * Call this from the worker prelude before any worker code runs.
 */
export function patchOpfsPrototypes(opts: IopsPatchOptions): void {
  if (originalOpfs) return; // already patched
  currentWriter = opts.writer;
  currentWarningEngine = opts.warningEngine ?? null;
  currentWorkerTag = opts.workerTag;

  originalOpfs = {};
  const dirProto = (globalThis as any).FileSystemDirectoryHandle?.prototype;
  const fileProto = (globalThis as any).FileSystemFileHandle?.prototype;
  const syncProto = (globalThis as any).FileSystemSyncAccessHandle?.prototype;
  const streamProto = (globalThis as any).FileSystemWritableFileStream?.prototype;

  if (dirProto) {
    if (dirProto.getDirectoryHandle) {
      originalOpfs.getDirectoryHandle = dirProto.getDirectoryHandle;
      dirProto.getDirectoryHandle = makeWrappedAsync(
        OPFS_OP_GET_DIR_HANDLE,
        dirProto.getDirectoryHandle,
        (self: any) => self?.name ?? "dir",
        () => 0,
      );
    }
    if (dirProto.getFileHandle) {
      originalOpfs.getFileHandle = dirProto.getFileHandle;
      dirProto.getFileHandle = makeWrappedAsync(
        OPFS_OP_GET_FILE_HANDLE,
        dirProto.getFileHandle,
        (self: any) => self?.name ?? "dir",
        () => 0,
      );
    }
  }

  if (fileProto) {
    if (fileProto.createSyncAccessHandle) {
      originalOpfs.createSyncAccessHandle = fileProto.createSyncAccessHandle;
      fileProto.createSyncAccessHandle = makeWrappedAsync(
        OPFS_OP_CREATE_SYNC_ACCESS_HANDLE,
        fileProto.createSyncAccessHandle,
        (self: any) => self?.name ?? "file",
        () => 0,
      );
    }
    if (fileProto.createWritable) {
      originalOpfs.createWritable = fileProto.createWritable;
      fileProto.createWritable = makeWrappedAsync(
        OPFS_OP_CREATE_WRITABLE,
        fileProto.createWritable,
        (self: any) => self?.name ?? "file",
        () => 0,
      );
    }
    if (fileProto.getFile) {
      originalOpfs.getFile = fileProto.getFile;
      fileProto.getFile = makeWrappedAsync(
        OPFS_OP_GET_FILE,
        fileProto.getFile,
        (self: any) => self?.name ?? "file",
        (result: any) => result?.size ?? 0,
      );
    }
  }

  if (syncProto) {
    if (syncProto.write) {
      originalOpfs.syncWrite = syncProto.write;
      syncProto.write = makeWrappedSync(
        OPFS_OP_SYNC_WRITE,
        syncProto.write,
        (_self: any, args: any[]) => getBytesFromDataArg(args[0]),
      );
    }
    if (syncProto.read) {
      originalOpfs.syncRead = syncProto.read;
      syncProto.read = makeWrappedSync(
        OPFS_OP_SYNC_READ,
        syncProto.read,
        (result: any) => typeof result === "number" ? result : 0,
      );
    }
    if (syncProto.flush) {
      originalOpfs.syncFlush = syncProto.flush;
      syncProto.flush = makeWrappedSync(OPFS_OP_SYNC_FLUSH, syncProto.flush, () => 0);
    }
    if (syncProto.close) {
      originalOpfs.syncClose = syncProto.close;
      syncProto.close = makeWrappedSync(OPFS_OP_SYNC_CLOSE, syncProto.close, () => 0);
    }
  }

  if (streamProto) {
    if (streamProto.write) {
      originalOpfs.streamWrite = streamProto.write;
      const origWrite = streamProto.write;
      streamProto.write = function (this: any, ...args: any[]): Promise<any> {
        if (!currentWriter) return origWrite.apply(this, args);
        const bytes = getBytesFromDataArg(args[0]);
        const t0 = performance.now();
        const promise = origWrite.apply(this, args);
        return promise.then((result: any) => {
          const latencyUs = Math.round((performance.now() - t0) * 1000);
          recordIops(OPFS_OP_STREAM_WRITE, "stream", bytes, latencyUs);
          return result;
        });
      };
    }
    if (streamProto.close) {
      originalOpfs.streamClose = streamProto.close;
      streamProto.close = makeWrappedAsync(
        OPFS_OP_STREAM_CLOSE,
        streamProto.close,
        (_self: any) => "stream",
        () => 0,
      );
    }
  }
}

/** Restore original OPFS prototypes. */
export function unpatchOpfsPrototypes(): void {
  if (!originalOpfs) return;
  const dirProto = (globalThis as any).FileSystemDirectoryHandle?.prototype;
  const fileProto = (globalThis as any).FileSystemFileHandle?.prototype;
  const syncProto = (globalThis as any).FileSystemSyncAccessHandle?.prototype;
  const streamProto = (globalThis as any).FileSystemWritableFileStream?.prototype;

  if (dirProto) {
    if (originalOpfs.getDirectoryHandle) dirProto.getDirectoryHandle = originalOpfs.getDirectoryHandle;
    if (originalOpfs.getFileHandle) dirProto.getFileHandle = originalOpfs.getFileHandle;
  }
  if (fileProto) {
    if (originalOpfs.createSyncAccessHandle) fileProto.createSyncAccessHandle = originalOpfs.createSyncAccessHandle;
    if (originalOpfs.createWritable) fileProto.createWritable = originalOpfs.createWritable;
    if (originalOpfs.getFile) fileProto.getFile = originalOpfs.getFile;
  }
  if (syncProto) {
    if (originalOpfs.syncWrite) syncProto.write = originalOpfs.syncWrite;
    if (originalOpfs.syncRead) syncProto.read = originalOpfs.syncRead;
    if (originalOpfs.syncFlush) syncProto.flush = originalOpfs.syncFlush;
    if (originalOpfs.syncClose) syncProto.close = originalOpfs.syncClose;
  }
  if (streamProto) {
    if (originalOpfs.streamWrite) streamProto.write = originalOpfs.streamWrite;
    if (originalOpfs.streamClose) streamProto.close = originalOpfs.streamClose;
  }

  originalOpfs = null;
  currentWriter = null;
  currentWarningEngine = null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeWrappedAsync(
  opKind: number,
  original: Function,
  getTag: (self: any) => string,
  getBytes: (result: any) => number,
): Function {
  return function (this: any, ...args: any[]): Promise<any> {
    if (!currentWriter) return original.apply(this, args);
    const tag = getTag(this);
    const t0 = performance.now();
    const promise = original.apply(this, args);
    return promise.then((result: any) => {
      const latencyUs = Math.round((performance.now() - t0) * 1000);
      const bytes = getBytes(result);
      recordIops(opKind, tag, bytes, latencyUs);
      return result;
    });
  };
}

function makeWrappedSync(
  opKind: number,
  original: Function,
  getBytes: (self: any, args: any[], result: any) => number,
): Function {
  return function (this: any, ...args: any[]): any {
    if (!currentWriter) return original.apply(this, args);
    const tag = (this as any)?.name ?? "sync";
    const t0 = performance.now();
    const result = original.apply(this, args);
    const latencyUs = Math.round((performance.now() - t0) * 1000);
    const bytes = getBytes(this, args, result);
    recordIops(opKind, tag, bytes, latencyUs);
    return result;
  };
}

function recordIops(opKind: number, tag: string, bytes: number, latencyUs: number): void {
  if (!currentWriter) return;
  const tagHash = currentWriter.internTag(tag);
  currentWriter.pushIopsRecord({
    opKind,
    store: STORE_OPFS,
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

function getBytesFromDataArg(data: any): number {
  if (typeof data === "string") return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return (data as ArrayBufferView).byteLength;
  return 0;
}
