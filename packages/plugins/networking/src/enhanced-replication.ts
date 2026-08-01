import type { ReplicatedComponent, ReplicatedField, ReplicationSnapshot } from "./replication.ts";

export interface DeltaSnapshot {
  tick: number;
  baseTick: number;
  entities: Array<{
    entityId: number;
    changedComponents: Array<{
      componentId: number;
      fieldMask: Uint8Array;
      data: Uint8Array;
    }>;
  }>;
}

export interface InterestArea {
  centerX: number;
  centerY: number;
  centerZ: number;
  radius: number;
}

export interface EntityPosition {
  entityId: number;
  x: number;
  y: number;
  z: number;
}

export class DeltaEncoder {
  private previousData: Map<number, Map<number, Uint8Array>> = new Map();
  private previousTick: number = 0;

  encodeDelta(snapshot: ReplicationSnapshot, componentDefs: Map<number, ReplicatedComponent>): DeltaSnapshot {
    const entities: DeltaSnapshot["entities"] = [];

    for (const entity of snapshot.entities) {
      const prevEntity = this.previousData.get(entity.entityId);
      const changedComponents: DeltaSnapshot["entities"][0]["changedComponents"] = [];

      for (const comp of entity.components) {
        const compDef = componentDefs.get(comp.componentId);
        if (!compDef) continue;

        const prevComp = prevEntity?.get(comp.componentId);
        const fieldMask = new Uint8Array(Math.ceil(compDef.fields.length / 8));
        const changedFields: Uint8Array[] = [];
        let anyChanged = false;

        if (!prevComp) {
          for (let i = 0; i < compDef.fields.length; i++) {
            fieldMask[Math.floor(i / 8)] |= (1 << (i % 8));
            anyChanged = true;
          }
          changedFields.push(comp.data);
        } else {
          const fieldSize = this.getFieldSizes(compDef.fields);
          let dataOffset = 0;
          for (let i = 0; i < compDef.fields.length; i++) {
            const size = fieldSize[i];
            const oldSlice = prevComp.slice(dataOffset, dataOffset + size);
            const newSlice = comp.data.slice(dataOffset, dataOffset + size);
            let changed = false;
            for (let b = 0; b < size; b++) {
              if (oldSlice[b] !== newSlice[b]) { changed = true; break; }
            }
            if (changed) {
              fieldMask[Math.floor(i / 8)] |= (1 << (i % 8));
              changedFields.push(newSlice);
              anyChanged = true;
            }
            dataOffset += size;
          }
        }

        if (anyChanged) {
          const totalSize = changedFields.reduce((s, f) => s + f.length, 0);
          const merged = new Uint8Array(totalSize);
          let off = 0;
          for (const f of changedFields) {
            merged.set(f, off);
            off += f.length;
          }
          changedComponents.push({ componentId: comp.componentId, fieldMask, data: merged });
        }
      }

      if (changedComponents.length > 0) {
        entities.push({ entityId: entity.entityId, changedComponents });
      }
    }

    const delta: DeltaSnapshot = {
      tick: snapshot.tick,
      baseTick: this.previousTick,
      entities,
    };

    for (const entity of snapshot.entities) {
      if (!this.previousData.has(entity.entityId)) {
        this.previousData.set(entity.entityId, new Map());
      }
      for (const comp of entity.components) {
        this.previousData.get(entity.entityId)!.set(comp.componentId, comp.data);
      }
    }
    this.previousTick = snapshot.tick;

    return delta;
  }

  reset(): void {
    this.previousData.clear();
    this.previousTick = 0;
  }

  private fieldSizesCache: Map<string, number> = new Map();

  private getFieldSizes(fields: ReplicatedField[]): number[] {
    return fields.map((f) => this.getFieldSize(f.type));
  }

  private getFieldSize(type: ReplicatedField["type"]): number {
    const cached = this.fieldSizesCache.get(type);
    if (cached !== undefined) return cached;
    const size = (() => {
      switch (type) {
        case "float32": return 4;
        case "float64": return 8;
        case "uint8": return 1;
        case "uint16": return 2;
        case "uint32": return 4;
        case "int8": return 1;
        case "int16": return 2;
        case "int32": return 4;
        case "boolean": return 1;
        default: return 0;
      }
    })();
    this.fieldSizesCache.set(type, size);
    return size;
  }
}

export class DeltaDecoder {
  private baseData: Map<number, Map<number, Uint8Array>> = new Map();

  decodeDelta(delta: DeltaSnapshot, componentDefs: Map<number, ReplicatedComponent>): ReplicationSnapshot {
    const entities: ReplicationSnapshot["entities"] = [];

    for (const entity of delta.entities) {
      const components: ReplicationSnapshot["entities"][0]["components"] = [];

      for (const comp of entity.changedComponents) {
        const compDef = componentDefs.get(comp.componentId);
        if (!compDef) continue;

        const baseComp = this.baseData.get(entity.entityId)?.get(comp.componentId);
        const fieldSizes = compDef.fields.map((f) => this.getFieldSize(f.type));
        const totalSize = fieldSizes.reduce((s, v) => s + v, 0);

        const reconstructed = new Uint8Array(totalSize);

        if (baseComp) {
          let baseOffset = 0;
          for (let i = 0; i < fieldSizes.length; i++) {
            const size = fieldSizes[i];
            if (comp.fieldMask[Math.floor(i / 8)] & (1 << (i % 8))) {
              // Field is in delta data — will be filled below
            } else {
              reconstructed.set(baseComp.slice(baseOffset, baseOffset + size), baseOffset);
            }
            baseOffset += size;
          }
        }

        let deltaOffset = 0;
        let baseOffset = 0;
        for (let i = 0; i < fieldSizes.length; i++) {
          const size = fieldSizes[i];
          if (comp.fieldMask[Math.floor(i / 8)] & (1 << (i % 8))) {
            reconstructed.set(comp.data.slice(deltaOffset, deltaOffset + size), baseOffset);
            deltaOffset += size;
          }
          baseOffset += size;
        }

        components.push({ componentId: comp.componentId, data: reconstructed });

        if (!this.baseData.has(entity.entityId)) {
          this.baseData.set(entity.entityId, new Map());
        }
        this.baseData.get(entity.entityId)!.set(comp.componentId, reconstructed);
      }

      if (components.length > 0) {
        entities.push({ entityId: entity.entityId, components });
      }
    }

    return { tick: delta.tick, entities };
  }

  private fieldSizesCache: Map<string, number> = new Map();

  private getFieldSize(type: ReplicatedField["type"]): number {
    const cached = this.fieldSizesCache.get(type);
    if (cached !== undefined) return cached;
    const size = (() => {
      switch (type) {
        case "float32": return 4;
        case "float64": return 8;
        case "uint8": return 1;
        case "uint16": return 2;
        case "uint32": return 4;
        case "int8": return 1;
        case "int16": return 2;
        case "int32": return 4;
        case "boolean": return 1;
        default: return 0;
      }
    })();
    this.fieldSizesCache.set(type, size);
    return size;
  }
}

export class InterestManager {
  private areas: Map<string, InterestArea> = new Map();
  private entityPositions: Map<number, EntityPosition> = new Map();

  setArea(peerId: string, area: InterestArea): void {
    this.areas.set(peerId, area);
  }

  removeArea(peerId: string): void {
    this.areas.delete(peerId);
  }

  updateEntityPosition(entityId: number, x: number, y: number, z: number): void {
    this.entityPositions.set(entityId, { entityId, x, y, z });
  }

  removeEntity(entityId: number): void {
    this.entityPositions.delete(entityId);
  }

  getRelevantEntities(peerId: string): number[] {
    const area = this.areas.get(peerId);
    if (!area) return [...this.entityPositions.keys()];

    const relevant: number[] = [];
    const radiusSq = area.radius * area.radius;
    for (const [entityId, pos] of this.entityPositions) {
      const dx = pos.x - area.centerX;
      const dy = pos.y - area.centerY;
      const dz = pos.z - area.centerZ;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq <= radiusSq) {
        relevant.push(entityId);
      }
    }
    return relevant;
  }

  filterSnapshot(snapshot: ReplicationSnapshot, peerId: string): ReplicationSnapshot {
    const relevant = new Set(this.getRelevantEntities(peerId));
    return {
      tick: snapshot.tick,
      entities: snapshot.entities.filter((e) => relevant.has(e.entityId)),
    };
  }
}

export interface InterpolationBuffer {
  tick: number;
  data: Map<number, Map<number, Record<string, unknown>>>;
  timestamp: number;
}

export class InterpolationManager {
  private buffer: InterpolationBuffer[] = [];
  private maxBufferSize: number = 4;
  private renderTime: number = 0;
  private interpolationDelay: number = 0.1;

  setInterpolationDelay(delay: number): void {
    this.interpolationDelay = delay;
  }

  addSnapshot(tick: number, data: Map<number, Map<number, Record<string, unknown>>>, timestamp: number): void {
    this.buffer.push({ tick, data, timestamp });
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift();
    }
  }

  update(renderTime: number): void {
    this.renderTime = renderTime;
  }

  getInterpolatedState(
    entityId: number,
    componentId: number,
    fieldName: string,
  ): unknown | null {
    if (this.buffer.length < 2) {
      const latest = this.buffer[this.buffer.length - 1];
      return latest?.data.get(entityId)?.get(componentId)?.[fieldName] ?? null;
    }

    const targetTime = this.renderTime - this.interpolationDelay;

    let prev: InterpolationBuffer | null = null;
    let next: InterpolationBuffer | null = null;

    for (let i = 0; i < this.buffer.length - 1; i++) {
      if (this.buffer[i].timestamp <= targetTime && this.buffer[i + 1].timestamp >= targetTime) {
        prev = this.buffer[i];
        next = this.buffer[i + 1];
        break;
      }
    }

    if (!prev || !next) {
      const latest = this.buffer[this.buffer.length - 1];
      return latest?.data.get(entityId)?.get(componentId)?.[fieldName] ?? null;
    }

    const prevVal = prev.data.get(entityId)?.get(componentId)?.[fieldName];
    const nextVal = next.data.get(entityId)?.get(componentId)?.[fieldName];

    if (prevVal === undefined || nextVal === undefined) return null;
    if (typeof prevVal !== "number" || typeof nextVal !== "number") return nextVal;

    const timeRange = next.timestamp - prev.timestamp;
    if (timeRange === 0) return nextVal;
    const alpha = (targetTime - prev.timestamp) / timeRange;
    return prevVal + (nextVal - prevVal) * Math.max(0, Math.min(1, alpha));
  }

  getBufferSize(): number {
    return this.buffer.length;
  }

  clear(): void {
    this.buffer = [];
  }
}
