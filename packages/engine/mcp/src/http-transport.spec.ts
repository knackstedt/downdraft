import { afterEach, describe, expect, it } from "bun:test";
import { McpHttpTransport } from "./http-transport";

function makeTransport(opts: ConstructorParameters<typeof McpHttpTransport>[0] = {}) {
  return new McpHttpTransport({
    port: 0,
    proxyHandler: async ({ method }) => ({ echo: method }),
    ...opts,
  });
}

function initBody() {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" });
}

describe("McpHttpTransport local-client gate", () => {
  let transport: McpHttpTransport | null = null;
  let base = "";

  async function start(opts?: ConstructorParameters<typeof McpHttpTransport>[0]) {
    transport = makeTransport(opts);
    await transport.start();
    base = `http://127.0.0.1:${transport.getPort()}`;
    return transport;
  }

  afterEach(async () => {
    await transport?.stop();
    transport = null;
  });

  it("rejects requests with a foreign Origin", async () => {
    await start();
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
      body: initBody(),
    });
    expect(res.status).toBe(403);
  });

  it("rejects requests with a null Origin (sandboxed/file: pages)", async () => {
    await start();
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Origin: "null", "Content-Type": "application/json" },
      body: initBody(),
    });
    expect(res.status).toBe(403);
  });

  it("rejects requests with a foreign Host (DNS rebinding)", async () => {
    await start();
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Host: "attacker.example", "Content-Type": "application/json" },
      body: initBody(),
    });
    expect(res.status).toBe(403);
  });

  it("allows requests with no Origin (Node fetch / curl)", async () => {
    await start();
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: initBody(),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { result?: { serverInfo?: { name?: string } } };
    expect(json.result?.serverInfo?.name).toBe("downdraft-mcp");
  });

  it("allows loopback Origins", async () => {
    await start();
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Origin: "http://localhost:5173", "Content-Type": "application/json" },
      body: initBody(),
    });
    expect(res.status).toBe(200);
  });

  it("emits no CORS headers on responses or preflight", async () => {
    await start();
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: initBody(),
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();

    const pre = await fetch(`${base}/mcp`, { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("health endpoint stays reachable without auth headers", async () => {
    await start({ requireAuth: true });
    const res = await fetch(`${base}/mcp/health`);
    expect(res.status).toBe(200);
  });

  it("requireAuth: rejects tokenless requests, accepts the token", async () => {
    const t = await start({ requireAuth: true });
    const noAuth = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: initBody(),
    });
    expect(noAuth.status).toBe(401);

    const bearer = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${t.getAuthToken()}`,
      },
      body: initBody(),
    });
    expect(bearer.status).toBe(200);

    const header = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Downdraft-Token": t.getAuthToken(),
      },
      body: initBody(),
    });
    expect(header.status).toBe(200);
  });
});
