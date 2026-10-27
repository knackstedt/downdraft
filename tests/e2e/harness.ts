// ============================================================================
// E2E test harness — thin spec-facing wrapper over the shared AppClient.
//
// The MCP client, PID-file discovery, process launch + tree kill, readiness
// polling, and console-error capture all live in
// @downdraft/engine/mcp/client (AppClient / launchApp). This file keeps
// only the spec-facing surface: option plumbing (configPath → app name,
// mcpPort → port), the AppProcess/launchApp names specs import, and the
// screenshot/JSON helpers.
// ============================================================================

import {
    AppClient,
    findFreePort,
    launchApp as launchAppProcess,
} from "@downdraft/engine/mcp/client";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

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

export interface AppProcess {
  process: import("node:child_process").ChildProcess;
  mcpClient: McpClient;
  mcpPort: number;
  /** Returns JS errors captured from the app process console output.
   *  Call after tests to verify no uncaught errors occurred. */
  getConsoleErrors(): string[];
  kill(): Promise<void>;
}

export interface LaunchOptions {
  app?: string;
  mcpPort?: number;
  gpu?: "auto" | "hardware" | "swiftshader";
  deterministic?: boolean;
  extraEnv?: Record<string, string>;
  /** Additional error patterns to ignore (regexes, matched against console output). */
  ignoreErrorPatterns?: RegExp[];
  /** Deprecated alias for `app` — a path whose `apps/<name>/` or
   *  `examples/<name>/` segment supplies the app name. */
  configPath?: string;
  /** Override for the native entry point (default: src/native-entry.ts
   *  inside the app dir, or apps/<app>/src/native-entry.ts when running
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
 * Capture a screenshot via the app's MCP automation tools and save it to disk.
 * Returns the parsed metadata (width, height, fullPage) from the tool result.
 */
export async function captureAndSaveScreenshot(
  app: AppProcess,
  filename: string,
  fullPage: boolean = true,
): Promise<{ width: number; height: number; fullPage: boolean }> {
  const client = app.mcpClient as AppClient;
  const out = join(import.meta.dir, "artifacts", filename);
  const meta = await client.screenshot(out, { fullPage });
  return { width: meta.width, height: meta.height, fullPage };
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Does a runnable app exist for `name`? Looks for `downdraft.config.json` or
 * `src/native-entry.ts` under `apps/<name>`, `games/<name>` (local clones),
 * and `examples/<name>` relative to the repo root. App repos may live outside
 * this repo — specs should guard with
 * `describe.skipIf(!appAvailable("x"))` so the suite passes on checkouts
 * without them.
 */
export function appAvailable(name: string): boolean {
  const root = resolve(import.meta.dir, "..", "..");
  for (const base of ["apps", "games", "examples"].values()) {
    const dir = join(root, base, name);
    if (existsSync(join(dir, "downdraft.config.json")) || existsSync(join(dir, "src", "native-entry.ts"))) {
      return true;
    }
  }
  return false;
}

export { findFreePort };

// ---------------------------------------------------------------------------
// App launcher
// ---------------------------------------------------------------------------

export async function launchApp(opts: LaunchOptions = {}): Promise<AppProcess> {
  // Infer the app name from configPath when not given — legacy specs pass a
  // `apps/<name>/...` path whose first segment names the app.
  const app = opts.app
    ?? opts.configPath?.match(/(?:^|\/)(?:apps|examples)\/([^/]+)\//)?.[1]
    ?? "packaging-smoke";

  const launched = await launchAppProcess({
    app,
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
