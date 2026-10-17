// ============================================================================
// pipeline-pool.ts — async-first pipeline creation with a per-device memo.
//
// `device.createRenderPipeline` blocks the calling thread on driver compile
// (llvmpipe JITs LLVM IR; hardware drivers do similar). With ~30 pipelines at
// startup that's a serial hitch. The platform's `createRenderPipelineAsync`
// runs compilation on a detached native thread and resolves through the
// async-token pump — this pool puts every engine pipeline through it.
//
// Contract: `acquire*()` returns null while the pipeline compiles; callers must
// already tolerate a null pipeline (skip the draw this frame — virtually every
// pass guards `if (!this.pipeline) return`). Once resolved, subsequent calls
// return the memoized pipeline synchronously.
//
// Fallbacks: mock devices and pre-async platform libs lack
// `createRenderPipelineAsync` — the pool compiles synchronously and returns the
// pipeline immediately, preserving old behavior. `DOWNDRAFT_SYNC_PIPELINES=1`
// forces the sync path for driver debugging.
// ============================================================================

import { createLogger } from "../util/logger";

const log = createLogger();

type PoolEntry =
  | { state: "pending" }
  | { state: "ready"; pipeline: GPURenderPipeline | GPUComputePipeline }
  | { state: "error" };

interface AsyncDevice extends GPUDevice {
  createRenderPipelineAsync?: (d: GPURenderPipelineDescriptor) => Promise<GPURenderPipeline>;
  createComputePipelineAsync?: (d: GPUComputePipelineDescriptor) => Promise<GPUComputePipeline>;
}

const SYNC_PIPELINES = ((): boolean => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.DOWNDRAFT_SYNC_PIPELINES === "1";
})();

export class AsyncPipelinePool {
  private device: AsyncDevice;
  private entries = new Map<string, PoolEntry>();
  private pending = new Set<Promise<void>>();

  constructor(device: GPUDevice) {
    this.device = device as AsyncDevice;
  }

  /**
   * Returns the pipeline for `key`, or null while it compiles. `makeDesc` is
   * only invoked on a cache miss — descriptor construction is skipped while a
   * compile is in flight.
   */
  acquireRender(key: string, makeDesc: () => GPURenderPipelineDescriptor): GPURenderPipeline | null {
    return this.acquire(key, () => {
      const desc = makeDesc();
      const asyncFn = this.device.createRenderPipelineAsync;
      if (SYNC_PIPELINES || typeof asyncFn !== "function") {
        return { sync: this.device.createRenderPipeline(desc) };
      }
      return { promise: asyncFn.call(this.device, desc) };
    }) as GPURenderPipeline | null;
  }

  acquireCompute(key: string, makeDesc: () => GPUComputePipelineDescriptor): GPUComputePipeline | null {
    return this.acquire(key, () => {
      const desc = makeDesc();
      const asyncFn = this.device.createComputePipelineAsync;
      if (SYNC_PIPELINES || typeof asyncFn !== "function") {
        return { sync: this.device.createComputePipeline(desc) };
      }
      return { promise: asyncFn.call(this.device, desc) };
    }) as GPUComputePipeline | null;
  }

  /** Number of compiles currently in flight. */
  pendingCount(): number {
    return this.pending.size;
  }

  /** Resolves when all compiles pending at call time have settled. */
  async whenSettled(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  private acquire(
    key: string,
    start: () => { sync: GPURenderPipeline | GPUComputePipeline } | { promise: Promise<GPURenderPipeline | GPUComputePipeline> },
  ): GPURenderPipeline | GPUComputePipeline | null {
    const existing = this.entries.get(key);
    if (existing) return existing.state === "ready" ? existing.pipeline : null;

    this.entries.set(key, { state: "pending" });
    let started: ReturnType<typeof start>;
    try {
      started = start();
    } catch (err) {
      this.entries.set(key, { state: "error" });
      log.error("pipeline-pool", `pipeline "${key}" descriptor rejected: ${err}`);
      return null;
    }

    if ("sync" in started) {
      this.entries.set(key, { state: "ready", pipeline: started.sync });
      return started.sync;
    }

    const tracked = started.promise.then(
      (pipeline) => { this.entries.set(key, { state: "ready", pipeline }); },
      (err) => {
        this.entries.set(key, { state: "error" });
        log.error("pipeline-pool", `pipeline "${key}" failed to compile: ${err}`);
      },
    ).finally(() => { this.pending.delete(tracked); });
    this.pending.add(tracked);
    return null;
  }
}

const pools = new WeakMap<GPUDevice, AsyncPipelinePool>();

/** The per-device async pipeline pool — share it rather than constructing
 *  per-pass pools so identical keys dedupe globally. */
export function pipelinePool(device: GPUDevice): AsyncPipelinePool {
  let pool = pools.get(device);
  if (!pool) {
    pool = new AsyncPipelinePool(device);
    pools.set(device, pool);
  }
  return pool;
}
