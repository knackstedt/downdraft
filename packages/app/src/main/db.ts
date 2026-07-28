// ============================================================================
// DB Manager — SurrealDB wrapper using a worker thread
// ============================================================================

import { Worker } from "worker_threads";
import { join } from "path";
import { app } from "electron";
import { DbRequest, DbResponse } from "../shared/messages";
import { createLogger } from "./util/logger";

const log = createLogger("info");

class WorkerSurreal {
  private worker: Worker;
  private reqId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private initPromise: Promise<void> | null = null;

  constructor(worker: Worker) {
    this.worker = worker;

    this.worker.on("message", (msg: DbResponse) => {
      if (msg.type === "ready") return;
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.result);
      }
    });

    this.worker.on("error", (err) => {
      log.error("db", `Worker error: ${err}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });

    this.worker.on("exit", (code) => {
      if (code !== 0) {
        log.error("db", `Worker exited with code ${code}`);
        for (const p of this.pending.values()) p.reject(new Error(`DB worker exited with code ${code}`));
        this.pending.clear();
      }
    });
  }

  async connect(dataDir: string): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => { await this.send("init", { dataDir }); })();
    return this.initPromise;
  }

  async query<T>(sql: string, params?: Record<string, unknown>): Promise<T> {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.send("query", { sql, params }) as T;
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        const isRetryable =
          msg.includes("Transaction conflict") ||
          msg.includes("write conflict") ||
          msg.includes("This transaction can be retried");
        if (isRetryable && attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 50 * attempt));
          continue;
        }
        throw err;
      }
    }
    throw new Error("Unreachable");
  }

  private send(type: string, payload: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.reqId;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...payload } as DbRequest);
    });
  }

  async shutdown(): Promise<void> {
    try {
      await this.send("shutdown", {});
    } catch {
      // ignore
    }
    await this.worker.terminate();
  }
}

let dbInstance: WorkerSurreal | null = null;

export async function initDb(): Promise<WorkerSurreal> {
  if (dbInstance) return dbInstance;

  const workerPath = join(__dirname, "db-worker.js");
  const worker = new Worker(workerPath);
  dbInstance = new WorkerSurreal(worker);

  const dataDir = join(app.getPath("userData"), "db");
  await dbInstance.connect(dataDir);

  return dbInstance;
}

export async function getDb(): Promise<WorkerSurreal> {
  if (!dbInstance) throw new Error("DB not initialized");
  return dbInstance;
}

export async function terminateDb(): Promise<void> {
  if (dbInstance) {
    await dbInstance.shutdown();
    dbInstance = null;
  }
}
