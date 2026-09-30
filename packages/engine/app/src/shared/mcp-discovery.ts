// ============================================================================
// MCP instance discovery — PID-file based. Lets the stdio bridge
// auto-discover running game instances.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const log = createLogger("info");

/**
 * Directory holding one PID file per running downdraft game instance.
 * Each file is named `<pid>` and contains the bound MCP HTTP port (string).
 * The stdio bridge reads this directory to auto-discover running instances;
 * dead-PID files are pruned on read. Best-effort cleanup on process exit.
 */
export function mcpPortDir(): string {
  return join(homedir(), ".downdraft", "port");
}

/**
 * Write `~/.downdraft/port/<pid>` containing the bound port, so the stdio
 * bridge (and other local clients) can discover this instance. Also writes
 * `<pid>.token` holding the transport's bearer token — clients that opt into
 * auth (`mcp.requireAuth` / `MCP_AUTH=1`) read it and send the token via the
 * `Authorization: Bearer <token>` or `X-Downdraft-Token` header. The port
 * file format stays a bare number for backward compatibility with existing
 * bridges. Returns a cleanup function that removes both files (best-effort).
 */
export function writeMcpPidFile(port: number, token: string): () => void {
  const dir = mcpPortDir();
  const pidFile = join(dir, String(process.pid));
  const tokenFile = `${pidFile}.token`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(pidFile, String(port));
    writeFileSync(tokenFile, token, { mode: 0o600 });
  } catch (e) {
    log.warn("MCP", `Failed to write PID file ${pidFile}: ${(e as Error).message}`);
  }
  return () => {
    try { unlinkSync(pidFile); } catch { /* already gone */ }
    try { unlinkSync(tokenFile); } catch { /* already gone */ }
  };
}
