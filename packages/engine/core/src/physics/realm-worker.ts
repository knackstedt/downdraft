import type { RealmTier } from "./interface";
import type { RealmWorkerRequest, RealmWorkerResponse } from "./worker-protocol";

/**
 * Wraps a single Web Worker that owns one or more physics realm `World`
 * instances. The host communicates via postMessage; transform buffers are
 * transferred (not copied) where possible.
 *
 * If `SharedArrayBuffer` is available, transform buffers can be shared
 * between host and worker (zero-copy reads). Otherwise, buffers are
 * transferred back and forth.
 */
export class RealmWorker {
  private worker: Worker;
  private nextRequestId: number = 0;
  private pending: Map<number, { resolve: (resp: RealmWorkerResponse) => void; reject: (err: Error) => void }> = new Map();
  private realmIds: Set<number> = new Set();
  public readonly tier: RealmTier;

  constructor(workerUrl: string | URL, tier: RealmTier) {
    this.tier = tier;
    this.worker = new Worker(workerUrl, { type: "module" });
    this.worker.onmessage = (e: MessageEvent) => {
      const resp = e.data as RealmWorkerResponse & { requestId?: number };
      if (resp.requestId !== undefined) {
        const pending = this.pending.get(resp.requestId);
        if (pending) {
          this.pending.delete(resp.requestId);
          pending.resolve(resp);
        }
      }
    };
    this.worker.onerror = (e) => {
      // Reject all pending requests on error
      for (const [, pending] of this.pending.entries()) {
        pending.reject(new Error(`Worker error: ${e.message}`));
      }
      this.pending.clear();
    };
  }

  hasRealm(realmId: number): boolean {
    return this.realmIds.has(realmId);
  }

  addRealm(realmId: number): void {
    this.realmIds.add(realmId);
  }

  removeRealm(realmId: number): void {
    this.realmIds.delete(realmId);
  }

  /**
   * Send a request to the worker and await the response.
   * Transferable buffers are transferred (not copied).
   */
  request(req: RealmWorkerRequest, transfer: Transferable[] = []): Promise<RealmWorkerResponse> {
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({ ...req, requestId }, transfer);
    });
  }

  /**
   * Send a fire-and-forget message (no response expected).
   */
  notify(req: RealmWorkerRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(req, transfer);
  }

  terminate(): void {
    this.worker.terminate();
    for (const [, pending] of this.pending.entries()) {
      pending.reject(new Error("Worker terminated"));
    }
    this.pending.clear();
    this.realmIds.clear();
  }
}

/**
 * Checks if SharedArrayBuffer is available (requires COOP/COEP headers).
 */
export function supportsSharedArrayBuffer(): boolean {
  return typeof SharedArrayBuffer !== "undefined";
}

/**
 * Checks if nested Web Workers are supported (creating a Worker from within
 * another Worker). In some environments (e.g. older Electron), this may fail.
 */
export function supportsNestedWorkers(): boolean {
  try {
    // We can't fully test without creating a worker, but we can check
    // that the Worker constructor exists in the current context.
    return typeof Worker !== "undefined";
  } catch {
    return false;
  }
}
