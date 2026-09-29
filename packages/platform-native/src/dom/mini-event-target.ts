// ============================================================================
// mini-event-target.ts — minimal EventTarget-compatible listener store
//
// Shared by NativeSurface, VirtualCanvas, NativeWindow, and the document
// polyfill — all of which previously carried their own copy of the
// Map<string, Set<listener>> + add/remove/dispatch pattern.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger("info");

export type EventListener = (event: any) => void;

export class MiniEventTarget {
  private listeners: Map<string, Set<EventListener>> = new Map();
  private captureListeners: Map<string, Set<EventListener>> = new Map();

  // Capture listeners run before regular listeners. There is no inter-
  // element propagation, but capture ordering lets overlays (UI routers,
  // debugger) consume input before the game's handlers see it.
  addEventListener(type: string, listener: EventListener, options?: boolean | { capture?: boolean }): void {
    const capture = options === true || (typeof options === "object" && options?.capture === true);
    const map = capture ? this.captureListeners : this.listeners;
    if (!map.has(type)) map.set(type, new Set());
    map.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: EventListener, options?: boolean | { capture?: boolean }): void {
    const capture = options === true || (typeof options === "object" && options?.capture === true);
    (capture ? this.captureListeners : this.listeners).get(type)?.delete(listener);
  }

  dispatchEvent(event: any): boolean {
    const set = this.listeners.get(event.type);
    const cap = this.captureListeners.get(event.type);
    if (set || cap) {
      // Give the event real propagation controls. Since every listener is
      // same-target, stopPropagation is treated like stopImmediatePropagation
      // (the only meaningful effect). The flag persists on the event object,
      // so a stop on the surface suppresses the follow-up window dispatch
      // (DOM bubble semantics).
      if (event && typeof event === "object" && event.__miniStop === undefined) {
        event.__miniStop = false;
        const origStop = event.stopPropagation?.bind(event);
        event.stopPropagation = () => { event.__miniStop = true; origStop?.(); };
        const origImm = event.stopImmediatePropagation?.bind(event);
        event.stopImmediatePropagation = () => { event.__miniStop = true; origImm?.(); };
      }
      // DOM parity for plain-object events: `target` is the first dispatching
      // element (persists through the surface→window hop), `currentTarget` is
      // the element whose listeners are running. Handlers that gate on
      // `e.target === canvas` (e.g. InputManager's wheel path) depend on this.
      if (event && typeof event === "object") {
        if (event.target === undefined) { try { event.target = this; } catch {} }
        try { event.currentTarget = this; } catch {}
      }
      if (cap) {
        for (const listener of cap.values()) {
          if (event?.__miniStop) break;
          try { listener(event); } catch (e) { log.error("MiniEventTarget", `"${event.type}" capture listener error: ${e}`); }
        }
      }
      if (set) {
        for (const listener of set.values()) {
          if (event?.__miniStop) break;
          try { listener(event); } catch (e) { log.error("MiniEventTarget", `"${event.type}" listener error: ${e}`); }
        }
      }
    }
    return true;
  }

  /** Direct access to a type's listener set (document polyfill pointerlockchange). */
  getListeners(type: string): Set<EventListener> | undefined {
    return this.listeners.get(type);
  }

  clearListeners(): void {
    this.listeners.clear();
    this.captureListeners.clear();
  }
}
