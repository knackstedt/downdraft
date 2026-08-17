// ============================================================================
// EventDispatcher — main-side bridge between real DOM events and the worker's
// event ring. When the worker calls addEventListener (OP_ADD_EVENT_LISTENER),
// the host calls EventDispatcher.add() which registers a real DOM listener on
// the target node. When the real event fires, the dispatcher encodes the event
// payload and writes an EventRecord into the event ring via the host.
// ============================================================================

import type { StringPool } from "../sab/string-pool";
import type { ArgValue } from "../shared/op-table";
import { encodePayload } from "../shared/payload-codec";
import type { HandleTable } from "./handle-table";

/** Interface the host exposes to the dispatcher (breaks the circular import). */
export interface EventDispatcherHost {
  handleTable: HandleTable;
  stringPool: StringPool;
  enqueueEvent(handle: number, typeAtom: number, payloadBytes: Uint8Array): boolean;
}

// Event types we support and the properties we extract into the payload.
const EVENT_PAYLOAD_EXTRACTORS: Record<string, (e: Event) => Record<string, unknown>> = {
  click: (e) => ({ clientX: (e as MouseEvent).clientX, clientY: (e as MouseEvent).clientY, button: (e as MouseEvent).button, bubbles: e.bubbles, cancelable: e.cancelable }),
  mousedown: (e) => ({ clientX: (e as MouseEvent).clientX, clientY: (e as MouseEvent).clientY, button: (e as MouseEvent).button }),
  mouseup: (e) => ({ clientX: (e as MouseEvent).clientX, clientY: (e as MouseEvent).clientY, button: (e as MouseEvent).button }),
  mousemove: (e) => ({ clientX: (e as MouseEvent).clientX, clientY: (e as MouseEvent).clientY }),
  pointerdown: (e) => ({ clientX: (e as PointerEvent).clientX, clientY: (e as PointerEvent).clientY, pointerId: (e as PointerEvent).pointerId }),
  pointermove: (e) => ({ clientX: (e as PointerEvent).clientX, clientY: (e as PointerEvent).clientY, pointerId: (e as PointerEvent).pointerId }),
  pointerup: (e) => ({ clientX: (e as PointerEvent).clientX, clientY: (e as PointerEvent).clientY, pointerId: (e as PointerEvent).pointerId }),
  pointerlockchange: () => ({ pointerLockElement: document.pointerLockElement ? 1 : 0 }),
  keydown: (e) => ({ key: (e as KeyboardEvent).key, keyCode: (e as KeyboardEvent).keyCode, code: (e as KeyboardEvent).code, repeat: (e as KeyboardEvent).repeat, shiftKey: (e as KeyboardEvent).shiftKey, ctrlKey: (e as KeyboardEvent).ctrlKey, altKey: (e as KeyboardEvent).altKey, metaKey: (e as KeyboardEvent).metaKey }),
  keyup: (e) => ({ key: (e as KeyboardEvent).key, keyCode: (e as KeyboardEvent).keyCode, code: (e as KeyboardEvent).code, repeat: (e as KeyboardEvent).repeat, shiftKey: (e as KeyboardEvent).shiftKey, ctrlKey: (e as KeyboardEvent).ctrlKey, altKey: (e as KeyboardEvent).altKey, metaKey: (e as KeyboardEvent).metaKey }),
  input: () => ({}),
  change: () => ({}),
  submit: (e) => ({ bubbles: e.bubbles, cancelable: e.cancelable }),
  wheel: (e) => ({ deltaY: (e as WheelEvent).deltaY, deltaX: (e as WheelEvent).deltaX, clientX: (e as WheelEvent).clientX, clientY: (e as WheelEvent).clientY }),
  scroll: () => ({}),
  resize: () => ({}),
  focus: () => ({}),
  blur: () => ({}),
};

// High-frequency events that should be coalesced — only the latest event is kept.
// These fire at 60-360Hz and would flood the event ring + block the worker with
// sync calls. We coalesce by storing the latest event and flushing on rAF.
const COALESCE_TYPES = new Set(["mousemove", "pointermove", "wheel", "scroll", "resize"]);

export class EventDispatcher {
  private readonly host: EventDispatcherHost;
  /** Map: handle → Map<type, realListener> */
  private readonly realListeners: Map<number, Map<string, EventListener>> = new Map();
  /**
   * Optional callback invoked on click events within the browser's user gesture
   * context. Use this for actions that require a user gesture (e.g.
   * requestPointerLock) — the worker round-trip would lose the gesture context.
   */
  onUserGesture: ((e: Event) => void) | null = null;

  // Coalescing: for high-frequency events (mousemove, pointermove, wheel, etc.),
  // we store the latest event per (handle, type) and flush once per rAF.
  // This prevents flooding the event ring and blocking the worker with sync calls.
  private readonly pendingCoalesced: Map<string, { handle: number; type: string; payload: Record<string, unknown> }> = new Map();
  private coalesceFlushScheduled = false;

  constructor(host: EventDispatcherHost) {
    this.host = host;
  }

  /** Flush all pending coalesced events. Called on rAF by the host. */
  flushCoalesced(): void {
    this.coalesceFlushScheduled = false;
    if (this.pendingCoalesced.size === 0) return;
    for (const [, entry] of this.pendingCoalesced) {
      const payloadBytes = encodePayload(entry.payload as ArgValue);
      const typeAtom = this.host.stringPool.intern(entry.type);
      this.host.enqueueEvent(entry.handle, typeAtom, payloadBytes);
    }
    this.pendingCoalesced.clear();
  }

  /** Register a real DOM listener for (handle, type). Called by the host on OP_ADD_EVENT_LISTENER. */
  add(handle: number, type: string): void {
    const node = this.host.handleTable.resolve(handle);
    if (!node) return;

    let byType = this.realListeners.get(handle);
    if (!byType) {
      byType = new Map();
      this.realListeners.set(handle, byType);
    }
    if (byType.has(type)) return; // already registered

    const coalesce = COALESCE_TYPES.has(type);

    const realListener = (e: Event) => {
      const extractor = EVENT_PAYLOAD_EXTRACTORS[type];
      const payload = extractor ? extractor(e) : {};
      // Include the target element's handle so the worker can construct
      // a proper event.target for React's event delegation.
      const target = e.target as any;
      const targetHandle = target?._undertowHandle ?? 0;
      payload._targetHandle = targetHandle;
      // Call the user-gesture callback for click events — this runs within
      // the browser's user gesture context, so it can call requestPointerLock()
      // which requires a user gesture. The worker round-trip would lose this context.
      if (type === "click" && this.onUserGesture) {
        try {
          this.onUserGesture(e);
        } catch (ge) {
          console.error("[event-dispatcher] onUserGesture threw:", ge);
        }
      }

      if (coalesce) {
        // Store the latest event for this (handle, type) — only one will be sent per rAF.
        const key = `${handle}:${type}`;
        this.pendingCoalesced.set(key, { handle, type, payload });
        if (!this.coalesceFlushScheduled) {
          this.coalesceFlushScheduled = true;
          requestAnimationFrame(() => this.flushCoalesced());
        }
      } else {
        const payloadBytes = encodePayload(payload as ArgValue);
        const typeAtom = this.host.stringPool.intern(type);
        const ok = this.host.enqueueEvent(handle, typeAtom, payloadBytes);
        if (!ok) console.log(`[event-dispatcher] enqueueEvent DROPPED: handle=${handle} type=${type}`);
      }
    };

    byType.set(type, realListener as EventListener);
    (node as EventTarget).addEventListener(type, realListener as EventListener);
  }

  /** Remove a real DOM listener. Called by the host on OP_REMOVE_EVENT_LISTENER. */
  remove(handle: number, type: string): void {
    const byType = this.realListeners.get(handle);
    if (!byType) return;
    const realListener = byType.get(type);
    if (!realListener) return;
    const node = this.host.handleTable.resolve(handle);
    if (node) {
      (node as EventTarget).removeEventListener(type, realListener);
    }
    byType.delete(type);
  }
}
