// ============================================================================
// EventPump — worker-side event dispatcher. Drains the event ring each tick
// and dispatches to registered callbacks. The WorkerRuntime owns the event
// ring; the pump reads from it.
//
// Listener registration: the worker DOM classes call addEventListener which
// sends OP_ADD_EVENT_LISTENER to the main thread. The main thread registers
// a real DOM listener. When the real event fires, the main-side
// EventDispatcher writes an EventRecord into the event ring. The pump drains
// it and calls the worker-side callback.
// ============================================================================

import type { EventRing } from "../sab/event-ring";
import type { StringPool } from "../sab/string-pool";
import { decodePayload } from "../shared/payload-codec";
import { EVENT_HANDLE_OFF, EVENT_PAYLOADLEN_OFF, EVENT_PAYLOADOFF_OFF, EVENT_TYPEATOM_OFF } from "../shared/protocol";
import { setSyncElementResolver, WorkerEvent } from "./dom/event";
import type { WorkerRuntime } from "./runtime";
import { getSyncElement } from "./sync-dom";

// Inject the sync element resolver so WorkerEvent.composedPath() can map
// handles to cached SyncElements without a circular dependency.
setSyncElementResolver(getSyncElement);

/** Interface the runtime exposes to the pump (breaks the circular import). */
export interface EventPumpRuntime {
  sab: SharedArrayBuffer;
  eventRing: EventRing;
  pool: StringPool;
  document: any;
}

export type EventListener = (event: WorkerEvent) => void;

export class EventPump {
  /** Map: handle → Map<type, Set<listener>> */
  private readonly listeners: Map<number, Map<string, Set<EventListener>>> = new Map();
  private readonly rt: EventPumpRuntime;

  constructor(rt: EventPumpRuntime) {
    this.rt = rt;
  }

  /** Register a worker-side listener. Called by WorkerElement.addEventListener. */
  add(handle: number, type: string, listener: EventListener): void {
    let byType = this.listeners.get(handle);
    if (!byType) {
      byType = new Map();
      this.listeners.set(handle, byType);
    }
    let set = byType.get(type);
    if (!set) {
      set = new Set();
      byType.set(type, set);
    }
    set.add(listener);
  }

  /** Remove a worker-side listener. */
  remove(handle: number, type: string, listener: EventListener): void {
    const byType = this.listeners.get(handle);
    if (!byType) return;
    const set = byType.get(type);
    if (!set) return;
    set.delete(listener);
  }

  /** Drain all pending events from the event ring and dispatch. Call each raf. */
  drain(): void {
    // Collect all pending events first, release their slots, THEN dispatch.
    // This prevents ring corruption if a listener triggers callSync → drain()
    // re-entrantly (the re-entrancy guard in runtime.ts prevents this, but
    // collecting first is also safer for the ring state).
    const events: Array<{ handle: number; type: string; event: WorkerEvent }> = [];
    let slot = this.rt.eventRing.tryPop();
    while (slot !== null) {
      const u32 = this.rt.eventRing.slotU32(slot);
      const handle = u32[EVENT_HANDLE_OFF / 4];
      const typeAtom = u32[EVENT_TYPEATOM_OFF / 4];
      const payloadOff = u32[EVENT_PAYLOADOFF_OFF / 4];
      const payloadLen = u32[EVENT_PAYLOADLEN_OFF / 4];

      const type = this.rt.pool.resolve(typeAtom) ?? "unknown";

      // Skip pointerlockchange — handled by direct postMessage from the main
      // thread (undertow-host.ts). The event ring delivery has timing issues
      // that cause stale state and incorrect pause menu toggling.
      if (type === "pointerlockchange") {
        this.rt.eventRing.release(slot);
        slot = this.rt.eventRing.tryPop();
        continue;
      }

      let payload: Record<string, unknown> = {};
      if (payloadLen > 0) {
        const bytes = new Uint8Array(this.rt.sab, payloadOff, payloadLen);
        const decoded = decodePayload(bytes);
        if (decoded && typeof decoded === "object" && !Array.isArray(decoded) && !(decoded instanceof Uint8Array)) {
          payload = decoded as Record<string, unknown>;
        }
      }

      const event = new WorkerEvent({ type, targetHandle: handle, payload });
      event.rt = this.rt as unknown as WorkerRuntime;
      const targetHandle = (payload._targetHandle as number) ?? handle;
      event.target = getSyncElement(targetHandle > 0 ? targetHandle : handle, this.rt as unknown as WorkerRuntime);

      events.push({ handle, type, event });

      this.rt.eventRing.release(slot);
      slot = this.rt.eventRing.tryPop();
    }

    // Now dispatch all collected events
    for (const { handle, type, event } of events) {
      this.dispatch(handle, type, event);
    }
  }

  private dispatch(handle: number, type: string, event: WorkerEvent): void {
    const byType = this.listeners.get(handle);
    if (!byType) return;
    const set = byType.get(type);
    if (!set) return;
    // Set currentTarget to the node the listener was registered on.
    // Solid's eventHandler captures e.currentTarget as oriCurrentTarget and
    // uses it to know when to stop walking the composed path
    // (node.parentNode === oriCurrentTarget → break). Without this, the loop
    // never breaks and walks past the document, or breaks too early.
    event.currentTarget = this.rt.document;
    for (const listener of set) {
      try {
        listener(event);
      } catch (e) {
        console.error(`[worker-dom] Event listener error for "${type}":`, e);
      }
    }
  }
}
