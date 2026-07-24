import { parentPort, workerData } from "worker_threads";
import type { WorkerMessage } from "./protocol.ts";

interface DBWorkerData {
  dbPath: string;
}

interface DBCommand {
  op: "save" | "load" | "delete" | "list" | "query" | "checkpoint" | "restore" | "transaction" | "batch";
  key?: string;
  data?: unknown;
  query?: string;
  params?: unknown[];
  commands?: DBCommand[];
  timestamp?: number;
}

interface SaveEntry {
  key: string;
  data: string;
  timestamp: number;
  size: number;
}

class DBWorker {
  private dbPath: string;
  private db: unknown = null;
  private store: Map<string, { data: unknown; timestamp: number }> = new Map();
  private useSQLite: boolean = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async init(): Promise<void> {
    try {
      const { Database } = await import("bun:sqlite");
      this.db = new Database(this.dbPath, { create: true });
      this.useSQLite = true;
      this.exec(`CREATE TABLE IF NOT EXISTS saves (
        key TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        size INTEGER NOT NULL
      )`);
      this.exec(`CREATE TABLE IF NOT EXISTS checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        data TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      )`);
      this.exec(`CREATE INDEX IF NOT EXISTS idx_saves_timestamp ON saves(timestamp)`);
      this.exec(`CREATE INDEX IF NOT EXISTS idx_checkpoints_key ON checkpoints(key)`);
    } catch {
      this.useSQLite = false;
      this.db = null;
    }
  }

  private exec(sql: string): void {
    if (!this.useSQLite || !this.db) return;
    try {
      (this.db as { exec: (sql: string) => void }).exec(sql);
    } catch (err) {
      console.error("[db-worker] SQL exec error:", err);
    }
  }

  private prepare(sql: string): unknown | null {
    if (!this.useSQLite || !this.db) return null;
    try {
      return (this.db as { prepare: (sql: string) => unknown }).prepare(sql);
    } catch (err) {
      console.error("[db-worker] SQL prepare error:", err);
      return null;
    }
  }

  async execute(cmd: DBCommand): Promise<unknown> {
    switch (cmd.op) {
      case "save":
        return this.save(cmd.key!, cmd.data);
      case "load":
        return this.load(cmd.key!);
      case "delete":
        return this.delete(cmd.key!);
      case "list":
        return this.list();
      case "query":
        return this.query(cmd.query!, cmd.params);
      case "checkpoint":
        return this.checkpoint(cmd.key!, cmd.data);
      case "restore":
        return this.restore(cmd.key!);
      case "transaction":
        return this.transaction(cmd.commands ?? []);
      case "batch":
        return this.batch(cmd.commands ?? []);
      default:
        return { error: `Unknown op: ${cmd.op}` };
    }
  }

  private save(key: string, data: unknown): { success: boolean; error?: string } {
    const json = JSON.stringify(data);
    const timestamp = Date.now();
    const size = json.length;

    if (this.useSQLite) {
      const stmt = this.prepare(`INSERT OR REPLACE INTO saves (key, data, timestamp, size) VALUES (?, ?, ?, ?)`);
      if (stmt) {
        try {
          (stmt as { run: (...args: unknown[]) => void }).run(key, json, timestamp, size);
          return { success: true };
        } catch (err) {
          return { success: false, error: String(err) };
        }
      }
    }

    this.store.set(key, { data, timestamp });
    return { success: true };
  }

  private load(key: string): unknown {
    if (this.useSQLite) {
      const stmt = this.prepare(`SELECT data FROM saves WHERE key = ?`);
      if (stmt) {
        try {
          const row = (stmt as { get: (...args: unknown[]) => SaveEntry | null }).get(key);
          if (row) return JSON.parse(row.data);
        } catch {
          return null;
        }
      }
    }
    return this.store.get(key)?.data ?? null;
  }

  private delete(key: string): { success: boolean } {
    if (this.useSQLite) {
      const stmt = this.prepare(`DELETE FROM saves WHERE key = ?`);
      if (stmt) {
        try {
          (stmt as { run: (...args: unknown[]) => void }).run(key);
        } catch {
          return { success: false };
        }
      }
    }
    this.store.delete(key);
    return { success: true };
  }

  private list(): string[] {
    if (this.useSQLite) {
      const stmt = this.prepare(`SELECT key FROM saves ORDER BY timestamp DESC`);
      if (stmt) {
        try {
          const rows = (stmt as { all: () => { key: string }[] }).all();
          return rows.map((r) => r.key);
        } catch {
          return [];
        }
      }
    }
    return [...this.store.keys()];
  }

  private query(sql: string, params?: unknown[]): unknown[] {
    if (!this.useSQLite) return [];
    const stmt = this.prepare(sql);
    if (!stmt) return [];
    try {
      if (params && params.length > 0) {
        return (stmt as { all: (...args: unknown[]) => unknown[] }).all(...params);
      }
      return (stmt as { all: () => unknown[] }).all();
    } catch (err) {
      console.error("[db-worker] Query error:", err);
      return [];
    }
  }

  private checkpoint(key: string, data: unknown): { success: boolean; id?: number } {
    const json = JSON.stringify(data);
    const timestamp = Date.now();

    if (this.useSQLite) {
      const stmt = this.prepare(`INSERT INTO checkpoints (key, data, timestamp) VALUES (?, ?, ?)`);
      if (stmt) {
        try {
          const result = (stmt as { run: (...args: unknown[]) => { lastInsertRowid: number } }).run(key, json, timestamp);
          return { success: true, id: result.lastInsertRowid as number };
        } catch (err) {
          return { success: false };
        }
      }
    }

    this.store.set(`checkpoint:${key}:${timestamp}`, { data, timestamp });
    return { success: true };
  }

  private restore(key: string): unknown {
    if (this.useSQLite) {
      const stmt = this.prepare(`SELECT data FROM checkpoints WHERE key = ? ORDER BY timestamp DESC LIMIT 1`);
      if (stmt) {
        try {
          const row = (stmt as { get: (...args: unknown[]) => SaveEntry | null }).get(key);
          if (row) return JSON.parse(row.data);
        } catch {
          return null;
        }
      }
    }

    for (const [k, v] of this.store) {
      if (k.startsWith(`checkpoint:${key}:`)) return v.data;
    }
    return null;
  }

  private async transaction(commands: DBCommand[]): Promise<{ success: boolean; results: unknown[] }> {
    const results: unknown[] = [];
    if (this.useSQLite) {
      this.exec("BEGIN TRANSACTION");
      try {
        for (const cmd of commands) {
          results.push(await this.execute(cmd));
        }
        this.exec("COMMIT");
        return { success: true, results };
      } catch (err) {
        this.exec("ROLLBACK");
        return { success: false, results };
      }
    }

    for (const cmd of commands) {
      results.push(await this.execute(cmd));
    }
    return { success: true, results };
  }

  private async batch(commands: DBCommand[]): Promise<{ success: boolean; results: unknown[] }> {
    const results: unknown[] = [];
    for (const cmd of commands) {
      results.push(await this.execute(cmd));
    }
    return { success: true, results };
  }

  async close(): Promise<void> {
    if (this.useSQLite && this.db) {
      try {
        (this.db as { close: () => void }).close();
      } catch {
        // ignore
      }
    }
    this.store.clear();
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
