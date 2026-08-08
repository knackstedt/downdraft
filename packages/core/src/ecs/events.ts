export interface EventChannel<T> {
  send(event: T): void;
  read(): T[];
  swap(): void;
  clear(): void;
  isDirty(): boolean;
}

export function createEventChannel<T>(): EventChannel<T> {
  let current: T[] = [];
  let pending: T[] = [];
  let dirty = false;
  const MAX_QUEUE_SIZE = 10000;
  let droppedCount = 0;

  return {
    send(event: T): void {
      if (pending.length >= MAX_QUEUE_SIZE) {
        // Drop the oldest event to make room for the newest.
        pending.shift();
        droppedCount++;
        if (droppedCount === 1 || droppedCount % 1000 === 0) {
          console.warn(
            `EventChannel: queue full (${MAX_QUEUE_SIZE}), dropped ${droppedCount} oldest event(s) total`,
          );
        }
      }
      pending.push(event);
      dirty = true;
    },
    read(): T[] {
      const result = current;
      current = [];
      return result;
    },
    swap(): void {
      const tmp = current;
      current = pending;
      pending = tmp;
      pending.length = 0;
      dirty = false;
    },
    clear(): void {
      current.length = 0;
      pending.length = 0;
      dirty = false;
    },
    isDirty(): boolean { return dirty; },
  };
}

export class EventBus {
  private channels: Map<string, EventChannel<unknown>> = new Map();

  get<T>(name: string): EventChannel<T> {
    let ch = this.channels.get(name);
    if (!ch) {
      ch = createEventChannel<T>();
      this.channels.set(name, ch);
    }
    return ch as EventChannel<T>;
  }

  channel<T>(name: string): EventChannel<T> {
    return this.get<T>(name);
  }

  send<T>(name: string, event: T): void {
    this.get<T>(name).send(event);
  }

  read<T>(name: string): T[] {
    return this.get<T>(name).read() as T[];
  }

  swapAll(): void {
    // Only swap channels that received events this frame (lazy swap)
    for (const ch of this.channels.values()) {
      if (ch.isDirty()) ch.swap();
    }
  }

  clearAll(): void {
    for (const ch of this.channels.values()) {
      ch.clear();
    }
  }
}
