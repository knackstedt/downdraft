// ============================================================================
// E2E test harness — thin spec-facing wrapper over the shared GameClient.
//
// The MCP client, PID-file discovery, process launch + tree kill, readiness
// polling, and console-error capture all live in
// @downdraft/engine/mcp/client (GameClient / launchGame). This file keeps
// only the spec-facing surface: option plumbing (configPath → game name,
// mcpPort → port), the GameProcess/launchGame names specs import, and the
// screenshot/JSON helpers.
// ============================================================================

import {
    findFreePort,
    GameClient,
    launchGame as launchGameProcess,
} from "@downdraft/engine/mcp/client";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Shared types & utilities (exported for use by spec files)
// ---------------------------------------------------------------------------

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallOptions {
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
}

export interface McpClient {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>, options?: McpCallOptions): Promise<unknown>;
  callToolWithRetry(name: string, args: Record<string, unknown>, options?: McpCallOptions): Promise<unknown>;
  close(): void;
}

export interface GameProcess {
  process: import("node:child_process").ChildProcess;
  mcpClient: McpClient;
  mcpPort: number;
  /** Returns JS errors captured from the game process console output.
   *  Call after tests to verify no uncaught errors occurred. */
  getConsoleErrors(): string[];
  kill(): Promise<void>;
}

export interface LaunchOptions {
  game?: string;
  mcpPort?: number;
  gpu?: "auto" | "hardware" | "swiftshader";
  deterministic?: boolean;
  extraEnv?: Record<string, string>;
  /** Additional error patterns to ignore (regexes, matched against console output). */
  ignoreErrorPatterns?: RegExp[];
  /** Deprecated alias for `game` — a path whose `games/<name>/` or
   *  `examples/<name>/` segment supplies the game name. */
  configPath?: string;
  /** Override for the native entry point (default: src/native-entry.ts
   *  inside the game dir, or games/<game>/src/native-entry.ts when running
   *  from the monorepo root). */
  nativeEntry?: string;
}

// ---------------------------------------------------------------------------
// MCP tool result helpers (shared across all spec files)
// ---------------------------------------------------------------------------

export interface McpToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

/**
 * Parse the text content of an MCP tool result as JSON.
 * Throws a clear assertion error if the tool returned an error (isError: true)
 * or if the text is not valid JSON.
 */
export function parseJsonContent<T = any>(result: unknown): T {
  const r = result as McpToolResult;
  const text = r.content?.[0]?.text ?? "";
  if (r.isError) {
    throw new Error(`MCP tool returned an error: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(
      `MCP tool returned non-JSON text (isError=${r.isError ?? false}): ${(e as Error).message} | text=${text.slice(0, 200)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Filesystem helpers (shared across all spec files)
// ---------------------------------------------------------------------------

export async function saveBase64Png(base64: string, path: string): Promise<void> {
  const { existsSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const data = Buffer.from(base64, "base64");
  await Bun.write(path, data);
}

/**
 * Capture a screenshot via the game's MCP automation tools and save it to disk.
 * Returns the parsed metadata (width, height, fullPage) from the tool result.
 */
export async function captureAndSaveScreenshot(
  game: GameProcess,
  filename: string,
  fullPage: boolean = true,
): Promise<{ width: number; height: number; fullPage: boolean }> {
  const client = game.mcpClient as GameClient;
  const out = join(import.meta.dir, "artifacts", filename);
  const meta = await client.screenshot(out, { fullPage });
  return { width: meta.width, height: meta.height, fullPage };
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { findFreePort };

// ---------------------------------------------------------------------------
// Game launcher
// ---------------------------------------------------------------------------

export async function launchGame(opts: LaunchOptions = {}): Promise<GameProcess> {
  // Infer the game name from configPath when not given — legacy specs pass a
  // `games/<name>/...` path whose first segment names the game.
  const game = opts.game
    ?? opts.configPath?.match(/(?:^|\/)(?:games|examples)\/([^/]+)\//)?.[1]
    ?? "to-the-ocean";

  const launched = await launchGameProcess({
    game,
    entry: opts.nativeEntry,
    port: opts.mcpPort,
    deterministic: opts.deterministic,
    // Respect DOWNDRAFT_GPU from the parent env (set by `draft test
    // --renderer=...`); the client defaults to swiftshader only when
    // neither is set.
    gpu: opts.gpu ?? (process.env.DOWNDRAFT_GPU as "auto" | "hardware" | "swiftshader" | undefined),
    env: opts.extraEnv,
    ignoreErrorPatterns: opts.ignoreErrorPatterns,
    mirrorOutput: true,
  });

  return {
    process: launched.process,
    mcpClient: launched.client,
    mcpPort: launched.port,
    getConsoleErrors: launched.getConsoleErrors,
    kill: launched.kill,
  };
}
