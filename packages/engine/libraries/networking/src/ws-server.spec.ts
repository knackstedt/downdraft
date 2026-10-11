import { createWebSocketServer, type WsServer, type WsServerConnection } from "./ws-server";

function waitFor<T>(fn: () => T | undefined, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const v = fn();
      if (v !== undefined) return resolve(v);
      if (Date.now() - t0 > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("createWebSocketServer", () => {
  let server: WsServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("binds and reports the bound port", async () => {
    server = await createWebSocketServer({ port: 0, host: "127.0.0.1" });
    expect(server.port).toBeGreaterThan(0);
  });

  it("accepts a connection and echoes binary frames", async () => {
    const received: Array<Uint8Array | string> = [];
    const conns: WsServerConnection[] = [];
    server = await createWebSocketServer({
      port: 0,
      host: "127.0.0.1",
      onConnection: (c) => conns.push(c),
      onMessage: (c, data) => { received.push(data); c.send(data); },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    ws.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });

    const echoed: ArrayBuffer[] = [];
    ws.onmessage = (e) => echoed.push(e.data as ArrayBuffer);
    ws.send(new Uint8Array([1, 2, 3, 4]));

    await waitFor(() => (echoed.length ? echoed : undefined));
    expect(new Uint8Array(echoed[0])).toEqual(new Uint8Array([1, 2, 3, 4]));
    await waitFor(() => (conns.length ? conns : undefined));
    ws.close();
  });

  it("delivers text frames as strings", async () => {
    const received: string[] = [];
    server = await createWebSocketServer({
      port: 0,
      host: "127.0.0.1",
      onMessage: (_c, data) => { if (typeof data === "string") received.push(data); },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });
    ws.send("hello world");
    await waitFor(() => (received.length ? received : undefined));
    expect(received[0]).toBe("hello world");
    ws.close();
  });

  it("reports close with code and reason", async () => {
    let closeInfo: { code: number; reason: string } | null = null;
    server = await createWebSocketServer({
      port: 0,
      host: "127.0.0.1",
      onClose: (_c, code, reason) => { closeInfo = { code, reason }; },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });
    ws.close(4000, "gone");
    await waitFor(() => closeInfo ?? undefined);
    expect(closeInfo!.code).toBe(4000);
    expect(closeInfo!.reason).toBe("gone");
  });

  it("sends text and binary from server to client", async () => {
    let conn: WsServerConnection | null = null;
    server = await createWebSocketServer({
      port: 0,
      host: "127.0.0.1",
      onConnection: (c) => { conn = c; },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    ws.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });

    const got: Array<string | ArrayBuffer> = [];
    ws.onmessage = (e) => got.push(e.data as string | ArrayBuffer);
    conn!.send("text-msg");
    conn!.send(new Uint8Array([9, 8, 7]));

    await waitFor(() => (got.length >= 2 ? got : undefined));
    expect(got[0]).toBe("text-msg");
    expect(new Uint8Array(got[1] as ArrayBuffer)).toEqual(new Uint8Array([9, 8, 7]));
    ws.close();
  });

  it("handles multiple concurrent connections", async () => {
    const conns: WsServerConnection[] = [];
    server = await createWebSocketServer({
      port: 0,
      host: "127.0.0.1",
      onConnection: (c) => conns.push(c),
    });
    const urls = [`ws://127.0.0.1:${server.port}`, `ws://127.0.0.1:${server.port}`];
    const sockets = await Promise.all(urls.map((u) => new Promise<WebSocket>((resolve, reject) => {
      const w = new WebSocket(u);
      w.onopen = () => resolve(w);
      w.onerror = (e) => reject(e);
    })));
    await waitFor(() => (conns.length === 2 ? conns : undefined));
    expect(new Set(conns.map((c) => c.id)).size).toBe(2);
    sockets.forEach((s) => s.close());
  });
});
