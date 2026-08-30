// ============================================================================
// E2E test harness — MCP-over-HTTP client for driving the game under test.
//
// Robustness features:
// - Process group kill: kills bun + Electron + Vite, not just the bun parent.
// - Dynamic port allocation: avoids port conflicts when running specs in parallel.
// - Retry logic for flaky MCP operations (connection errors, timeouts).
// - Game-ready verification: confirms WebGPU init before tests start.
// - Shared utilities: McpToolResult, parseJsonContent, screenshot helpers.
// - Built mode support: can launch packaged apps (dist/main/index.cjs) for
//   production-build testing.
// ============================================================================

import { createServer } from "node:net";
import { resolve } from "node:path";

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
  process: ReturnType<typeof Bun.spawn>;
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
  /** When true, launch the built app (dist/main/index.cjs) instead of the dev server.
   *  Requires the game to have been built first (`electron-vite build`). */
  built?: boolean;
  /** Working directory for the built app. Defaults to the game root. */
  builtCwd?: string;
  /** Additional error patterns to ignore (regexes, matched against console output). */
  ignoreErrorPatterns?: RegExp[];
  /** Explicit path to the electron.vite.config.ts (relative to cwd). Overrides
   *  the default `games/<game>/electron.vite.config.ts` path — use for
   *  launching examples (`examples/<name>/electron.vite.config.ts`). */
  configPath?: string;
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
export function parseJsonContent(result: unknown): Record<string, unknown> {
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
  const result = (await game.mcpClient.callTool("capture_screenshot", { fullPage })) as McpToolResult;
  const textPart = result.content.find((c) => c.type === "text");
  const meta = textPart?.text
    ? (parseJsonContent(result) as { width?: number; height?: number; fullPage?: boolean })
    : {};
  if (meta.width === undefined || meta.height === undefined) {
    throw new Error("Screenshot tool returned no dimensions");
  }
  const image = result.content.find((c) => c.type === "image");
  if (!image?.data) {
    throw new Error("Screenshot tool returned no image data");
  }
  const { join } = await import("node:path");
  const screenshotDir = join(import.meta.dir, "artifacts");
  await saveBase64Png(image.data, join(screenshotDir, filename));
  return { width: meta.width, height: meta.height, fullPage: meta.fullPage ?? false };
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Port allocation
// ---------------------------------------------------------------------------

/**
 * Find a free TCP port starting from `startPort`.
 * Returns the first available port, or `startPort` if none found in range.
 */
export async function findFreePort(startPort: number = 9976, maxAttempts: number = 50): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    try {
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.close(() => resolve());
        });
      });
      return port;
    } catch {
      // Port in use, try next
    }
  }
  // Fallback: let the OS pick a free port
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address() && typeof server.address() === "object" ? (server.address() as { port: number }).port : startPort;
      server.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// Startup helpers
// ---------------------------------------------------------------------------

async function waitForHealth(port: number, proc: ReturnType<typeof Bun.spawn>, timeoutMs = 90000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    // Fail fast if the process already exited
    if (proc.killed) throw new Error("Game process was killed before MCP health endpoint became ready");
    try {
      const exitCode = await Promise.race([proc.exited, new Promise<undefined>((r) => setTimeout(() => r(undefined), 0))]);
      if (exitCode !== undefined) {
        throw new Error(`Game process exited with code ${exitCode} before MCP health endpoint became ready`);
      }
    } catch {
      // proc.exited throws if killed — that's fine, we check proc.killed above
    }
    try {
      const res = await fetch(`http://localhost:${port}/mcp/health`);
      if (res.ok) return;
    } catch (e) {
      lastErr = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`MCP health endpoint did not become ready on port ${port}: ${lastErr}`);
}

async function waitForTools(port: number, proc: ReturnType<typeof Bun.spawn>, timeoutMs = 90000): Promise<void> {
  // The MCP transport requires `initialize` before any other method.
  // Send it once, then poll `tools/list` until the renderer has registered
  // its automation tools (the harness attaches after the sim worker starts).
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  let lastStatus = 0;
  let lastBody = "";

  // Send initialize first — the transport handles this directly without
  // forwarding to the renderer.
  while (Date.now() < deadline) {
    if (proc.killed) throw new Error("Game process was killed before MCP tools became available");
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const initRes = await fetch(`http://localhost:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      clearTimeout(timeout);
      if (initRes.ok) break;
      lastStatus = initRes.status;
      lastBody = await initRes.text();
    } catch (e) {
      lastErr = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // Now poll tools/list until we get a non-empty list.
  while (Date.now() < deadline) {
    if (proc.killed) throw new Error("Game process was killed before MCP tools became available");
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`http://localhost:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      clearTimeout(timeout);
      if (res.ok) {
        const json = (await res.json()) as { result?: { tools?: unknown[] }; error?: { code: number; message: string } };
        if (json.error) {
          lastErr = `MCP error ${json.error.code}: ${json.error.message}`;
        } else if (Array.isArray(json.result?.tools) && json.result.tools.length > 0) {
          return;
        } else {
          lastErr = `tools list empty or missing: ${JSON.stringify(json).slice(0, 200)}`;
        }
      } else {
        lastStatus = res.status;
        lastBody = await res.text();
        lastErr = `HTTP ${lastStatus}: ${lastBody.slice(0, 200)}`;
      }
    } catch (e) {
      lastErr = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`MCP tools did not become available on port ${port}: ${lastErr}`);
}

/**
 * Verify the game is actually ready by calling a basic state tool.
 * This catches WebGPU init failures and other startup issues early, before
 * tests start failing with mysterious tool errors.
 */
async function verifyGameReady(port: number, proc: ReturnType<typeof Bun.spawn>, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    if (proc.killed) throw new Error("Game process was killed during readiness check");
    try {
      // Try capture_screenshot first — it's available on all games and
      // requires WebGPU to be initialized. If it returns a valid result,
      // the game is ready for testing.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`http://localhost:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "capture_screenshot", arguments: { fullPage: false } },
        }),
      });
      clearTimeout(timeout);
      if (res.ok) {
        const json = (await res.json()) as { result?: McpToolResult; error?: { code: number; message: string } };
        if (json.error) {
          lastErr = `MCP error ${json.error.code}: ${json.error.message}`;
        } else if (json.result?.isError) {
          // Tool returned an error — game may not be ready yet (WebGPU not init)
          const text = json.result.content?.[0]?.text ?? "";
          lastErr = `capture_screenshot error: ${text}`;
        } else if (json.result?.content?.some((c) => c.type === "image" && c.data)) {
          // Got a valid screenshot — game is ready
          return;
        } else {
          lastErr = "capture_screenshot returned no image data";
        }
      } else {
        lastErr = `HTTP ${res.status}`;
      }
    } catch (e) {
      lastErr = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  // Don't throw — some games may not support capture_screenshot in their
  // initial state. Log a warning but allow tests to proceed.
  console.warn(`[harness] Game readiness check failed (non-fatal): ${lastErr}`);
}

// ---------------------------------------------------------------------------
// MCP client
// ---------------------------------------------------------------------------

function createMcpClient(port: number): McpClient {
  async function rpc(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs ?? 60000);
    try {
      const res = await fetch(`http://localhost:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!res.ok) {
        throw new Error(`MCP HTTP ${res.status}: ${await res.text()}`);
      }
      const json = (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
      if (json.error) {
        throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
      }
      return json.result;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async listTools(): Promise<McpTool[]> {
      // initialize is idempotent in the transport — it just sets a flag.
      await rpc("initialize", {}, 10000);
      const result = (await rpc("tools/list", {}, 10000)) as { tools: McpTool[] };
      return result.tools;
    },
    async callTool(name: string, args: Record<string, unknown>, options: McpCallOptions = {}): Promise<unknown> {
      await rpc("initialize", {}, 10000);
      const timeoutMs = options.timeoutMs ?? 60000;
      return rpc("tools/call", { name, arguments: args }, timeoutMs);
    },
    async callToolWithRetry(name: string, args: Record<string, unknown>, options: McpCallOptions = {}): Promise<unknown> {
      const maxRetries = options.retries ?? 3;
      const backoffMs = options.backoffMs ?? 500;
      let lastError: Error | null = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const result = await this.callTool(name, args, options);
          // Check if the tool itself returned an error (isError: true).
          // We don't retry on tool-level errors — only on transport errors.
          const r = result as McpToolResult;
          if (r?.isError) {
            throw new Error(`MCP tool returned an error: ${r.content?.[0]?.text ?? ""}`);
          }
          return result;
        } catch (e) {
          lastError = e as Error;
          // Only retry on transport/connection errors, not tool-level errors
          const isTransportError =
            lastError.message.includes("MCP HTTP") ||
            lastError.message.includes("fetch failed") ||
            lastError.message.includes("aborted") ||
            lastError.message.includes("ECONNREFUSED") ||
            lastError.message.includes("MCP error");
          if (!isTransportError || attempt === maxRetries) {
            throw lastError;
          }
          await sleep(backoffMs * (attempt + 1));
        }
      }
      throw lastError ?? new Error("callToolWithRetry exhausted retries");
    },
    close(): void {
      // No persistent connection to close in HTTP mode.
    },
  };
}

// ---------------------------------------------------------------------------
// Process management — kill the entire process group
// ---------------------------------------------------------------------------

/**
 * Kill a process and its entire process group.
 * On Linux/macOS, uses `process.kill(-pid, signal)` to kill the group.
 * Falls back to killing just the process on platforms that don't support
 * negative PIDs (Windows would need taskkill, but the engine targets Linux).
 */
async function killProcessGroup(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  const pid = proc.pid;
  if (!pid) {
    try { proc.kill(); } catch {}
    return;
  }
  // Try to kill the process group (negative PID)
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Process group kill failed — either not supported or process already dead.
    // Fall back to killing just the process.
    try { proc.kill(); } catch {}
  }
  // Wait up to 5s for the process to exit, then SIGKILL
  try {
    await Promise.race([
      proc.exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
    ]);
  } catch {
    // Process didn't exit in 5s — force kill
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try { proc.kill("SIGKILL"); } catch {}
    }
    try { await proc.exited; } catch {}
  }
}

// ---------------------------------------------------------------------------
// Console error detection
// ---------------------------------------------------------------------------

const DEFAULT_ERROR_PATTERNS = [
  /Uncaught/i,
  /TypeError:/,
  /ReferenceError:/,
  /SyntaxError:/,
  /RangeError:/,
  /WrongDocumentError:/,
  /is not a function/,
  /is not defined/,
  /cannot read propert/i,
  /REJECTED action/i,
  /GPU process exited unexpectedly/i,
  /WebGPU.*not available/i,
  /adapter request failed/i,
  // Worker load failures. COEP/file:// issues, missing worker chunks, or
  // unbundled worker assets all surface as "Worker error: undefined" — the
  // worker script is never fetched so ErrorEvent fields are all undefined.
  /\[.*WorkerHost.*\]\s*Worker error:/i,
  /\[.*WorkerHost.*\]\s*worker error:/i,
];

const DEFAULT_IGNORE_PATTERNS = [
  /ERROR:components\/services\/storage/,
  /ERROR:storage\/browser/,
  /Gtk-Message/,
  /deprecated.*session\.loadExtension/,
  /SandboxOriginDatabase/,
  /Failed to load module.*xapp-gtk3/,
  /Failed to delete the database/,
  /Could not open the quota database/,
  /WebSocket connection.*failed/,
  /gc.*does not exist/,
  /Physics re-initialized after panic/i,
  /Slow (tick|physics)/,
];

function isRealError(line: string, extraIgnorePatterns: RegExp[] = []): boolean {
  const stripped = line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\[[0-9;]*/g, "");
  if (!DEFAULT_ERROR_PATTERNS.some((p) => p.test(stripped))) return false;
  if (DEFAULT_IGNORE_PATTERNS.some((p) => p.test(stripped))) return false;
  if (extraIgnorePatterns.some((p) => p.test(stripped))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Game launcher
// ---------------------------------------------------------------------------

export async function launchGame(opts: LaunchOptions = {}): Promise<GameProcess> {
  const game = opts.game ?? "to-the-ocean";
  // Use dynamic port allocation if no port specified — avoids conflicts
  // when running multiple specs in parallel.
  const port = opts.mcpPort ?? (await findFreePort());
  const env: Record<string, string> = {
    ...process.env,
    MCP_PORT: String(port),
    MCP_TIMEOUT_MS: "120000",
    // Set deterministic mode flag so the renderer can detect test environment
    // (disables persistence, auto-starts game, pauses render loop).
    ...(opts.deterministic ? { DOWNDRAFT_DETERMINISTIC: "1" } : {}),
    // Respect DOWNDRAFT_GPU from the parent env (set by `draft test --renderer=...`).
    // Only fall back to swiftshader if neither the env nor opts specify a GPU mode.
    ...(opts.gpu ? { DOWNDRAFT_GPU: opts.gpu } : {}),
    ...opts.extraEnv,
  };

  // Critical: Electron must NOT run as Node.js. The parent environment
  // (e.g. VS Code, Devin CLI) often sets ELECTRON_RUN_AS_NODE=1, which
  // causes electron.app to be undefined and the app crashes immediately.
  delete env.ELECTRON_RUN_AS_NODE;

  // Determine the launch command based on mode.
  // - Dev mode (default): `electron-vite dev --config games/<game>/electron.vite.config.ts`
  //   (each game owns its own entrypoint — no root dispatcher / env var).
  // - Built mode: `electron .` (launches the packaged app from dist/)
  // The DOWNDRAFT_TEST_BUILT env var is set by `draft test --build`.
  const useBuilt = opts.built || process.env.DOWNDRAFT_TEST_BUILT === "1";
  let cmd: string;
  let cmdArgs: string[];
  let cwd: string;

  if (useBuilt) {
    // Built mode: launch the packaged Electron app directly.
    cmd = "npx";
    cmdArgs = ["electron", "."];
    cwd = opts.builtCwd ?? resolve(process.cwd(), "games", game);
  } else {
    // Dev mode: start the Vite dev server which launches Electron, loading
    // the game's own electron.vite.config.ts entrypoint directly.
    // If configPath is provided (e.g. for examples), use it instead of the
    // default games/<game>/ path.
    cmd = "npx";
    cmdArgs = ["electron-vite", "dev", "--config", opts.configPath ?? `games/${game}/electron.vite.config.ts`];
    cwd = process.cwd();
  }

  const proc = Bun.spawn([cmd, ...cmdArgs], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    cwd,
  });

  // Capture console output lines to detect JS errors.
  const consoleErrors: string[] = [];
  const decoder = new TextDecoder();
  let stdoutBuffer = "";
  let stderrBuffer = "";
  (async () => {
    for await (const chunk of proc.stdout) {
      const text = decoder.decode(chunk);
      stdoutBuffer += text;
      process.stdout.write(text);
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (isRealError(line, opts.ignoreErrorPatterns)) {
          consoleErrors.push(line.replace(/\x1b\[[0-9;]*m/g, "").trim());
        }
      }
    }
  })();
  (async () => {
    for await (const chunk of proc.stderr) {
      const text = decoder.decode(chunk);
      stderrBuffer += text;
      process.stderr.write(text);
      const lines = stderrBuffer.split("\n");
      stderrBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (isRealError(line, opts.ignoreErrorPatterns)) {
          consoleErrors.push(line.replace(/\x1b\[[0-9;]*m/g, "").trim());
        }
      }
    }
  })();

  try {
    await waitForHealth(port, proc, 90000);
    await waitForTools(port, proc, 90000);
    await verifyGameReady(port, proc, 30000);
  } catch (e) {
    await killProcessGroup(proc);
    throw e;
  }

  return {
    process: proc,
    mcpClient: createMcpClient(port),
    mcpPort: port,
    getConsoleErrors(): string[] { return [...consoleErrors]; },
    async kill(): Promise<void> {
      await killProcessGroup(proc);
    },
  };
}

