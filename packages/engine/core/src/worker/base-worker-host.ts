// ============================================================================
// BaseWorkerHost — shared boilerplate for main-thread worker host classes.
//
// Each game's XxxWorkerHost re-implemented the same ~80 lines: SAB allocation,
// wrap(), onerror, onEvents("ready"), stop(), ready tracking, proxy management.
// This base class centralizes that boilerplate. Subclasses provide:
//   - createWorker(): MUST return `new Worker(new URL("./xxx-worker.ts", import.meta.url), { type: "module" })`
//   - onInit(): call the worker's init RPC with the SAB + game-specific args
//   - onEvent(): override for game-specific events (defaults to ready tracking)
//   - getSyncConfig(): optional — buffer sync regions for SAB polyfill (mobile)
//
// CRITICAL: Vite's static analysis requires `new Worker(new URL(..., import.meta.url))`
// to appear literally in the source at the call site. It CANNOT be moved into
// this base class. Subclasses MUST implement createWorker() with the inline
// pattern. Assigning the URL to a variable first breaks production builds
// (Vite emits the worker as a raw unbundled asset with unresolved bare imports).
//
// SAB polyfill: when SharedArrayBuffer is unavailable, the
// base class creates a BufferSyncHost that syncs input regions to the worker
// via requestAnimationFrame + postMessage (transfer). The worker side syncs
// sim data back after each tick batch. See buffer-sync.ts + sab-polyfill.ts.
// Subclasses override getSyncConfig() to declare which regions each side writes.
// ============================================================================

import { usingRealSAB } from "../sab/sab-polyfill";
import { createLogger } from "../util/logger";
import type { BufferSyncConfig, BufferSyncHost } from "./buffer-sync";
import { wrap, type WorkerApi, type WorkerProxy } from "./rpc";

const log = createLogger();

export abstract class BaseWorkerHost<TApi extends WorkerApi> {
  protected sab: SharedArrayBuffer;
  protected proxy: WorkerProxy<TApi> | null = null;
  protected worker: Worker | null = null;
  protected ready = false;
  private unsubEvents: (() => void) | null = null;
  private syncHost: BufferSyncHost | null = null;
  private lifecycleLock: Promise<void> | null = null;

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
   * Serialize start()/stop() — a hot-reload save→stop→start cycle racing a
   * second caller (overlapping swap events, session teardown) must not
   * interleave worker/proxy swaps, or workers get orphaned mid-flight.
   * FIFO mutex; uncontended calls invoke fn synchronously so start() wires
   * the worker in the caller's own tick (post-await subscribers rely on it).
   */
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const prev = this.lifecycleLock;
    this.lifecycleLock = mine;
    const settle = () => {
      if (this.lifecycleLock === mine) this.lifecycleLock = null;
      release();
    };
    if (!prev) {
      const result = Promise.resolve(fn());
      void result.finally(settle);
      return result;
    }
    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        settle();
      }
    });
  }

  /**
   * Spawn the worker and call its init RPC.
   *
   * Subclasses MUST implement createWorker() with the inline
   * `new Worker(new URL("./xxx-worker.ts", import.meta.url), { type: "module" })`
   * pattern. See the file-level comment for why.
   *
   * When SAB is unavailable, a BufferSyncHost is created
   * to sync input regions to the worker via rAF + postMessage. Subclasses
   * override getSyncConfig() to declare the region layout.
   */
  async start(): Promise<void> {
    return this.serialized(async () => {
      // Re-entrant start while a worker is live (overlapping hot reloads,
      // teardown racing a respawn) must not orphan the old worker.
      if (this.worker || this.proxy) await this.stopInner();

      this.worker = this.createWorker();
      // A live worker must never be the only handle pinning the process —
      // window-close teardown stops it explicitly (sim.stop()), but a worker
      // that slips through (error path, missing stop impl) shouldn't hold
      // the runtime open forever. No-op where unref doesn't exist (Deno).
      (this.worker as any).unref?.();
      // 120s rather than the 30s default: in dev, vite's cold transform of a
      // large worker module can exceed 30s, killing init with a spurious
      // timeout while the worker is still legitimately loading.
      this.proxy = wrap<TApi>(this.worker, { timeoutMs: 120_000 });
      // Tag the Worker with its RPC proxy so external force-terminates (dev
      // session teardown) reject pending calls instead of leaving them to
      // hang until their timeout — a hanging caller pins the dying session.
      (this.worker as any).__ddWorkerProxy = this.proxy;

      this.worker.onerror = (e: ErrorEvent) => {
        this.onError(e);
      };

      this.unsubEvents = this.proxy.onEvents((kind: string, data?: unknown) => {
        this.onEvent(kind, data);
      });

      // SAB polyfill: start buffer sync host before onInit so input sync begins
      // as soon as the worker is ready. The host uses rAF to sync input regions.
      if (!usingRealSAB && this.getSyncConfig()) {
        const { BufferSyncHost: BSH } = await import("./buffer-sync");
        this.syncHost = new BSH(this.worker, this.getSyncConfig()!);
        this.syncHost.start();
      }

      // Hook for subclasses to run setup before onInit (e.g. attaching profiling SAB).
      await this.beforeInit();

      await this.onInit();
    });
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
    return this.serialized(() => this.stopInner());
  }

  private async stopInner(): Promise<void> {
    this.syncHost?.stop();
    this.syncHost = null;
    if (this.proxy) {
      try {
        // Bounded graceful shutdown — a wedged worker must not hang stop()
        // (and through it, hot-reload pipelines and session teardown).
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.proxy.proxy.shutdown(),
            new Promise((_, rej) => {
              timer = setTimeout(() => rej(new Error("shutdown RPC timed out")), 2_000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
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
   * Override to run setup before onInit(). Called after the worker is spawned
   * and the proxy is set up, but before onInit(). InstrumentedWorkerHost uses
   * this to attach the ProfilingSAB + patch prototypes before user code runs.
   * Default: no-op.
   */
  protected beforeInit(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Override to declare buffer sync regions for the SAB polyfill (mobile).
   * Return null/undefined to skip sync (e.g. if the host doesn't use SAB).
   * The config should declare which regions the MAIN thread writes (input)
   * vs which the WORKER writes (sim data, stats, board). See buffer-sync.ts.
   * Default: null (no sync — used when SAB is available or host doesn't need sync).
   */
  protected getSyncConfig(): BufferSyncConfig | null {
    return null;
  }

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
    log.error(this.constructor.name, `Worker error: ${e.message}`);
  }
}
