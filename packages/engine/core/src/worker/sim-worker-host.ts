// ============================================================================
// SimWorkerHost — standard control surface for sim workers on BaseWorkerHost.
//
// Every game's XxxWorkerHost re-implemented the same methods on top of
// BaseWorkerHost:
//   - pause()/resume()/step()/setSpeed() fire-and-forget proxy wrappers
//   - getStats() with a try/catch → null fallback
//   - writeInput()/writeInputF32() into the SAB input region
//   - per-game event callback fields (onCollected, onMatched, ...) — replaced
//     here by a generic onSimEvent(kind, cb) registry + "*" wildcard
//   - attachProfilingSAB() — forwards __profilingAttach to the worker proxy
//   - save/load RPC wrappers with null-safe fallbacks — replaced by the
//     generic apiCall()/apiSend() helpers
//
// Subclasses still MUST implement createWorker() with the inline
// `new Worker(new URL("./xxx-worker.ts", import.meta.url), { type: "module" })`
// pattern (Vite static analysis requirement — see base-worker-host.ts) and
// onInit() to call the worker's init RPC.
//
// Example:
//   class MyWorkerHost extends SimWorkerHost<MyApi> {
//     constructor() {
//       const sab = allocateSimBuffer();
//       super(sab);
//       this.setInputWriter(new MySimBufferWriter(sab, OFFSETS, W, H));
//     }
//     protected createWorker() {
//       return new Worker(new URL("./my-worker.ts", import.meta.url), { type: "module" });
//     }
//     protected async onInit() {
//       await this.getProxy()!.proxy.init(this.getSimBuffer());
//     }
//   }
// ============================================================================

import type { LoadOptions, SaveOptions } from "../save/persist-types";
import { createLogger } from "../util/logger";
import { BaseWorkerHost } from "./base-worker-host";
import type { WorkerApi } from "./rpc";
import type { SimWorkerStats } from "./sim-worker-base";

const log = createLogger();

/**
 * The standard control API createSimWorker() exposes worker-side.
 * Workers created with `save:`/`onCommand:` options additionally expose
 * save/load/initSaveStore/restoreFromState/captureState/sendCommand —
 * reachable via the WorkerApi index signature since their presence depends
 * on the worker's options.
 */
export interface SimWorkerControlApi extends WorkerApi {
  pause(): Promise<void>;
  resume(): Promise<void>;
  shutdown(): Promise<void>;
  setSpeed(speed: number): Promise<void>;
  step(): Promise<void>;
  getStats(): Promise<SimWorkerStats>;
}

/**
 * Optional save/command verbs — exposed worker-side when the worker was
 * created with createSimWorker({ save: {...}, onCommand }) or hand-rolled
 * equivalents. Games declare this on their worker API type
 * (`interface MyApi extends SimWorkerControlApi, SimWorkerSaveApi {...}`) to
 * get typed captureState/restoreFromState calls through SimWorkerHost.
 */
export interface SimWorkerSaveApi {
  save(
    slotName: string,
    opts?: SaveOptions,
  ): Promise<{ slotName: string; stateJson: string; success: boolean; gen?: number }>;
  load(slotName: string, stateJson?: string, opts?: LoadOptions): Promise<boolean>;
  initSaveStore(opts: unknown): Promise<void>;
  restoreFromState(stateJson: string, blobs?: Record<string, ArrayBuffer>): Promise<void>;
  captureState(): Promise<{ stateJson: string; blobs?: Record<string, ArrayBuffer> }>;
  sendCommand(cmd: unknown): Promise<void>;
}

/**
 * Minimal input-writer surface — satisfied by GridSimBufferWriter
 * (library-sand) and RawInputRegionWriter (below), or any game writer with
 * the same methods. `field` is a byte offset within the input region.
 */
export interface SimInputWriter {
  writeInput(field: number, value: number): void;
  writeInputF32(field: number, value: number): void;
}

/**
 * Input writer over a raw SAB region — for games that don't use
 * GridSimBufferWriter. Writes i32 via writeInput and f32 via writeInputF32,
 * treating `field` as a byte offset relative to `byteOffset`.
 */
export class RawInputRegionWriter implements SimInputWriter {
  private i32: Int32Array;
  private f32: Float32Array;

  constructor(sab: SharedArrayBuffer, byteOffset: number, byteLength: number) {
    this.i32 = new Int32Array(sab, byteOffset, Math.floor(byteLength / 4));
    this.f32 = new Float32Array(sab, byteOffset, Math.floor(byteLength / 4));
  }

  writeInput(field: number, value: number): void {
    this.i32[field / 4] = value;
  }

  writeInputF32(field: number, value: number): void {
    this.f32[field / 4] = value;
  }
}

export abstract class SimWorkerHost<TApi extends WorkerApi = SimWorkerControlApi> extends BaseWorkerHost<TApi> {
  private eventHandlers = new Map<string, Set<(data: unknown, kind: string) => void>>();
  private inputWriter: SimInputWriter | null = null;

  /**
   * Set the SAB input writer (e.g. the game's GridSimBufferWriter or a
   * RawInputRegionWriter). Typically called from the subclass constructor.
   */
  protected setInputWriter(writer: SimInputWriter): void {
    this.inputWriter = writer;
  }

  // --- Standard control surface (fire-and-forget) ---

  pause(): void {
    this.apiSend((api) => api.pause());
  }

  resume(): void {
    this.apiSend((api) => api.resume());
  }

  step(): void {
    this.apiSend((api) => api.step());
  }

  setSpeed(speed: number): void {
    this.apiSend((api) => api.setSpeed(speed));
  }

  async getStats(): Promise<SimWorkerStats | null> {
    const proxy = this.getProxy();
    if (!proxy?.proxy.getStats) return null;
    try {
      return await proxy.proxy.getStats();
    } catch {
      return null;
    }
  }

  // --- Generic RPC helpers (replace per-game null-safe wrappers) ---

  /**
   * Await a worker RPC, returning null if the worker is not started or the
   * call throws. Replaces the per-game `try { return await proxy.proxy.x() }
   * catch { return null }` pattern.
   */
  protected async apiCall<R>(fn: (api: TApi) => Promise<R>): Promise<R | null> {
    const proxy = this.getProxy();
    if (!proxy) return null;
    try {
      return await fn(proxy.proxy);
    } catch {
      return null;
    }
  }

  /**
   * Fire-and-forget worker RPC — swallows the "not started" and rejection
   * cases. Replaces the per-game `this.getProxy()?.proxy.x().catch(() => {})`
   * pattern.
   */
  protected apiSend(fn: (api: TApi) => unknown): void {
    const proxy = this.getProxy();
    if (!proxy) return;
    try {
      const result = fn(proxy.proxy);
      if (result instanceof Promise) result.catch(() => {});
    } catch {
      // Worker call threw synchronously — ignore (worker may be dead).
    }
  }

  // --- Standard save/command surface ---
  // These wrappers call the RPC verbs createSimWorker() exposes when the
  // worker was created with `save:`/`onCommand:` options (or hand-rolled
  // equivalents). Workers without the verbs return null/false via apiCall.

  /** Serialize + store sim state in the worker; null when not started or unsupported. */
  async save(
    slotName: string,
    opts?: SaveOptions,
  ): Promise<{ slotName: string; stateJson: string; success: boolean; gen?: number } | null> {
    return this.apiCall((api) => api.save(slotName, opts));
  }

  /** Load sim state into the worker. Pass stateJson when the store lives renderer-side. */
  async load(slotName: string, stateJson?: string, opts?: LoadOptions): Promise<boolean> {
    return (await this.apiCall((api) => api.load(slotName, stateJson, opts))) ?? false;
  }

  /**
   * Serialize the worker's save payload — without touching any store. For
   * renderer-owned save flows (createGameSaveSystem) that embed the payload
   * in their own SaveState. Binary data (typed arrays) arrives in `blobs`.
   * Null when the worker wasn't started or doesn't expose captureState.
   */
  async captureState(): Promise<{ stateJson: string; blobs?: Record<string, ArrayBuffer> } | null> {
    return this.apiCall((api) => api.captureState());
  }

  /** Initialize the worker's own save store (e.g. OPFS). Throws when not started. */
  async initSaveStore(opts: unknown): Promise<void> {
    const proxy = this.getProxy();
    if (!proxy) throw new Error("Worker not started");
    await proxy.proxy.initSaveStore(opts);
  }

  /**
   * Restore the worker from a serialized state. Throws when not started.
   * `blobs` carries binary payloads (grid/chunk data) for workers whose
   * restore isn't JSON-expressible.
   */
  async restoreFromState(stateJson: string, blobs?: Record<string, ArrayBuffer>): Promise<void> {
    const proxy = this.getProxy();
    if (!proxy) throw new Error("Worker not started");
    await proxy.proxy.restoreFromState(stateJson, blobs);
  }

  /** Fire-and-forget command dispatch. */
  sendCommand(cmd: unknown): void {
    this.apiSend((api) => api.sendCommand(cmd));
  }

  // --- SAB input writers ---

  /** Write an i32 input field (byte offset within the input region). */
  writeInput(field: number, value: number): void {
    this.inputWriter?.writeInput(field, value);
  }

  /** Write an f32 input field (byte offset within the input region). */
  writeInputF32(field: number, value: number): void {
    this.inputWriter?.writeInputF32(field, value);
  }

  // --- Event subscriptions ---

  /**
   * Subscribe to a worker event kind (e.g. "collected", "matched"). Returns
   * an unsubscribe function. Use "*" to subscribe to all events (replaces the
   * per-game `onEvents(handler)` single-handler field); wildcard callbacks
   * receive the event kind as the second argument.
   */
  onSimEvent(kind: string, cb: (data: unknown, kind: string) => void): () => void {
    let set = this.eventHandlers.get(kind);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(kind, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  /**
   * GameSimWorker-compatible event subscription — the callback receives
   * `{ kind, data }` messages. Lets a renderer-owned SimWorkerHost plug into
   * startGame()'s declarative `events` routing via `module.simFromRenderer`.
   * Returns an unsubscribe function.
   */
  subscribeEvents(cb: (msg: { kind: string; data: unknown }) => void): () => void {
    return this.onSimEvent("*", (data, kind) => cb({ kind, data }));
  }

  /**
   * GameSimWorker-compatible input-buffer accessor. Sim worker hosts share
   * one SAB (input region lives inside the sim buffer); games with a
   * separate input SAB override this.
   */
  getInputBuffer(): SharedArrayBuffer {
    return this.getSimBuffer();
  }

  /**
   * Dispatches the "ready" handshake to the base class, then fans out to
   * per-kind subscribers and "*" wildcard subscribers. Subclasses that
   * override onEvent should call super.onEvent(kind, data) to keep ready
   * tracking + event dispatch working.
   */
  protected override onEvent(kind: string, data?: unknown): void {
    super.onEvent(kind, data);
    const specific = this.eventHandlers.get(kind);
    if (specific) {
      for (const cb of specific) {
        try {
          cb(data, kind);
        } catch (err) {
          log.error(this.constructor.name, `Event handler for "${kind}" threw: ${err}`);
        }
      }
    }
    const wildcard = this.eventHandlers.get("*");
    if (wildcard) {
      for (const cb of wildcard) {
        try {
          cb(data, kind);
        } catch (err) {
          log.error(this.constructor.name, `Wildcard event handler threw: ${err}`);
        }
      }
    }
  }

  // --- Profiling ---

  /**
   * Attach the global ProfilingSAB to the sim worker. Called by the renderer
   * after initDevTools({ profiling: true }) creates the ProfilingBridge.
   * The worker's profiling prelude claims a slot + patches prototypes +
   * initializes the warning engine + event-loop monitor.
   *
   * The worker must expose __profilingAttach (via exposeProfilingApi()).
   */
  async attachProfilingSAB(
    sab: SharedArrayBuffer,
    opts?: {
      workerTag?: string;
      runtime?: number;
      opfs?: boolean;
      idb?: boolean;
      defaultWarningRules?: boolean;
      layout?: {
        maxSlots: number;
        iopsRingCap: number;
        warningRingCap: number;
        stringTableCap: number;
      };
    },
  ): Promise<void> {
    const proxy = this.getProxy();
    if (!proxy) return;
    try {
      await (proxy.proxy as any).__profilingAttach?.(sab, {
        workerTag: opts?.workerTag ?? "sim",
        runtime: opts?.runtime ?? 0,
        opfs: opts?.opfs ?? true,
        idb: opts?.idb ?? true,
        defaultWarningRules: opts?.defaultWarningRules ?? true,
        layout: opts?.layout,
      });
    } catch (err) {
      log.warn(this.constructor.name, `Profiling SAB attach failed: ${err}`);
    }
  }
}
