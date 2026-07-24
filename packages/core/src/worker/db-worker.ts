import { parentPort, workerData } from "worker_threads";
import type { WorkerMessage } from "./protocol.ts";

interface DBWorkerData {
  dbPath: string;
}

interface DBCommand {
  op: "save" | "load" | "delete" | "list" | "query";
  key?: string;
  data?: unknown;
  query?: string;
}

class DBWorker {
  private dbPath: string;
  private store: Map<string, unknown> = new Map();

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async init(): Promise<void> {
    // TODO: Initialize SQLite via bun:sqlite when available
    // For now, use in-memory store
    console.log(`[db-worker] Initialized (path: ${this.dbPath})`);
  }

  async execute(cmd: DBCommand): Promise<unknown> {
    switch (cmd.op) {
      case "save":
        if (cmd.key && cmd.data !== undefined) {
          this.store.set(cmd.key, cmd.data);
          return { success: true };
        }
        return { success: false, error: "Missing key or data" };

      case "load":
        if (cmd.key) {
          return this.store.get(cmd.key) ?? null;
        }
        return null;

      case "delete":
        if (cmd.key) {
          this.store.delete(cmd.key);
          return { success: true };
        }
        return { success: false, error: "Missing key" };

      case "list":
        return [...this.store.keys()];

      case "query":
        // TODO: SQL query support
        return [];

      default:
        return { error: `Unknown op: ${cmd.op}` };
    }
  }

  async close(): Promise<void> {
    this.store.clear();
    console.log("[db-worker] Closed");
  }
}

if (parentPort) {
  const data = workerData as DBWorkerData;
  const db = new DBWorker(data.dbPath);

  db.init().then(() => {
    parentPort!.postMessage({ type: "init-ack", id: 0, payload: { ready: true } } as WorkerMessage);

    parentPort!.on("message", async (msg: WorkerMessage) => {
      if (msg.type === "command") {
        const result = await db.execute(msg.payload as DBCommand);
        parentPort!.postMessage({ type: "query-result", id: msg.id, payload: result } as WorkerMessage);
      }
    });
  });
}

export { DBWorker };
export type { DBWorkerData, DBCommand };
