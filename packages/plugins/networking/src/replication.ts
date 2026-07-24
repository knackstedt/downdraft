import type { NetMessage, NetTransport } from "./transport.ts";
import { RPCManager } from "./rpc.ts";

export type ReplicationMode = "authoritative" | "client-prediction" | "interpolated";

export interface ReplicatedField {
  name: string;
  type: "float32" | "float64" | "uint8" | "uint16" | "uint32" | "int8" | "int16" | "int32" | "boolean";
  precision?: number;
  interpolate?: boolean;
}

export interface ReplicatedComponent {
  componentId: number;
  fields: ReplicatedField[];
  mode: ReplicationMode;
}

export interface ReplicationConfig {
  tickRate: number;
  maxEntitiesPerPacket: 64;
  components: Map<number, ReplicatedComponent>;
}

export interface ReplicationSnapshot {
  tick: number;
  entities: Array<{
    entityId: number;
    components: Array<{
      componentId: number;
      data: Uint8Array;
    }>;
  }>;
}

export class ReplicationManager {
  private transport: NetTransport;
  private config: ReplicationConfig;
  private snapshots: Map<number, ReplicationSnapshot> = new Map();
  private lastTick = 0;
  private tickAccumulator = 0;
  private isServer: boolean;
  private entityComponents: Map<number, Map<number, Record<string, unknown>>> = new Map();
  rpc: RPCManager;

  constructor(transport: NetTransport, isServer: boolean, config?: Partial<ReplicationConfig>) {
    this.transport = transport;
    this.isServer = isServer;
    this.config = {
      tickRate: config?.tickRate ?? 20,
      maxEntitiesPerPacket: config?.maxEntitiesPerPacket ?? 64,
      components: config?.components ?? new Map(),
    };

    this.rpc = new RPCManager(transport, isServer);
    this.transport.onMessage((msg) => this.handleMessage(msg));
  }

  registerComponent(componentId: number, fields: ReplicatedField[], mode: ReplicationMode = "authoritative"): void {
    this.config.components.set(componentId, { componentId, fields, mode });
  }

  trackEntity(entityId: number): void {
    this.entityComponents.set(entityId, new Map());
  }

  untrackEntity(entityId: number): void {
    this.entityComponents.delete(entityId);
  }

  updateEntityComponent(entityId: number, componentId: number, data: Record<string, unknown>): void {
    let entityMap = this.entityComponents.get(entityId);
    if (!entityMap) {
      entityMap = new Map();
      this.entityComponents.set(entityId, entityMap);
    }
    entityMap.set(componentId, data);
  }

  update(dt: number): void {
    if (!this.isServer) return;

    this.tickAccumulator += dt;
    const tickInterval = 1 / this.config.tickRate;

    if (this.tickAccumulator >= tickInterval) {
      this.tickAccumulator -= tickInterval;
      this.lastTick++;
      this.sendSnapshot();
    }
  }

  private sendSnapshot(): void {
    const entities: ReplicationSnapshot["entities"] = [];
    let count = 0;

    for (const [entityId, components] of this.entityComponents) {
      if (count >= this.config.maxEntitiesPerPacket) break;

      const componentData: Array<{ componentId: number; data: Uint8Array }> = [];
      for (const [componentId, data] of components) {
        const replComp = this.config.components.get(componentId);
        if (!replComp) continue;
        const serialized = this.serializeComponent(data, replComp.fields);
        componentData.push({ componentId, data: serialized });
      }

      if (componentData.length > 0) {
        entities.push({ entityId, components: componentData });
        count++;
      }
    }

    if (entities.length === 0) return;

    const snapshot: ReplicationSnapshot = {
      tick: this.lastTick,
      entities,
    };

    const data = this.serializeSnapshot(snapshot);
    this.transport.send({
      type: 1, // SNAPSHOT
      data,
      reliable: false,
      ordered: false,
      channel: 0,
    });
  }

  private handleMessage(msg: NetMessage): void {
    if (msg.type === 1) {
      // SNAPSHOT
      if (this.isServer) return;
      const snapshot = this.deserializeSnapshot(msg.data);
      this.snapshots.set(snapshot.tick, snapshot);
      this.applySnapshot(snapshot);
    }
    // RPC messages (type 2) are handled by RPCManager directly
  }

  private applySnapshot(snapshot: ReplicationSnapshot): void {
    for (const entity of snapshot.entities) {
      let entityMap = this.entityComponents.get(entity.entityId);
      if (!entityMap) {
        entityMap = new Map();
        this.entityComponents.set(entity.entityId, entityMap);
      }
      for (const comp of entity.components) {
        const replComp = this.config.components.get(comp.componentId);
        if (!replComp) continue;
        const data = this.deserializeComponent(comp.data, replComp.fields);
        entityMap.set(comp.componentId, data);
      }
    }
  }

  getEntityData(entityId: number, componentId: number): Record<string, unknown> | undefined {
    return this.entityComponents.get(entityId)?.get(componentId);
  }

  private serializeComponent(data: Record<string, unknown>, fields: ReplicatedField[]): Uint8Array {
    const buffers: Uint8Array[] = [];
    for (const field of fields) {
      const value = data[field.name];
      if (value === undefined) continue;
      const buf = this.serializeField(value, field.type, field.precision);
      buffers.push(buf);
    }
    const total = buffers.reduce((sum, b) => sum + b.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const buf of buffers) {
      result.set(buf, offset);
      offset += buf.length;
    }
    return result;
  }

  private deserializeComponent(data: Uint8Array, fields: ReplicatedField[]): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    let offset = 0;
    for (const field of fields) {
      const { value, size } = this.deserializeField(data, offset, field.type);
      result[field.name] = value;
      offset += size;
    }
    return result;
  }

  private serializeField(value: unknown, type: ReplicatedField["type"], precision?: number): Uint8Array {
    switch (type) {
      case "float32": {
        const buf = new ArrayBuffer(4);
        new DataView(buf).setFloat32(0, value as number);
        return new Uint8Array(buf);
      }
      case "float64": {
        const buf = new ArrayBuffer(8);
        new DataView(buf).setFloat64(0, value as number);
        return new Uint8Array(buf);
      }
      case "uint8": return new Uint8Array([value as number]);
      case "uint16": {
        const buf = new ArrayBuffer(2);
        new DataView(buf).setUint16(0, value as number);
        return new Uint8Array(buf);
      }
      case "uint32": {
        const buf = new ArrayBuffer(4);
        new DataView(buf).setUint32(0, value as number);
        return new Uint8Array(buf);
      }
      case "int8": {
        const buf = new ArrayBuffer(1);
        new DataView(buf).setInt8(0, value as number);
        return new Uint8Array(buf);
      }
      case "int16": {
        const buf = new ArrayBuffer(2);
        new DataView(buf).setInt16(0, value as number);
        return new Uint8Array(buf);
      }
      case "int32": {
        const buf = new ArrayBuffer(4);
        new DataView(buf).setInt32(0, value as number);
        return new Uint8Array(buf);
      }
      case "boolean": return new Uint8Array([value ? 1 : 0]);
      default: return new Uint8Array(0);
    }
  }

  private deserializeField(data: Uint8Array, offset: number, type: ReplicatedField["type"]): { value: unknown; size: number } {
    const dv = new DataView(data.buffer, data.byteOffset + offset);
    switch (type) {
      case "float32": return { value: dv.getFloat32(0), size: 4 };
      case "float64": return { value: dv.getFloat64(0), size: 8 };
      case "uint8": return { value: data[offset], size: 1 };
      case "uint16": return { value: dv.getUint16(0), size: 2 };
      case "uint32": return { value: dv.getUint32(0), size: 4 };
      case "int8": return { value: dv.getInt8(0), size: 1 };
      case "int16": return { value: dv.getInt16(0), size: 2 };
      case "int32": return { value: dv.getInt32(0), size: 4 };
      case "boolean": return { value: data[offset] !== 0, size: 1 };
      default: return { value: null, size: 0 };
    }
  }

  private serializeSnapshot(snapshot: ReplicationSnapshot): Uint8Array {
    const parts: Uint8Array[] = [];
    const tickBuf = new ArrayBuffer(4);
    new DataView(tickBuf).setUint32(0, snapshot.tick);
    parts.push(new Uint8Array(tickBuf));

    const countBuf = new ArrayBuffer(2);
    new DataView(countBuf).setUint16(0, snapshot.entities.length);
    parts.push(new Uint8Array(countBuf));

    for (const entity of snapshot.entities) {
      const idBuf = new ArrayBuffer(4);
      new DataView(idBuf).setUint32(0, entity.entityId);
      parts.push(new Uint8Array(idBuf));

      const compCountBuf = new ArrayBuffer(2);
      new DataView(compCountBuf).setUint16(0, entity.components.length);
      parts.push(new Uint8Array(compCountBuf));

      for (const comp of entity.components) {
        const compIdBuf = new ArrayBuffer(4);
        new DataView(compIdBuf).setUint32(0, comp.componentId);
        parts.push(new Uint8Array(compIdBuf));

        const lenBuf = new ArrayBuffer(2);
        new DataView(lenBuf).setUint16(0, comp.data.length);
        parts.push(new Uint8Array(lenBuf));

        parts.push(comp.data);
      }
    }

    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }

  private deserializeSnapshot(data: Uint8Array): ReplicationSnapshot {
    const dv = new DataView(data.buffer, data.byteOffset);
    let offset = 0;
    const tick = dv.getUint32(offset); offset += 4;
    const entityCount = dv.getUint16(offset); offset += 2;

    const entities: ReplicationSnapshot["entities"] = [];
    for (let i = 0; i < entityCount; i++) {
      const entityId = dv.getUint32(offset); offset += 4;
      const compCount = dv.getUint16(offset); offset += 2;

      const components: Array<{ componentId: number; data: Uint8Array }> = [];
      for (let j = 0; j < compCount; j++) {
        const componentId = dv.getUint32(offset); offset += 4;
        const len = dv.getUint16(offset); offset += 2;
        const compData = data.slice(offset, offset + len);
        offset += len;
        components.push({ componentId, data: compData });
      }
      entities.push({ entityId, components });
    }

    return { tick, entities };
  }

  getTickRate(): number { return this.config.tickRate; }
  getRTT(): number { return this.transport.getRTT(); }
  getPacketLoss(): number { return this.transport.getPacketLoss(); }
}
