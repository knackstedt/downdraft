// ============================================================================
// RendererInputBus — host-owned DOM input surface for renderer plugins
//
// Owns pointer/wheel/key listeners on the canvas (+ window for keys/blur) and
// dispatches to subscribers in priority order (lower number = earlier). A
// handler may call `ctrl.stopPropagation()` to block later subscribers — used
// by tools like the transform gizmo to capture a drag and block the camera
// controller from also rotating.
//
// This is a *parallel* drag-orbit-shaped layer alongside the existing
// `InputManager` (which is pointer-lock/FPS-shaped). Both can coexist on the
// same canvas: `InputManager`'s `click`→`requestPointerLock` only fires when
// the pointer is unlocked, and the bus never requests pointer lock.
// ============================================================================

import type {
  DragDelta,
  DragHandler,
  InputEventControl,
  KeyHandler,
  PointerHandler,
  RendererInputBus,
  WheelHandler,
} from "../module/renderer-module";

interface Subscription<H> {
  handler: H;
  priority: number;
  // Insertion-order tiebreaker so equal-priority subscribers dispatch in the
  // order they were added (stable sort).
  seq: number;
}

const DEFAULT_PRIORITY = 100;

export class RendererInputBusImpl implements RendererInputBus {
  private canvas: HTMLCanvasElement;
  private listeners: Array<{ target: EventTarget; event: string; handler: EventListener }> = [];

  private pointerDownSubs: Subscription<PointerHandler>[] = [];
  private pointerMoveSubs: Subscription<PointerHandler>[] = [];
  private pointerUpSubs: Subscription<PointerHandler>[] = [];
  private wheelSubs: Subscription<WheelHandler>[] = [];
  private keyDownSubs: Subscription<KeyHandler>[] = [];
  private keyUpSubs: Subscription<KeyHandler>[] = [];
  private dragSubs: Subscription<DragHandler>[] = [];

  // Drag tracking state — shared across all onDrag subscribers so a single
  // pointerdown/move/up drives every drag handler with consistent deltas.
  private dragActive = false;
  private dragLastX = 0;
  private dragLastY = 0;
  private dragButtons = 0;
  private dragShift = false;
  private dragSeq = 0; // increments per subscription for stable ordering

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.setupListeners();
  }

  // ── Subscription API ──

  onPointerDown(handler: PointerHandler, priority: number = DEFAULT_PRIORITY): () => void {
    return this.addSub(this.pointerDownSubs, handler, priority);
  }

  onPointerMove(handler: PointerHandler, priority: number = DEFAULT_PRIORITY): () => void {
    return this.addSub(this.pointerMoveSubs, handler, priority);
  }

  onPointerUp(handler: PointerHandler, priority: number = DEFAULT_PRIORITY): () => void {
    return this.addSub(this.pointerUpSubs, handler, priority);
  }

  onWheel(handler: WheelHandler, priority: number = DEFAULT_PRIORITY): () => void {
    return this.addSub(this.wheelSubs, handler, priority);
  }

  onKeyDown(handler: KeyHandler, priority: number = DEFAULT_PRIORITY): () => void {
    return this.addSub(this.keyDownSubs, handler, priority);
  }

  onKeyUp(handler: KeyHandler, priority: number = DEFAULT_PRIORITY): () => void {
    return this.addSub(this.keyUpSubs, handler, priority);
  }

  onDrag(handler: DragHandler, priority: number = DEFAULT_PRIORITY): () => void {
    return this.addSub(this.dragSubs, handler, priority);
  }

  // ── Lifecycle ──

  destroy(): void {
    this.listeners.forEach(({ target, event, handler }) => {
      target.removeEventListener(event, handler);
    });
    this.listeners = [];
    this.pointerDownSubs = [];
    this.pointerMoveSubs = [];
    this.pointerUpSubs = [];
    this.wheelSubs = [];
    this.keyDownSubs = [];
    this.keyUpSubs = [];
    this.dragSubs = [];
  }

  // ── Internals ──

  private addSub<H>(arr: Subscription<H>[], handler: H, priority: number): () => void {
    const sub: Subscription<H> = { handler, priority, seq: this.dragSeq++ };
    arr.push(sub);
    // Stable sort by (priority, seq).
    arr.sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.seq - b.seq));
    return () => {
      const idx = arr.indexOf(sub);
      if (idx >= 0) arr.splice(idx, 1);
    };
  }

  private setupListeners(): void {
    const add = (target: EventTarget, event: string, handler: EventListener) => {
      target.addEventListener(event, handler);
      this.listeners.push({ target, event, handler });
    };

    add(this.canvas, "pointerdown", ((e: PointerEvent) => {
      this.dragActive = true;
      this.dragLastX = e.clientX;
      this.dragLastY = e.clientY;
      this.dragButtons = e.buttons;
      this.dragShift = e.shiftKey;
      this.dispatchPointer(this.pointerDownSubs, e);
    }) as EventListener);

    add(this.canvas, "pointermove", ((e: PointerEvent) => {
      // Emit drag deltas first (if a button is held) so onDrag subscribers see
      // the move before any onPointerMove handler decides to stopPropagation.
      if (this.dragActive && this.dragSubs.length > 0) {
        const dx = e.clientX - this.dragLastX;
        const dy = e.clientY - this.dragLastY;
        this.dragLastX = e.clientX;
        this.dragLastY = e.clientY;
        this.dragButtons = e.buttons;
        this.dragShift = e.shiftKey;
        const delta: DragDelta = { dx, dy, buttons: this.dragButtons, shift: this.dragShift };
        this.dispatchDrag(this.dragSubs, delta);
      }
      this.dispatchPointer(this.pointerMoveSubs, e);
    }) as EventListener);

    // pointerup on window so a drag ends even if the pointer leaves the canvas.
    add(window, "pointerup", ((e: PointerEvent) => {
      if (this.dragActive) {
        this.dragActive = false;
        this.dragButtons = 0;
      }
      this.dispatchPointer(this.pointerUpSubs, e);
    }) as EventListener);

    add(this.canvas, "wheel", ((e: WheelEvent) => {
      this.dispatchWheel(this.wheelSubs, e);
    }) as EventListener);

    add(window, "keydown", ((e: KeyboardEvent) => {
      this.dispatchKey(this.keyDownSubs, e);
    }) as EventListener);

    add(window, "keyup", ((e: KeyboardEvent) => {
      this.dispatchKey(this.keyUpSubs, e);
    }) as EventListener);

    // Cancel any in-flight drag on blur (e.g. alt-tab while dragging).
    add(window, "blur", (() => {
      this.dragActive = false;
      this.dragButtons = 0;
    }) as EventListener);
  }

  private makeControl(): InputEventControl {
    let stopped = false;
    return {
      stopPropagation: () => { stopped = true; },
      get propagationStopped() { return stopped; },
    };
  }

  private dispatchPointer(subs: Subscription<PointerHandler>[], e: PointerEvent): void {
    const ctrl = this.makeControl();
    for (let i = 0; i < subs.length; i++) {
      subs[i].handler(e, ctrl);
      if (ctrl.propagationStopped) break;
    }
  }

  private dispatchWheel(subs: Subscription<WheelHandler>[], e: WheelEvent): void {
    const ctrl = this.makeControl();
    for (let i = 0; i < subs.length; i++) {
      subs[i].handler(e, ctrl);
      if (ctrl.propagationStopped) break;
    }
  }

  private dispatchKey(subs: Subscription<KeyHandler>[], e: KeyboardEvent): void {
    const ctrl = this.makeControl();
    for (let i = 0; i < subs.length; i++) {
      subs[i].handler(e, ctrl);
      if (ctrl.propagationStopped) break;
    }
  }

  private dispatchDrag(subs: Subscription<DragHandler>[], d: DragDelta): void {
    const ctrl = this.makeControl();
    for (let i = 0; i < subs.length; i++) {
      subs[i].handler(d, ctrl);
      if (ctrl.propagationStopped) break;
    }
  }
}
