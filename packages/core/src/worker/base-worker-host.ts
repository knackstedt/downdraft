// ============================================================================
// BaseWorkerHost — shared boilerplate for main-thread worker host classes.
//
// Each game's XxxWorkerHost re-implemented the same ~80 lines: SAB allocation,
// wrap(), onerror, onEvents("ready"), stop(), ready tracking, proxy management.
// This base class centralizes that boilerplate. Subclasses provide:
//   - createWorker(): MUST return `new Worker(new URL("./xxx-worker.ts", import.meta.url), { type: "module" })`
//   - onInit(): call the worker's init RPC with the SAB + game-specific args
//   - onEvent(): override for game-specific events (defaults to ready tracking)
//
// CRITICAL: Vite's static analysis requires `new Worker(new URL(..., import.meta.url))`
// to appear literally in the source at the call site. It CANNOT be moved into
// this base class. Subclasses MUST implement createWorker() with the inline
// pattern. Assigning the URL to a variable first breaks production builds
// (Vite emits the worker as a raw unbundled asset with unresolved bare imports).
// ============================================================================

import { wrap, type WorkerApi, type WorkerProxy } from "./rpc";

export abstract class BaseWorkerHost<TApi extends WorkerApi> {
  protected sab: SharedArrayBuffer;
  protected proxy: WorkerProxy<TApi> | null = null;
  protected worker: Worker | null = null;
  protected ready = false;
  private unsubEvents: (() => void) | null = null;

  constructor(sab: SharedArrayBuffer) {
    this.sab = sab;
  }

  /** The SharedArrayBuffer shared with the worker. */
  getSimBuffer(): SharedArrayBuffer {
    return this.sab;
  }

  /** True after the worker has reported the "ready" event. */
  isReady(): boolean {
    return this.ready;
  }

  /** The typed RPC proxy. Returns null before start() or after stop(). */
  getProxy(): WorkerProxy<TApi> | null {
    return this.proxy;
  }

  /**
   * Spawn the worker and call its init RPC.
   *
   * Subclasses MUST implement createWorker() with the inline
   * `new Worker(new URL("./xxx-worker.ts", import.meta.url), { type: "module" })`
   * pattern. See the file-level comment for why.
   */
  async start(): Promise<void> {
    this.worker = this.createWorker();
    this.proxy = wrap<TApi>(this.worker);

    this.worker.onerror = (e: ErrorEvent) => {
      this.onError(e);
    };

    this.unsubEvents = this.proxy.onEvents((kind: string, data?: unknown) => {
      this.onEvent(kind, data);
    });

    await this.onInit();
  }

  /**
   * Shut down the worker: call shutdown() RPC, terminate, clean up.
   * Safe to call multiple times.
   * Alias for stop() — some games call shutdown(), others stop().
   */
  async shutdown(): Promise<void> {
    return this.stop();
  }

  /**
   * Shut down the worker: call shutdown() RPC, terminate, clean up.
   * Safe to call multiple times.
   */
  async stop(): Promise<void> {
    if (this.proxy) {
      try {
        await this.proxy.proxy.shutdown();
      } catch {
        // Worker may already be dead
      }
      this.proxy.terminate();
    }
    this.unsubEvents?.();
    this.unsubEvents = null;
    this.proxy = null;
    this.worker = null;
    this.ready = false;
  }

  // --- Subclass hooks ---

  /**
   * MUST return `new Worker(new URL("./xxx-worker.ts", import.meta.url), { type: "module" })`.
   * The URL must be inline (not a variable) for Vite's worker bundling to work in production.
   */
  protected abstract createWorker(): Worker;

  /**
   * Called after the worker is spawned and the proxy is set up.
   * Subclasses call their worker's init RPC here, e.g.:
   *   await this.proxy!.proxy.init(this.sab, this.gridW, this.gridH);
   */
  protected abstract onInit(): Promise<void>;

  /**
   * Override for game-specific event handling.
   * Default: sets ready=true on "ready" event.
   */
  protected onEvent(kind: string, _data?: unknown): void {
    if (kind === "ready") {
      this.ready = true;
    }
  }

  /**
   * Override for custom error handling.
   * Default: logs to console with the class name.
   */
  protected onError(e: ErrorEvent): void {
    console.error(`[${this.constructor.name}] Worker error:`, e.message);
  }
}
