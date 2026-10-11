// ============================================================================
// ws-server.ts — minimal tri-runtime WebSocket server for host-authoritative
// LAN/WAN sessions. The networking library ships client transports
// (WebSocketTransport, WebRTCTransport) but had no listener — this fills the
// host side so a game instance can accept direct connections without any
// external service.
//
// Runtime selection is capability-based (see platform/runtime.ts):
//   Bun  → Bun.serve({ fetch, websocket })
//   Deno → Deno.serve + Deno.upgradeWebSocket
//   Node → node:http + a hand-rolled RFC6455 handshake/framer (pure JS,
//          no native deps — also the fallback for any runtime with node:http)
//
// Semantics intentionally mirror the browser WebSocket surface: text frames
// arrive as `string`, binary frames as `Uint8Array`. Ping/pong/close and
// fragmented-frame reassembly are handled internally. Message cap matches
// WebSocketTransport's 16 MiB.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger();

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_SIZE = 16 * 1024 * 1024;

/** One accepted client connection on a {@link WsServer}. */
export interface WsServerConnection {
  /** Server-assigned connection id (monotonic per server). */
  readonly id: number;
  /** Remote peer "ip:port" or best-effort address string. */
  readonly remoteAddress: string;
  /** Send a text (string) or binary (Uint8Array/ArrayBuffer) frame. */
  send(data: string | Uint8Array | ArrayBuffer): void;
  /** Initiate the close handshake (default code 1000). */
  close(code?: number, reason?: string): void;
}

export interface WebSocketServerHandlers {
  /** A client completed the WS handshake. */
  onConnection?(conn: WsServerConnection): void;
  /** A complete (reassembled) message arrived. */
  onMessage?(conn: WsServerConnection, data: Uint8Array | string): void;
  /** The connection closed (cleanly or via error/timeout). */
  onClose?(conn: WsServerConnection, code: number, reason: string): void;
}

export interface WebSocketServerOptions extends WebSocketServerHandlers {
  /** TCP port to listen on. 0 = ephemeral (read `server.port` after start). */
  port: number;
  /** Bind address — default "0.0.0.0" (all interfaces, for LAN/WAN). */
  host?: string;
}

export interface WsServer {
  /** The port actually bound (differs from opts.port when 0 was passed). */
  readonly port: number;
  /** The bound hostname. */
  readonly host: string;
  /** All currently-open connections. */
  connections(): WsServerConnection[];
  /** Stop listening and close every connection. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

interface InternalConn extends WsServerConnection {
  /** Runtime-specific raw socket/sendable handle. */
  raw: unknown;
}

function makeServerBase(handlers: WebSocketServerHandlers) {
  const conns = new Set<InternalConn>();
  let nextId = 1;

  const deliver = (conn: InternalConn, data: Uint8Array | string) => {
    const size = typeof data === "string" ? data.length : data.byteLength;
    if (size > MAX_MESSAGE_SIZE) { conn.close(1009, "message too large"); return; }
    try { handlers.onMessage?.(conn, data); } catch (e) { log.error("WsServer", `onMessage threw: ${e}`); }
  };

  const drop = (conn: InternalConn, code: number, reason: string) => {
    if (!conns.delete(conn)) return;
    try { handlers.onClose?.(conn, code, reason); } catch (e) { log.error("WsServer", `onClose threw: ${e}`); }
  };

  return { conns, nextId: () => nextId++, deliver, drop };
}

// ---------------------------------------------------------------------------
// Bun — Bun.serve with the `websocket` handler map
// ---------------------------------------------------------------------------

function startBunServer(opts: WebSocketServerOptions): Promise<WsServer> {
  const Bun = (globalThis as any).Bun;
  const base = makeServerBase(opts);

  const server = (Bun.serve as (o: unknown) => { port: number; stop(force?: boolean): Promise<void> })({
    port: opts.port,
    hostname: opts.host ?? "0.0.0.0",
    fetch(req: Request, srv: any) {
      const ip = srv.requestIP(req);
      const conn: InternalConn = {
        id: base.nextId(),
        remoteAddress: `${ip?.address ?? "?"}:${ip?.port ?? "?"}`,
        raw: null,
        send(data: string | Uint8Array | ArrayBuffer) { if (this.raw) (this.raw as any).send(data instanceof ArrayBuffer ? new Uint8Array(data) : data as never); },
        close(code = 1000, reason = "") { if (this.raw) (this.raw as any).close(code, reason); },
      };
      return srv.upgrade(req, { data: { conn } }) ? undefined : new Response("WebSocket upgrade required", { status: 426 });
    },
    websocket: {
      open(ws: any) {
        const conn = ws.data.conn as InternalConn;
        conn.raw = ws;
        base.conns.add(conn);
        try { opts.onConnection?.(conn); } catch (e) { log.error("WsServer", `onConnection threw: ${e}`); }
      },
      message(ws: any, msg: string | ArrayBuffer | Uint8Array) {
        const conn = ws.data.conn as InternalConn;
        base.deliver(conn, typeof msg === "string" ? msg : new Uint8Array(msg as ArrayBufferLike));
      },
      close(ws: any, code: number, reason: string) {
        base.drop(ws.data.conn as InternalConn, code, reason);
      },
    },
  });

  return Promise.resolve({
    port: server.port as number,
    host: opts.host ?? "0.0.0.0",
    connections: () => [...base.conns],
    async close() {
      [...base.conns].forEach((c) => c.close(1001, "server shutdown"));
      await server.stop(true);
    },
  });
}

// ---------------------------------------------------------------------------
// Deno — Deno.serve + Deno.upgradeWebSocket
// ---------------------------------------------------------------------------

function startDenoServer(opts: WebSocketServerOptions): Promise<WsServer> {
  const Deno = (globalThis as any).Deno;
  const base = makeServerBase(opts);

  const server = Deno.serve(
    { port: opts.port, hostname: opts.host ?? "0.0.0.0" },
    (req: Request, info: { remoteAddr?: { hostname: string; port: number } }) => {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426 });
      }
      const { socket, response } = Deno.upgradeWebSocket(req);
      const conn: InternalConn = {
        id: base.nextId(),
        remoteAddress: info?.remoteAddr ? `${info.remoteAddr.hostname}:${info.remoteAddr.port}` : "?",
        raw: socket,
        send(data: string | Uint8Array | ArrayBuffer) { try { socket.send(data as never); } catch { /* closing */ } },
        close(code = 1000, reason = "") { try { socket.close(code, reason); } catch { /* already closed */ } },
      };
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        base.conns.add(conn);
        try { opts.onConnection?.(conn); } catch (e) { log.error("WsServer", `onConnection threw: ${e}`); }
      };
      socket.onmessage = (e: MessageEvent) => {
        base.deliver(conn, typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer));
      };
      socket.onclose = (e: CloseEvent) => base.drop(conn, e.code, e.reason);
      socket.onerror = () => base.drop(conn, 1006, "socket error");
      return response;
    },
  );

  const bound = server.addr as { port: number; hostname: string };
  return Promise.resolve({
    port: bound.port,
    host: bound.hostname,
    connections: () => [...base.conns],
    async close() {
      [...base.conns].forEach((c) => c.close(1001, "server shutdown"));
      await server.shutdown();
    },
  });
}

// ---------------------------------------------------------------------------
// Node (and generic fallback) — node:http + hand-rolled RFC6455
// ---------------------------------------------------------------------------

/** Encode one server→client frame. Server frames are never masked. */
function encodeWsFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const len = payload.byteLength;
  let header: Uint8Array;
  if (len < 126) {
    header = new Uint8Array(2);
    header[1] = len;
  } else if (len <= 0xffff) {
    header = new Uint8Array(4);
    header[1] = 126;
    header[2] = len >>> 8; header[3] = len & 0xff;
  } else {
    header = new Uint8Array(10);
    header[1] = 127;
    const dv = new DataView(header.buffer);
    dv.setUint32(2, Math.floor(len / 0x100000000));
    dv.setUint32(6, len >>> 0);
  }
  header[0] = 0x80 | (opcode & 0x0f);
  const out = new Uint8Array(header.length + len);
  out.set(header, 0);
  out.set(payload, header.length);
  return out;
}

const OP_CONT = 0x0, OP_TEXT = 0x1, OP_BIN = 0x2, OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xa;

async function startNodeServer(opts: WebSocketServerOptions): Promise<WsServer> {
  const http = await import("node:http");
  const crypto = await import("node:crypto");
  const base = makeServerBase(opts);

  const httpServer = http.createServer((_req, res) => {
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("WebSocket upgrade required");
  });

  httpServer.on("upgrade", (req: import("node:http").IncomingMessage, socket: import("node:net").Socket) => {
    socket.setNoDelay(true);
    const key = req.headers["sec-websocket-key"];
    const upgrade = req.headers.upgrade?.toLowerCase();
    if (upgrade !== "websocket" || typeof key !== "string") {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    let closed = false;
    const conn: InternalConn = {
      id: base.nextId(),
      remoteAddress: `${socket.remoteAddress ?? "?"}:${socket.remotePort ?? "?"}`,
      raw: socket,
      send(data: string | Uint8Array | ArrayBuffer) {
        if (closed || socket.destroyed) return;
        if (typeof data === "string") {
          socket.write(Buffer.from(encodeWsFrame(OP_TEXT, Buffer.from(data, "utf8"))));
        } else {
          const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
          socket.write(Buffer.from(encodeWsFrame(OP_BIN, bytes)));
        }
      },
      close(code = 1000, reason = "") {
        if (closed) return;
        closed = true;
        const payload = new Uint8Array(2 + reason.length);
        payload[0] = code >>> 8; payload[1] = code & 0xff;
        payload.set(new TextEncoder().encode(reason), 2);
        try {
          socket.write(Buffer.from(encodeWsFrame(OP_CLOSE, payload)));
          socket.end();
        } catch { /* socket already gone */ }
      },
    };

    // ── Incremental frame parser ──
    let buf: Buffer = Buffer.alloc(0) as Buffer;
    let fragOp = -1;
    const frags: Buffer[] = [];

    const finishMessage = (op: number, payload: Buffer) => {
      if (payload.byteLength > MAX_MESSAGE_SIZE) { conn.close(1009, "message too large"); return; }
      if (op === OP_TEXT) base.deliver(conn, payload.toString("utf8"));
      else base.deliver(conn, new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
    };

    const handleFrame = (fin: boolean, op: number, payload: Buffer) => {
      if (op === OP_CLOSE) {
        const code = payload.byteLength >= 2 ? payload.readUInt16BE(0) : 1000;
        const reason = payload.byteLength > 2 ? payload.subarray(2).toString("utf8") : "";
        conn.close(code, reason);
        base.drop(conn, code, reason);
        return;
      }
      if (op === OP_PING) { if (!closed && !socket.destroyed) socket.write(Buffer.from(encodeWsFrame(OP_PONG, payload))); return; }
      if (op === OP_PONG) return;
      if (op === OP_CONT && fragOp < 0) { conn.close(1002, "unexpected continuation"); return; }
      if ((op === OP_TEXT || op === OP_BIN) && fragOp >= 0) { conn.close(1002, "interleaved frame"); return; }

      if (op !== OP_CONT) fragOp = op;
      frags.push(payload);
      if (!fin) return;
      const full = Buffer.concat(frags);
      frags.length = 0;
      const finalOp = fragOp;
      fragOp = -1;
      finishMessage(finalOp, full);
    };

    socket.on("data", (chunk: Buffer) => {
      buf = buf.byteLength ? Buffer.concat([buf, chunk]) : chunk;
      // Parse as many complete frames as the buffer holds.
      for (;;) {
        if (buf.byteLength < 2) return;
        const b0 = buf[0], b1 = buf[1];
        const fin = (b0 & 0x80) !== 0;
        const op = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.byteLength < off + 2) return;
          len = buf.readUInt16BE(off); off += 2;
        } else if (len === 127) {
          if (buf.byteLength < off + 8) return;
          const hi = buf.readUInt32BE(off), lo = buf.readUInt32BE(off + 4); off += 8;
          if (hi > 0 || lo > MAX_MESSAGE_SIZE) { conn.close(1009, "message too large"); return; }
          len = lo;
        }
        const maskLen = masked ? 4 : 0;
        if (buf.byteLength < off + maskLen + len) return;
        let payload = buf.subarray(off + maskLen, off + maskLen + len);
        if (masked) {
          const mask = buf.subarray(off, off + 4);
          const unmasked = Buffer.allocUnsafe(payload.byteLength);
          for (let i = 0; i < payload.byteLength; i++) unmasked[i] = payload[i] ^ mask[i & 3];
          payload = unmasked;
        } else {
          payload = Buffer.from(payload); // detach — subarray aliases buf
        }
        buf = buf.subarray(off + maskLen + len);
        handleFrame(fin, op, payload);
        if (closed) return;
      }
    });

    const onSocketEnd = () => base.drop(conn, 1006, "socket closed");
    socket.on("close", onSocketEnd);
    socket.on("error", onSocketEnd);

    base.conns.add(conn);
    try { opts.onConnection?.(conn); } catch (e) { log.error("WsServer", `onConnection threw: ${e}`); }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.host ?? "0.0.0.0", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const addr = httpServer.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : opts.port;

  return {
    port: boundPort,
    host: opts.host ?? "0.0.0.0",
    connections: () => [...base.conns],
    async close() {
      [...base.conns].forEach((c) => c.close(1001, "server shutdown"));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      // httpServer.close waits for open sockets; force-destroy stragglers.
      [...base.conns].forEach((c) => (c.raw as import("node:net").Socket).destroy());
      base.conns.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Start a WebSocket server. Resolves once the socket is bound and listening.
 * Runtime is picked by capability: Bun.serve → Deno.serve → node:http.
 */
export function createWebSocketServer(opts: WebSocketServerOptions): Promise<WsServer> {
  const g = globalThis as Record<string, unknown>;
  const bun = g.Bun as { serve?: unknown } | undefined;
  if (typeof bun?.serve === "function") return startBunServer(opts);
  const deno = g.Deno as { serve?: unknown; upgradeWebSocket?: unknown } | undefined;
  if (typeof deno?.serve === "function" && typeof deno.upgradeWebSocket === "function") {
    return startDenoServer(opts);
  }
  return startNodeServer(opts);
}
