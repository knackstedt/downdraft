// ============================================================================
// JobSystem — general-purpose task scheduler for distributing work across threads
// Supports: job queue, dependency tracking, work stealing, parallel execution
// ============================================================================


// --- Job Types ---

export interface Job {
  id: number;
  fn: string;          // function key registered in worker
  args: unknown[];     // serializable arguments
  deps: number[];      // job IDs this depends on
  priority: number;    // lower = higher priority (default 0)
  transfer?: Transferable[];
}

export interface JobResult {
  id: number;
  result?: unknown;
  error?: string;
}

type JobState = "pending" | "ready" | "running" | "done" | "failed";

interface TrackedJob {
  job: Job;
  state: JobState;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  result?: unknown;
  workerIdx?: number;
}

// --- Worker Pool ---

export interface WorkerPoolOptions {
  size?: number;
  workerScript?: string;       // URL or path to worker script
  functions?: Record<string, (...args: unknown[]) => unknown>;
  maxQueueSize?: number;
}

export class WorkerPool {
  private workers: Worker[] = [];
  private busy: boolean[] = [];
  private size: number;
  private fnRegistry: Map<string, (...args: unknown[]) => unknown>;
  private pendingResults: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }> = new Map();
  private msgId = 0;
  private workerScript: string;

  constructor(opts: WorkerPoolOptions = {}) {
    this.size = opts.size ?? Math.max(1, (typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 4) - 1);
    this.fnRegistry = new Map(Object.entries(opts.functions ?? {}));
    this.workerScript = opts.workerScript ?? "";

    for (let i = 0; i < this.size; i++) {
      this.busy.push(false);
      // Workers are created lazily or via setWorkers
    }
  }

  get poolSize(): number { return this.size; }

  setWorkers(workers: Worker[]): void {
    this.workers = workers;
    this.size = workers.length;
    this.busy = new Array(workers.length).fill(false);
    for (let i = 0; i < workers.length; i++) {
      this.attachWorker(i, workers[i]);
    }
  }

  registerFunction(name: string, fn: (...args: unknown[]) => unknown): void {
    this.fnRegistry.set(name, fn);
  }

  getFunction(name: string): ((...args: unknown[]) => unknown) | undefined {
    return this.fnRegistry.get(name);
  }

  getFunctionKeys(): string[] {
    return [...this.fnRegistry.keys()];
  }

  private attachWorker(idx: number, worker: Worker): void {
    worker.addEventListener("message", (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.__jobResult !== true) return;
      const pending = this.pendingResults.get(msg.id);
      if (!pending) return;
      this.pendingResults.delete(msg.id);
      this.busy[idx] = false;
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg.result);
    });
  }

  private findIdleWorker(): number {
    for (let i = 0; i < this.busy.length; i++) {
      if (!this.busy[i] && this.workers[i]) return i;
    }
    return -1;
  }

  async dispatch(fnKey: string, args: unknown[], transfer?: Transferable[]): Promise<unknown> {
    const idx = this.findIdleWorker();
    if (idx < 0) {
      // No idle worker — run on main thread as fallback
      const fn = this.fnRegistry.get(fnKey);
      if (!fn) throw new Error(`Unknown function: ${fnKey}`);
      return fn(...args);
    }

    this.busy[idx] = true;
    const id = ++this.msgId;
    const worker = this.workers[idx];

    return new Promise((resolve, reject) => {
      this.pendingResults.set(id, { resolve, reject });
      worker.postMessage({ __job: true, id, fn: fnKey, args }, transfer ?? []);
    });
  }

  isIdle(): boolean {
    return this.busy.every((b) => !b);
  }

  hasIdleWorker(): boolean {
    return this.findIdleWorker() >= 0;
  }

  getBusyCount(): number {
    return this.busy.filter((b) => b).length;
  }

  terminate(): void {
    for (const w of this.workers) {
      w.terminate();
    }
    this.workers = [];
    this.busy = [];
    for (const [, p] of this.pendingResults) {
      p.reject(new Error("Worker pool terminated"));
    }
    this.pendingResults.clear();
  }
}

// --- JobScheduler ---

export interface JobSchedulerOptions {
  pool?: WorkerPool;
  maxQueueSize?: number;
}

export class JobScheduler {
  private pool: WorkerPool;
  private jobs: Map<number, TrackedJob> = new Map();
  private readyQueue: TrackedJob[] = [];
  private nextJobId = 0;
  private maxQueueSize: number;
  private running = false;

  constructor(opts: JobSchedulerOptions = {}) {
    this.pool = opts.pool ?? new WorkerPool();
    this.maxQueueSize = opts.maxQueueSize ?? 10000;
  }

  get workerPool(): WorkerPool { return this.pool; }

  submit(job: Omit<Job, "id"> & { id?: number }): Promise<unknown> {
    const id = job.id ?? ++this.nextJobId;
    const fullJob: Job = { id, ...job };

    if (this.jobs.size >= this.maxQueueSize) {
      throw new Error("Job queue full");
    }

    return new Promise((resolve, reject) => {
      const tracked: TrackedJob = {
        job: fullJob,
        state: "pending",
        resolve,
        reject,
      };
      this.jobs.set(id, tracked);

      // Check if ready (no deps or all deps done)
      this.checkReady(tracked);
    });
  }

  private checkReady(tracked: TrackedJob): void {
    if (tracked.state !== "pending") return;

    const deps = tracked.job.deps;
    let allDone = true;
    for (let i = 0; i < deps.length; i++) {
      const dep = this.jobs.get(deps[i]);
      if (!dep || dep.state !== "done") {
        allDone = false;
        break;
      }
    }

    if (allDone) {
      tracked.state = "ready";
      this.enqueueReady(tracked);
    }
  }

  private enqueueReady(tracked: TrackedJob): void {
    // Insert by priority (lower number = higher priority)
    let insertIdx = this.readyQueue.length;
    for (let i = 0; i < this.readyQueue.length; i++) {
      if (tracked.job.priority < this.readyQueue[i].job.priority) {
        insertIdx = i;
        break;
      }
    }
    this.readyQueue.splice(insertIdx, 0, tracked);
    this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      while (this.readyQueue.length > 0) {
        const tracked = this.readyQueue.shift()!;
        tracked.state = "running";

        try {
          const result = await this.pool.dispatch(
            tracked.job.fn,
            tracked.job.args,
            tracked.job.transfer,
          );
          tracked.result = result;
          tracked.state = "done";
          tracked.resolve(result);
        } catch (err) {
          tracked.state = "failed";
          tracked.reject(err as Error);
        }

        // Check if any pending jobs are now ready
        for (const [, j] of this.jobs) {
          if (j.state === "pending") {
            this.checkReady(j);
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  // Work stealing: steal a ready job from the queue for inline execution
  stealReady(): TrackedJob | null {
    if (this.readyQueue.length === 0) return null;
    return this.readyQueue.shift()!;
  }

  // Run a job inline on the calling thread (work stealing for main thread)
  async runInline(tracked: TrackedJob): Promise<void> {
    tracked.state = "running";
    try {
      const fn = this.pool.getFunction(tracked.job.fn);
      if (!fn) throw new Error(`Unknown function: ${tracked.job.fn}`);
      const result = fn(...tracked.job.args);
      tracked.result = result;
      tracked.state = "done";
      tracked.resolve(result);
    } catch (err) {
      tracked.state = "failed";
      tracked.reject(err as Error);
    }

    // Check dependents
    for (const [, j] of this.jobs) {
      if (j.state === "pending") {
        this.checkReady(j);
      }
    }
  }

  // Drain: wait for all submitted jobs to complete
  async drain(): Promise<void> {
    while (this.jobs.size > 0) {
      const pending = [...this.jobs.values()].filter((j) => j.state !== "done" && j.state !== "failed");
      if (pending.length === 0) break;

      // Try to pump
      this.pump();

      // If no idle workers, steal work and run inline
      if (!this.pool.hasIdleWorker()) {
        const stolen = this.stealReady();
        if (stolen) {
          await this.runInline(stolen);
        } else {
          // Wait a tick for workers to finish
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    }
    // Cleanup completed jobs
    this.cleanup();
  }

  private cleanup(): void {
    const toDelete: number[] = [];
    for (const [id, j] of this.jobs) {
      if (j.state === "done" || j.state === "failed") {
        toDelete.push(id);
      }
    }
    for (let i = 0; i < toDelete.length; i++) {
      this.jobs.delete(toDelete[i]);
    }
  }

  getStats(): { pending: number; ready: number; running: number; done: number; failed: number } {
    let pending = 0, ready = 0, running = 0, done = 0, failed = 0;
    for (const [, j] of this.jobs) {
      switch (j.state) {
        case "pending": pending++; break;
        case "ready": ready++; break;
        case "running": running++; break;
        case "done": done++; break;
        case "failed": failed++; break;
      }
    }
    return { pending, ready, running, done, failed };
  }

  dispose(): void {
    this.pool.terminate();
    this.jobs.clear();
    this.readyQueue = [];
  }
}

// --- Batch helpers ---

export interface BatchOptions {
  batchSize?: number;
  deps?: number[];
}

export async function parallelMap<T, R>(
  scheduler: JobScheduler,
  fnKey: string,
  items: T[],
  opts: BatchOptions = {},
): Promise<R[]> {
  const batchSize = opts.batchSize ?? Math.max(1, Math.ceil(items.length / (scheduler.workerPool.poolSize || 4)));
  const results: R[] = new Array(items.length);
  const promises: Promise<{ indices: number[]; results: R[] }>[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const end = Math.min(i + batchSize, items.length);
    const batch = items.slice(i, end);
    const indices = Array.from({ length: end - i }, (_, k) => i + k);

    promises.push(
      scheduler.submit({
        fn: fnKey,
        args: [batch, indices],
        deps: opts.deps ? [...opts.deps] : [],
        priority: 0,
      }).then((r) => ({ indices, results: r as R[] }))
    );
  }

  const batchResults = await Promise.all(promises);
  for (const { indices, results: batchRes } of batchResults) {
    for (let k = 0; k < indices.length; k++) {
      results[indices[k]] = batchRes[k];
    }
  }

  return results;
}
