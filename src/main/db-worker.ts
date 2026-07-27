// ============================================================================
// DB Worker — SurrealDB embedded (SurrealKV) in a worker thread
// ============================================================================

import { parentPort } from "worker_threads";
import { mkdirSync } from "fs";
import { join } from "path";

let db: any = null;
let initDone = false;

interface DbRequest {
  id: number;
  type: "init" | "query" | "shutdown";
  dataDir?: string;
  sql?: string;
  params?: Record<string, unknown>;
}

interface DbResponse {
  id: number;
  type: string;
  result?: unknown;
  error?: string;
}

async function initDb(dataDir: string) {
  if (initDone) return;

  const [{ Surreal }, { createNodeEngines }] = await Promise.all([
    import("surrealdb"),
    import("@surrealdb/node"),
  ]);

  mkdirSync(dataDir, { recursive: true });

  db = new Surreal({ engines: createNodeEngines() });
  await db.connect(`surrealkv://${join(dataDir, "downdraft.db")}`);
  await db.use({ namespace: "downdraft", database: "main" });

  await db.query(`
    DEFINE TABLE IF NOT EXISTS player SCHEMALESS PERMISSIONS FULL;
    DEFINE TABLE IF NOT EXISTS ship SCHEMALESS PERMISSIONS FULL;
    DEFINE TABLE IF NOT EXISTS world SCHEMALESS PERMISSIONS FULL;
    DEFINE TABLE IF NOT EXISTS inventory SCHEMALESS PERMISSIONS FULL;
    DEFINE TABLE IF NOT EXISTS market_history SCHEMALESS PERMISSIONS FULL;
    DEFINE TABLE IF NOT EXISTS save_game SCHEMALESS PERMISSIONS FULL;
    DEFINE TABLE IF NOT EXISTS ship_design SCHEMALESS PERMISSIONS FULL;
  `);

  initDone = true;
}

parentPort?.on("message", async (req: DbRequest) => {
  if (req.type === "shutdown") {
    try {
      if (db) await db.close();
    } catch {
      // ignore
    }
    parentPort?.postMessage({ id: req.id, type: "shutdown", result: true } as DbResponse);
    parentPort?.close();
    return;
  }

  try {
    let result: unknown;
    if (req.type === "init") {
      if (!req.dataDir) throw new Error("Missing dataDir");
      await initDb(req.dataDir);
      result = true;
    } else if (req.type === "query") {
      if (!initDone) throw new Error("DB not initialized");
      if (!req.sql) throw new Error("Missing sql");
      const raw = await db.query(req.sql, req.params);
      result = JSON.parse(JSON.stringify(raw));
    } else {
      throw new Error(`Unknown db worker request type: ${(req as any).type}`);
    }
    parentPort?.postMessage({ id: req.id, type: req.type, result } as DbResponse);
  } catch (err) {
    parentPort?.postMessage({
      id: req.id,
      type: req.type,
      error: (err as Error).message,
    } as DbResponse);
  }
});

parentPort?.postMessage({ type: "ready" });
