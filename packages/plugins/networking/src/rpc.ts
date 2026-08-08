import type { NetMessage, NetTransport } from "./transport";

export type RPCHandler = (args: Uint8Array) => Uint8Array | null;

export interface RPCDefinition {
  id: number;
  name: string;
  reliable: boolean;
}

export class RPCManager {
  private transport: NetTransport;
  private handlers: Map<number, RPCHandler> = new Map();
  private definitions: Map<string, RPCDefinition> = new Map();
  private nextId = 1;
  private isServer: boolean;
  private authToken?: string;
  private authenticated = false;
  private callTimestamps: Map<string, number[]> = new Map();
  private static readonly RATE_LIMIT_MAX_CALLS = 100;
  private static readonly RATE_LIMIT_WINDOW_MS = 1000;

  constructor(transport: NetTransport, isServer: boolean, authToken?: string) {
    this.transport = transport;
    this.isServer = isServer;
    this.authToken = authToken;
    if (!authToken) this.authenticated = true;
    this.transport.onMessage((msg) => {
      if (msg.type === 2) {
        this.handleMessage(msg);
      }
    });
  }

  setAuthToken(token: string): void {
    this.authToken = token;
    this.authenticated = false;
  }

  register(name: string, handler: RPCHandler, reliable: boolean = true): number {
    const id = this.nextId++;
    const def: RPCDefinition = { id, name, reliable };
    this.definitions.set(name, def);
    this.handlers.set(id, handler);
    return id;
  }

  unregister(name: string): void {
    const def = this.definitions.get(name);
    if (def) {
      this.handlers.delete(def.id);
      this.definitions.delete(name);
    }
  }

  call(name: string, args: Uint8Array): void {
    const def = this.definitions.get(name);
    if (def) {
      const buf = new Uint8Array(4 + args.length);
      const dv = new DataView(buf.buffer);
      dv.setUint32(0, def.id);
      buf.set(args, 4);
      this.transport.send({
        type: 2,
        data: buf,
        reliable: def.reliable,
        ordered: true,
        channel: 1,
      });
    } else {
      const nameBytes = new TextEncoder().encode(name);
      const buf = new Uint8Array(4 + 2 + nameBytes.length + args.length);
      const dv = new DataView(buf.buffer);
      dv.setUint32(0, 0);
      dv.setUint16(4, nameBytes.length);
      buf.set(nameBytes, 6);
      buf.set(args, 6 + nameBytes.length);
      this.transport.send({
        type: 2,
        data: buf,
        reliable: true,
        ordered: true,
        channel: 1,
      });
    }
  }

  callById(rpcId: number, args: Uint8Array, reliable: boolean = true): void {
    const buf = new Uint8Array(4 + args.length);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, rpcId);
    buf.set(args, 4);
    this.transport.send({
      type: 2,
      data: buf,
      reliable,
      ordered: true,
      channel: 1,
    });
  }

  private handleMessage(msg: NetMessage): void {
    if (msg.data.length < 4) return;

    // Optional authentication: the first message from a peer must match the token.
    if (this.authToken && !this.authenticated) {
      const tokenText = new TextDecoder().decode(msg.data);
      if (tokenText === this.authToken) {
        this.authenticated = true;
        return;
      }
      // reject the connection on auth failure
      this.transport.disconnect();
      return;
    }

    const dv = new DataView(msg.data.buffer, msg.data.byteOffset);
    const rpcId = dv.getUint32(0);
    let handler: RPCHandler | undefined;
    let args: Uint8Array;
    let handlerName: string;
    if (rpcId === 0) {
      if (msg.data.length < 6) return;
      const nameLen = dv.getUint16(4);
      if (msg.data.length < 6 + nameLen) return;
      const name = new TextDecoder().decode(msg.data.slice(6, 6 + nameLen));
      const def = this.definitions.get(name);
      handler = def ? this.handlers.get(def.id) : undefined;
      args = msg.data.slice(6 + nameLen);
      handlerName = name;
    } else {
      handler = this.handlers.get(rpcId);
      args = msg.data.slice(4);
      handlerName = String(rpcId);
    }
    if (handler) {
      if (!this.checkRateLimit(handlerName)) return;
      const result = handler(args);
      if (result && this.isServer) {
        const respBuf = new Uint8Array(4 + result.length);
        const respDv = new DataView(respBuf.buffer);
        respDv.setUint32(0, rpcId);
        respBuf.set(result, 4);
        this.transport.send({
          type: 2,
          data: respBuf,
          reliable: true,
          ordered: true,
          channel: 1,
        });
      }
    }
  }

  getDefinition(name: string): RPCDefinition | undefined {
    return this.definitions.get(name);
  }

  getHandler(rpcId: number): RPCHandler | undefined {
    return this.handlers.get(rpcId);
  }

  private checkRateLimit(handlerName: string): boolean {
    const now = performance.now();
    const windowMs = RPCManager.RATE_LIMIT_WINDOW_MS;
    const timestamps = this.callTimestamps.get(handlerName) ?? [];
    const cutoff = now - windowMs;
    // prune entries older than 1 second
    let firstValid = 0;
    while (firstValid < timestamps.length && timestamps[firstValid] < cutoff) {
      firstValid++;
    }
    const recent = firstValid > 0 ? timestamps.slice(firstValid) : timestamps;
    if (recent.length >= RPCManager.RATE_LIMIT_MAX_CALLS) {
      this.callTimestamps.set(handlerName, recent);
      return false;
    }
    recent.push(now);
    this.callTimestamps.set(handlerName, recent);
    return true;
  }

  dispose(): void {
    this.handlers.clear();
    this.definitions.clear();
    this.callTimestamps.clear();
  }
}
