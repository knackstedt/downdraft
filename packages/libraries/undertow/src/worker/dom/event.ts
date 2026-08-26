// ============================================================================
// WorkerEvent — worker-side event object. Constructed by the event-pump from
// an EventRecord decoded from the event ring. Carries the decoded payload
// (clientX, clientY, key, etc.) as plain properties.
// ============================================================================

import type { WorkerRuntime } from "../runtime";

export interface WorkerEventInit {
  type: string;
  targetHandle: number;
  payload: Record<string, unknown>;
}

/** Injected by the event pump to avoid a circular dependency on sync-dom. */
let _getSyncElement: ((handle: number, rt: WorkerRuntime) => any) | null = null;
export function setSyncElementResolver(fn: (handle: number, rt: WorkerRuntime) => any): void {
  _getSyncElement = fn;
}

export class WorkerEvent {
  readonly type: string;
  readonly targetHandle: number;
  readonly payload: Record<string, unknown>;
  /** The actual element that was clicked/interacted with (for React delegation). */
  target: any = null;
  /** The element the listener was registered on (currentTarget during bubble). */
  currentTarget: any = null;
  /** The worker runtime, set by the event pump for composedPath resolution. */
  rt: WorkerRuntime | null = null;

  constructor(init: WorkerEventInit) {
    this.type = init.type;
    this.targetHandle = init.targetHandle;
    this.payload = init.payload;
    // If the payload includes a target handle, construct a target element
    const th = this.payload._targetHandle as number;
    if (th && th > 0) {
      this.targetHandle = th;
    }
  }

  // Common event property accessors (read from payload)
  get clientX(): number { return (this.payload.clientX as number) ?? 0; }
  get clientY(): number { return (this.payload.clientY as number) ?? 0; }
  get key(): string { return (this.payload.key as string) ?? ""; }
  get code(): string { return (this.payload.code as string) ?? ""; }
  get keyCode(): number { return (this.payload.keyCode as number) ?? 0; }
  get repeat(): boolean { return (this.payload.repeat as boolean) ?? false; }
  get shiftKey(): boolean { return (this.payload.shiftKey as boolean) ?? false; }
  get ctrlKey(): boolean { return (this.payload.ctrlKey as boolean) ?? false; }
  get altKey(): boolean { return (this.payload.altKey as boolean) ?? false; }
  get metaKey(): boolean { return (this.payload.metaKey as boolean) ?? false; }
  get deltaY(): number { return (this.payload.deltaY as number) ?? 0; }
  get button(): number { return (this.payload.button as number) ?? 0; }
  get bubbles(): boolean { return (this.payload.bubbles as boolean) ?? false; }
  get cancelable(): boolean { return (this.payload.cancelable as boolean) ?? false; }

  preventDefault(): void {
    // Phase 4 will wire this back to the main thread via an op if needed.
    // For now, events are fire-and-forget.
  }

  stopPropagation(): void {
    // Same as above.
  }

  /** Returns the full ancestor chain from target to document. The path is
   *  pre-collected on the main thread in the EventDispatcher and included in
   *  the event payload, so this is zero-cost (no sync SAB calls). Solid's
   *  eventHandler uses composedPath() to walk the tree and find delegated
   *  handlers — without this, each parentNode access would be a blocking SAB
   *  round-trip, making clicks extremely laggy. */
  composedPath(): any[] {
    const handles = this.payload._composedPath as number[] | undefined;
    if (!handles || handles.length === 0 || !_getSyncElement || !this.rt) {
      return this.target ? [this.target] : [];
    }
    // Map handles to cached SyncElements. getSyncElement is a cache lookup —
    // no SAB call. Handle 0 means the node has no undertow handle (e.g. the
    // real document); skip it.
    return handles.filter((h) => h > 0).map((h) => _getSyncElement!(h, this.rt!));
  }

  /** React 18 may check isTrusted. Synthetic events from the event ring are
   *  "trusted" in the sense that they originate from real DOM events on the
   *  main thread. Return true so React processes them like real events. */
  get isTrusted(): boolean { return true; }

  /** React 18 may check defaultPrevented. */
  get defaultPrevented(): boolean { return false; }

  /** React 18 may access type/composedPath. Ensure eventPhase is defined. */
  get eventPhase(): number { return 2; /* AT_TARGET */ }

  /** React 18 may check timeStamp. */
  get timeStamp(): number { return 0; }
}
