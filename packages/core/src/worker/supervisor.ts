import { createLogger } from "../util/logger.ts";
import type { SimWorkerHandle } from "./sim-worker.ts";

const log = createLogger();

interface SupervisorConfig {
  crashWindowMs: number;
  maxRestarts: number;
}

export class SimWorkerSupervisor {
  private handle: SimWorkerHandle | null = null;
  private restartCount: number = 0;
  private lastCrashTime: number = 0;
  private config: SupervisorConfig;
  private onFatalError: (error: Error) => void;
  private onRestarted: () => void;
  private createWorker: () => SimWorkerHandle;

  constructor(
    createWorker: () => SimWorkerHandle,
    opts: {
      crashWindowMs?: number;
      maxRestarts?: number;
      onFatalError: (error: Error) => void;
      onRestarted: () => void;
    },
  ) {
    this.createWorker = createWorker;
    this.config = {
      crashWindowMs: opts.crashWindowMs ?? 30000,
      maxRestarts: opts.maxRestarts ?? 1,
    };
    this.onFatalError = opts.onFatalError;
    this.onRestarted = opts.onRestarted;
  }

  start(): void {
    this.handle = this.createWorker();
    this.handle.onCrash((err) => this.handleCrash(err));
    this.handle.init().catch((err) => {
      log.error("SimWorkerSupervisor", `Worker init failed: ${err}`);
      this.handleCrash(err instanceof Error ? err : new Error(String(err)));
    });
  }

  getHandle(): SimWorkerHandle | null {
    return this.handle;
  }

  private handleCrash(err: Error): void {
    const now = Date.now();
    const timeSinceLastCrash = now - this.lastCrashTime;

    if (this.restartCount >= this.config.maxRestarts && timeSinceLastCrash < this.config.crashWindowMs) {
      this.onFatalError(err);
      return;
    }

    if (timeSinceLastCrash >= this.config.crashWindowMs) {
      this.restartCount = 0;
    }

    this.restartCount++;
    this.lastCrashTime = now;

    if (this.handle) {
      this.handle.terminate();
    }

    this.handle = this.createWorker();
    this.handle.onCrash((e) => this.handleCrash(e));
    this.handle.init().catch((err) => {
      log.error("SimWorkerSupervisor", `Worker init failed on restart: ${err}`);
      this.handleCrash(err instanceof Error ? err : new Error(String(err)));
    });
    this.onRestarted();
  }

  terminate(): void {
    if (this.handle) {
      this.handle.terminate();
      this.handle = null;
    }
  }
}
