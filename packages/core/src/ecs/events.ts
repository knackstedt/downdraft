export interface EventChannel<T> {
  send(event: T): void;
  read(): T[];
  swap(): void;
  clear(): void;
}

export function createEventChannel<T>(): EventChannel<T> {
  let current: T[] = [];
  let pending: T[] = [];

  return {
    send(event: T): void {
      pending.push(event);
    },
    read(): T[] {
      return current;
    },
    swap(): void {
      const tmp = current;
      current = pending;
      pending = tmp;
      pending.length = 0;
    },
    clear(): void {
      current.length = 0;
      pending.length = 0;
    },
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

  send<T>(name: string, event: T): void {
    this.get<T>(name).send(event);
  }

  read<T>(name: string): T[] {
    return this.get<T>(name).read() as T[];
  }

  swapAll(): void {
    for (const ch of this.channels.values()) {
      ch.swap();
    }
  }

  clearAll(): void {
    for (const ch of this.channels.values()) {
      ch.clear();
    }
  }
}
