import type { NetMessage, NetTransport } from "./transport.ts";

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

  constructor(transport: NetTransport, isServer: boolean) {
    this.transport = transport;
    this.isServer = isServer;
    this.transport.onMessage((msg) => {
      if (msg.type === 2) {
        this.handleMessage(msg);
      }
    });
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
    if (!def) return;
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
    const dv = new DataView(msg.data.buffer, msg.data.byteOffset);
    const rpcId = dv.getUint32(0);
    const handler = this.handlers.get(rpcId);
    if (handler) {
      const result = handler(msg.data.slice(4));
      if (result && this.isServer) {
        this.transport.send({
          type: 2,
          data: result,
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

  dispose(): void {
    this.handlers.clear();
    this.definitions.clear();
  }
}
