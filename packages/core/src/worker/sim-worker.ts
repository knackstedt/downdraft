import { Worker } from "worker_threads";
import type { WorkerMessage, StepPayload, StepAckPayload } from "./protocol.ts";
import { createMessage, nextMessageId } from "./protocol.ts";

export interface SimWorkerOptions {
  workerPath: string;
  sabBuffers: Record<string, SharedArrayBuffer>;
  config?: Record<string, unknown>;
}

export class SimWorkerHandle {
  private worker: Worker;
  private pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }> = new Map();
  private crashHandlers: Array<(error: Error) => void> = [];
  private heartbeatHandlers: Array<(data: { tick: number; memoryUsage: number; gcPauseTotal: number }) => void> = [];
  ready: boolean = false;

  constructor(opts: SimWorkerOptions) {
    this.worker = new Worker(opts.workerPath, {
      workerData: { sabBuffers: opts.sabBuffers, config: opts.config ?? {} },
    });

    this.worker.on("message", (msg: WorkerMessage) => this.handleMessage(msg));
    this.worker.on("error", (err: Error) => this.handleCrash(err));
    this.worker.on("exit", (code: number) => {
      if (code !== 0) {
        this.handleCrash(new Error(`Sim worker exited with code ${code}`));
      }
    });
  }

  private handleMessage(msg: WorkerMessage): void {
    const pending = this.pending.get(msg.id);
    if (pending) {
      this.pending.delete(msg.id);
      pending.resolve(msg.payload);
      return;
    }

    if (msg.type === "heartbeat") {
      for (let i = 0; i < this.heartbeatHandlers.length; i++) {
        this.heartbeatHandlers[i](msg.payload as { tick: number; memoryUsage: number; gcPauseTotal: number });
      }
    } else if (msg.type === "crash") {
      for (let i = 0; i < this.crashHandlers.length; i++) {
        this.crashHandlers[i](msg.payload as Error);
      }
    }
  }

  private handleCrash(err: Error): void {
    this.ready = false;
    for (let i = 0; i < this.crashHandlers.length; i++) {
      this.crashHandlers[i](err);
    }
  }

  async init(): Promise<void> {
    const id = nextMessageId();
    // SABs are already passed via workerData — init just waits for worker ready signal
    const result = await this.sendWithTimeout("init", id, {});
    this.ready = true;
    return result as void;
  }

  async step(dt: number): Promise<StepAckPayload> {
    const id = nextMessageId();
    const payload: StepPayload = { dt };
    return this.sendWithTimeout("step", id, payload, 2000) as Promise<StepAckPayload>;
  }

  async command(op: string, data?: unknown): Promise<unknown> {
    const id = nextMessageId();
    return this.sendWithTimeout("command", id, { op, data }, 5000);
  }

  private sendWithTimeout(type: string, id: number, payload?: unknown, timeoutMs: number = 5000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Sim worker ${type} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.worker.postMessage(createMessage(type as any, id, payload));
    });
  }

  onCrash(fn: (error: Error) => void): void {
    this.crashHandlers.push(fn);
  }

  onHeartbeat(fn: (data: { tick: number; memoryUsage: number; gcPauseTotal: number }) => void): void {
    this.heartbeatHandlers.push(fn);
  }

  terminate(): void {
    this.worker.terminate();
    this.ready = false;
  }
}
