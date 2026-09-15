// ============================================================================
// mini-event-target.ts — minimal EventTarget-compatible listener store
//
// Shared by NativeSurface, VirtualCanvas, NativeWindow, and the document
// polyfill — all of which previously carried their own copy of the
// Map<string, Set<listener>> + add/remove/dispatch pattern.
// ============================================================================

export type EventListener = (event: any) => void;

export class MiniEventTarget {
  private listeners: Map<string, Set<EventListener>> = new Map();

  // `options`/`capture` accepted for DOM signature parity — native events have
  // no capture/bubble phases, so the flag is ignored.
  addEventListener(type: string, listener: EventListener, _options?: boolean | { capture?: boolean }): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: EventListener, _options?: boolean | { capture?: boolean }): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: any): boolean {
    const set = this.listeners.get(event.type);
    if (set) {
      for (const listener of set) {
        try { listener(event); } catch (e) { console.error(`[MiniEventTarget] "${event.type}" listener error:`, e); }
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
  }
}
