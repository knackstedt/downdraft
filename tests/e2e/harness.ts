// ============================================================================
// E2E test harness — MCP-over-HTTP client for driving the game under test.
// ============================================================================

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallOptions {
  timeoutMs?: number;
}

export interface McpClient {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>, options?: McpCallOptions): Promise<unknown>;
  close(): void;
}

export interface GameProcess {
  process: ReturnType<typeof Bun.spawn>;
  mcpClient: McpClient;
  kill(): Promise<void>;
}

export interface LaunchOptions {
  game?: string;
  mcpPort?: number;
  gpu?: "auto" | "hardware" | "swiftshader";
  deterministic?: boolean;
  extraEnv?: Record<string, string>;
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

// ---------------------------------------------------------------------------
// MCP client
// ---------------------------------------------------------------------------

function createMcpClient(port: number): McpClient {
  async function rpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
  }

  return {
    async listTools(): Promise<McpTool[]> {
      // initialize is idempotent in the transport — it just sets a flag.
      await rpc("initialize", {});
      const result = (await rpc("tools/list", {})) as { tools: McpTool[] };
      return result.tools;
    },
    async callTool(name: string, args: Record<string, unknown>, options: McpCallOptions = {}): Promise<unknown> {
      await rpc("initialize", {});
      const timeoutMs = options.timeoutMs ?? 60000;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`http://localhost:${port}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          }),
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
    },
    close(): void {
      // No persistent connection to close in HTTP mode.
    },
  };
}

// ---------------------------------------------------------------------------
// Game launcher
// ---------------------------------------------------------------------------

export async function launchGame(opts: LaunchOptions = {}): Promise<GameProcess> {
  const game = opts.game ?? "to-the-ocean";
  const port = opts.mcpPort ?? 9976;
  const env: Record<string, string> = {
    ...process.env,
    DOWNDRAFT_GAME: game,
    MCP_PORT: String(port),
    MCP_TIMEOUT_MS: "120000",
    // Respect DOWNDRAFT_GPU from the parent env (set by `draft test --renderer=...`).
    // Only fall back to swiftshader if neither the env nor opts specify a GPU mode.
    ...(opts.gpu ? { DOWNDRAFT_GPU: opts.gpu } : {}),
    ...opts.extraEnv,
  };

  // Critical: Electron must NOT run as Node.js. The parent environment
  // (e.g. VS Code, Devin CLI) often sets ELECTRON_RUN_AS_NODE=1, which
  // causes electron.app to be undefined and the app crashes immediately.
  delete env.ELECTRON_RUN_AS_NODE;

  const proc = Bun.spawn(["bun", "run", "dev"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Stream logs to console for debugging
  const decoder = new TextDecoder();
  (async () => {
    for await (const chunk of proc.stdout) {
      process.stdout.write(decoder.decode(chunk));
    }
  })();
  (async () => {
    for await (const chunk of proc.stderr) {
      process.stderr.write(decoder.decode(chunk));
    }
  })();

  try {
    await waitForHealth(port, proc, 90000);
    await waitForTools(port, proc, 90000);
  } catch (e) {
    proc.kill();
    throw e;
  }

  return {
    process: proc,
    mcpClient: createMcpClient(port),
    async kill(): Promise<void> {
      proc.kill();
      try {
        await proc.exited;
      } catch {
        // ignore
      }
    },
  };
}

export async function saveBase64Png(base64: string, path: string): Promise<void> {
  const data = Buffer.from(base64, "base64");
  await Bun.write(path, data);
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
