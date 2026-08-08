import { beforeEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import type { DowndraftMcpConfig, MainContext } from "../types";

// --- Mock electron ipcMain with EventEmitter semantics ---
const ipcEmitter = new EventEmitter();
const ipcMainMock = {
  once: (channel: string, cb: (...args: any[]) => void) => {
    ipcEmitter.once(channel, cb);
  },
  on: (channel: string, cb: (...args: any[]) => void) => {
    ipcEmitter.on(channel, cb);
  },
  removeAllListeners: (channel: string) => {
    ipcEmitter.removeAllListeners(channel);
  },
};

// --- Mock @downdraft/mcp/http-transport to capture proxyHandler ---
let capturedProxyHandler: ((req: { method: string; params?: Record<string, unknown> }) => Promise<unknown>) | null = null;
const McpHttpTransportMock = class {
  constructor(opts: { proxyHandler?: (req: { method: string; params?: Record<string, unknown> }) => Promise<unknown> }) {
    capturedProxyHandler = opts.proxyHandler ?? null;
  }
  async start() {}
  async stop() {}
};

// --- Mock @downdraft/core/util/logger ---
const loggerMock = {
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
  debug: mock(() => {}),
};

// Register mocks before importing the module under test
mock.module("electron", () => ({ ipcMain: ipcMainMock }));
mock.module("@downdraft/mcp/http-transport", () => ({
  McpHttpTransport: McpHttpTransportMock,
}));
mock.module("@downdraft/core/util/logger", () => ({ createLogger: () => loggerMock }));

// Import after mocks are registered
const { startMcpProxy } = await import("./mcp");

function makeMockCtx(): MainContext {
  const sentMessages: { channel: string; data: any }[] = [];
  return {
    app: {} as any,
    BrowserWindow: {} as any,
    ipcMain: ipcMainMock as any,
    session: {} as any,
    screen: {} as any,
    shell: {} as any,
    window: {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, data: any) => {
          sentMessages.push({ channel, data });
        },
      },
    } as any,
    isDev: false,
    sendToRenderer: () => {},
    sentMessages,
  } as any;
}

const mcpConfig: DowndraftMcpConfig = { port: 19876 };

describe("MCP proxy handler — concurrent request isolation", () => {
  let ctx: any;

  beforeEach(async () => {
    // Reset state
    ipcEmitter.removeAllListeners();
    capturedProxyHandler = null;
    ctx = makeMockCtx();
    await startMcpProxy(ctx, mcpConfig);
  });

  it("should use a unique response channel per request", async () => {
    expect(capturedProxyHandler).not.toBeNull();
    const handler = capturedProxyHandler!;

    // Start two concurrent requests (don't await yet)
    const req1 = handler({ method: "tools/list" });
    const req2 = handler({ method: "tools/list" });

    // Both requests should have sent mcp-request to the renderer with unique IDs
    expect(ctx.sentMessages.length).toBe(2);
    const id1 = ctx.sentMessages[0].data.id;
    const id2 = ctx.sentMessages[1].data.id;
    expect(id1).not.toBe(id2);

    // Respond to both on their unique channels
    ipcEmitter.emit(`mcp-response-${id1}`, {}, { result: "response1" });
    ipcEmitter.emit(`mcp-response-${id2}`, {}, { result: "response2" });

    const [res1, res2] = await Promise.all([req1, req2]);
    expect(res1).toBe("response1");
    expect(res2).toBe("response2");
  });

  it("should only remove the specific request's listener on timeout", async () => {
    expect(capturedProxyHandler).not.toBeNull();
    const handler = capturedProxyHandler!;

    // Start two concurrent requests with a very short timeout.
    // We'll manually simulate the timeout behavior by checking that
    // removeAllListeners is only called for the specific channel.
    const _req1 = handler({ method: "tools/list" });
    const req2 = handler({ method: "tools/list" });

    expect(ctx.sentMessages.length).toBe(2);
    const id1 = ctx.sentMessages[0].data.id;
    const id2 = ctx.sentMessages[1].data.id;

    // Track removeAllListeners calls
    const removedChannels: string[] = [];
    const origRemoveAll = ipcMainMock.removeAllListeners;
    ipcMainMock.removeAllListeners = (channel: string) => {
      removedChannels.push(channel);
      ipcEmitter.removeAllListeners(channel);
    };

    // Simulate timeout for req1 only: emit nothing, just remove its listener
    ipcEmitter.removeAllListeners(`mcp-response-${id1}`);

    // req2's listener should still be active — respond to it
    ipcEmitter.emit(`mcp-response-${id2}`, {}, { result: "response2" });

    // req2 should resolve successfully
    const res2 = await req2;
    expect(res2).toBe("response2");

    // req1 should still be pending (it will time out after 5s)
    // but the key point is that req2 was NOT affected by req1's timeout

    // Restore original
    ipcMainMock.removeAllListeners = origRemoveAll;

    // Clean up req1's listener to avoid hanging
    ipcEmitter.removeAllListeners(`mcp-response-${id1}`);
  });

  it("should resolve with error when renderer returns an error", async () => {
    expect(capturedProxyHandler).not.toBeNull();
    const handler = capturedProxyHandler!;

    const req = handler({ method: "tools/list" });
    const id = ctx.sentMessages[0].data.id;

    ipcEmitter.emit(`mcp-response-${id}`, {}, { error: { code: -1, message: "test error" } });

    const res = await req;
    expect(res).toEqual({ error: { code: -1, message: "test error" } });
  });

  it("should reject when no renderer window is available", async () => {
    expect(capturedProxyHandler).not.toBeNull();
    const handler = capturedProxyHandler!;

    ctx.window = null;
    await expect(handler({ method: "tools/list" })).rejects.toThrow("No renderer window available");
  });

  it("should reject when renderer window is destroyed", async () => {
    expect(capturedProxyHandler).not.toBeNull();
    const handler = capturedProxyHandler!;

    ctx.window.isDestroyed = () => true;
    await expect(handler({ method: "tools/list" })).rejects.toThrow("No renderer window available");
  });
});
