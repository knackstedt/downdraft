// ============================================================================
// TaskPool + createTaskWorker — pooled task-worker infrastructure.
//
// Generalized from to-the-ocean's terrain-mesh-pool.ts / terrain-mesh-worker.ts.
//
// Unlike the wrap()/expose() RPC layer, the __job protocol supports
// TRANSFERABLES — task results may include an explicit transfer list
// (mesh vertex/index buffers, etc.) so large payloads move zero-copy.
//
// Host side:
//   const pool = new TaskPool({
//     workerCount: 4,
//     // CRITICAL: `new URL(...)` must be inlined inside `new Worker()` —
//     // Vite only bundles worker modules when it sees this exact pattern.
//     createWorker: () => new Worker(new URL("./my-worker.ts", import.meta.url), { type: "module" }),
//   });
//   await pool.init();
//   const mesh = await pool.dispatch<MeshResult>("generateChunkMesh", [req], req.key);
//
// Worker side:
//   createTaskWorker({ generateChunkMesh: (req) => ({ result, transfer: [buf] }) });
//
// Features: round-robin dispatch with optional per-key worker affinity,
// synchronous-fallback flag when workers fail to spawn, pending-job map
// with reject-on-destroy.
// ============================================================================

// --- Shared protocol ---

export interface JobMessage {
  __job: true;
  id: number;
  fn: string;
  args: unknown[];
}

export interface JobResultMessage {
  __jobResult: true;
  id: number;
  result?: unknown;
  error?: string;
}

/** A task function. Return the result, or `{ result, transfer }` to transfer buffers. */
export type TaskFn = (...args: any[]) => unknown | Promise<unknown>;

/**
 * Worker side: install the __job message handler dispatching to `tasks`.
 * Call at module top level in the worker entry file.
 *
 * Task fns return either a plain result or `{ result, transfer }` where
 * `transfer` is a Transferable[] passed to postMessage for zero-copy return.
 */
export function createTaskWorker(tasks: Record<string, TaskFn>): void {
  self.onmessage = async (e: MessageEvent) => {
    const msg = e.data as JobMessage;
    if (!msg || msg.__job !== true) return;

    const fn = tasks[msg.fn];
    if (!fn) {
      (self as any).postMessage({ __jobResult: true, id: msg.id, error: `Unknown function: ${msg.fn}` } satisfies JobResultMessage);
      return;
    }

    try {
      const out = await fn(...(msg.args ?? []));
      const isWrapped = out != null && typeof out === "object" && "result" in out;
      const result = isWrapped ? (out as any).result : out;
      const transfer: Transferable[] = isWrapped ? ((out as any).transfer ?? []) : [];
      (self as any).postMessage({ __jobResult: true, id: msg.id, result } satisfies JobResultMessage, transfer);
    } catch (err) {
      (self as any).postMessage({ __jobResult: true, id: msg.id, error: String(err) } satisfies JobResultMessage);
    }
  };
}

// --- Host side ---

interface PendingJob {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
}

export interface TaskPoolOptions {
  /** Number of workers. Default: min(4, hardwareConcurrency - 1). */
  workerCount?: number;
  /**
   * Worker factory — MUST contain the inline
   * `new Worker(new URL("./xxx-worker.ts", import.meta.url), { type: "module" })`
   * pattern (Vite static analysis — see base-worker-host.ts).
   */
  createWorker: () => Worker;
  /** Optional worker error hook (default: console.error). */
  onWorkerError?: (index: number, e: ErrorEvent) => void;
}

export class TaskPool {
  private workers: Worker[] = [];
  private pending = new Map<number, PendingJob>();
  private keyWorkerMap = new Map<string, number>();
  private nextJobId = 0;
  private roundRobin = 0;
  private readonly workerCount: number;
  private readonly createWorker: () => Worker;
  private readonly onWorkerError?: (index: number, e: ErrorEvent) => void;
  private fallback = false;
  private destroyed = false;

  constructor(opts: TaskPoolOptions) {
    const hw = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : 4;
    this.workerCount = opts.workerCount ?? Math.min(4, Math.max(1, hw - 1));
    this.createWorker = opts.createWorker;
    this.onWorkerError = opts.onWorkerError;
  }

  /** Spawn all workers. On failure, sets fallback mode (dispatch() rejects). */
  async init(): Promise<void> {
    if (this.destroyed) return;

    try {
      for (let i = 0; i < this.workerCount; i++) {
        const worker = this.createWorker();
        worker.onerror = (e: ErrorEvent) => {
          if (this.onWorkerError) this.onWorkerError(i, e);
          else console.error(`[TaskPool] Worker ${i} error:`, e.message);
        };
        worker.addEventListener("message", (e: MessageEvent) => {
          const msg = e.data as JobResultMessage;
          if (!msg || msg.__jobResult !== true) return;
          const pending = this.pending.get(msg.id);
          if (!pending) return;
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve(msg.result);
          }
        });
        this.workers.push(worker);
      }
    } catch (err) {
      console.warn("[TaskPool] Failed to spawn workers, falling back to synchronous:", err);
      this.fallback = true;
    }
  }

  /** True when worker spawn failed — callers should run tasks in-line. */
  isFallback(): boolean {
    return this.fallback;
  }

  /** Number of live workers. */
  get size(): number {
    return this.workers.length;
  }

  /**
   * Dispatch a task. `affinityKey` pins all calls with the same key to the
   * same worker (e.g. an island key so field generation state is reused).
   * Rejects when no workers are available (fallback mode).
   */
  dispatch<T>(taskName: string, args: unknown[], affinityKey?: string): Promise<T> {
    if (this.fallback || this.workers.length === 0) {
      return Promise.reject(new Error(`[TaskPool] No workers available for task: ${taskName}`));
    }

    const id = ++this.nextJobId;

    let workerIndex: number;
    if (affinityKey && this.keyWorkerMap.has(affinityKey)) {
      workerIndex = this.keyWorkerMap.get(affinityKey)!;
    } else {
      workerIndex = this.roundRobin % this.workers.length;
      this.roundRobin++;
      if (affinityKey) {
        this.keyWorkerMap.set(affinityKey, workerIndex);
      }
    }

    const worker = this.workers[workerIndex];
    const msg: JobMessage = { __job: true, id, fn: taskName, args };

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: any) => void, reject });
      worker.postMessage(msg);
    });
  }

  /** Terminate all workers and reject pending jobs. Safe to call twice. */
  destroy(): void {
    this.destroyed = true;
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    for (const pending of this.pending.values()) {
      pending.reject(new Error("TaskPool destroyed"));
    }
    this.pending.clear();
    this.keyWorkerMap.clear();
  }
}

// ============================================================================
// PortChannel — RPC channel over a transferred MessagePort.
//
// Generalized from overburden's pathfinding-broker.ts: the renderer spawns a
// task worker (so Vite can bundle it), creates a MessageChannel, and transfers
// one port to each side. The sim-side broker wraps its port with this class —
// attachPort() replaces any existing channel, dispose() shuts it down.
// ============================================================================

import { wrap, type WorkerApi, type WorkerProxy } from "./rpc";

export class PortChannel<TApi extends WorkerApi> {
  protected proxy: WorkerProxy<TApi> | null = null;
  private _ready = false;

  /**
   * Attach a MessagePort connected to the task worker. Replaces any existing
   * channel (the old proxy is terminated).
   */
  attachPort(port: MessagePort): void {
    if (this.proxy) {
      this.proxy.terminate();
    }
    // timeoutMs: 0 — task calls may be long-running; no RPC timeout.
    this.proxy = wrap<TApi>(port as any, { timeoutMs: 0 });
    this._ready = true;
  }

  /** True once a port is attached. */
  isReady(): boolean {
    return this._ready;
  }

  /** The typed RPC proxy (null before attachPort / after dispose). */
  getProxy(): WorkerProxy<TApi> | null {
    return this.proxy;
  }

  /** Detach the port — sends shutdown() best-effort, then terminates. */
  dispose(): void {
    if (this.proxy) {
      try {
        this.proxy.proxy.shutdown?.().catch(() => { /* port may already be closed */ });
      } catch { /* ignore */ }
      this.proxy.terminate();
    }
    this.proxy = null;
    this._ready = false;
  }
}
