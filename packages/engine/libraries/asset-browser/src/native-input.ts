// ============================================================================
// native-input.ts — forward native (SDL) surface events into a PixiJS v8
// EventSystem. Extracted from andrews-sandbox's native-ui-setup.ts so any
// game hosting an in-process pixi scene on NativePixiUiHost gets the same
// input routing: DOM-shaped synthetic events dispatched through pixi's
// internal handlers (hit-testing, click, drag, hover).
//
// The host app decides *when* to route (e.g. only while an overlay is open)
// and how events arrive (surface listeners, RendererInputBus, MCP) — this
// class only performs the translation + dispatch.
// ============================================================================

/** Minimal host surface — satisfied by NativePixiUiHost. */
export interface PixiInputHost {
  renderer: any;
  canvas: any;
  app: { stage: any };
}

const HANDLERS: Record<string, string> = {
  pointerdown: "_onPointerDown",
  pointermove: "_onPointerMove",
  pointerup: "_onPointerUp",
  pointerover: "_onPointerOverOut",
  pointerleave: "_onPointerOverOut",
  wheel: "onWheel",
};

export function eventModifiers(e: any): number {
  return (e?.shiftKey ? 1 : 0) | (e?.ctrlKey ? 2 : 0) | (e?.altKey ? 4 : 0) | (e?.metaKey ? 8 : 0);
}

export class PixiEventForwarder {
  private host: PixiInputHost;

  constructor(host: PixiInputHost) {
    this.host = host;
  }

  /** PixiJS EventSystem hit-test — is an eventMode display object under (x, y)? */
  hitTest(x: number, y: number): boolean {
    const events = this.host.renderer?.events;
    const rootBoundary = events?.rootBoundary;
    if (!rootBoundary?.hitTest || !rootBoundary.rootTarget) return false;
    try { return !!rootBoundary.hitTest(x, y); } catch { return false; }
  }

  /**
   * Dispatch a synthetic pointer/wheel event through pixi's EventSystem.
   * `type` is one of the HANDLERS keys. `x`/`y` are CSS-pixel canvas coords.
   */
  dispatch(type: string, x: number, y: number, button: number, modifiers: number, extras?: Record<string, unknown>): void {
    const eventSystem = this.host.renderer?.events;
    if (!eventSystem) return;
    const domElement = eventSystem.domElement ?? this.host.canvas;
    const resolution = this.host.renderer?.resolution ?? 1;
    // Scale CSS-pixel coords to backing-store px (mapPositionToPoint divides
    // by resolution, so this cancels out).
    const px = x * resolution;
    const py = y * resolution;
    // _onPointerDown sets rootBoundary.rootTarget = renderer.lastObjectRendered.
    // Our render is manual so the getter can lag; seed the backing field and
    // rootTarget from the stage so the first click can hit-test.
    const r = this.host.renderer as any;
    const stage = this.host.app.stage;
    if (r.lastObjectRendered !== stage) r._lastObjectRendered = stage;
    const rb = eventSystem.rootBoundary;
    if (rb && !rb.rootTarget) rb.rootTarget = stage;
    const syntheticEvent = {
      type,
      pointerId: 1,
      pointerType: "mouse",
      clientX: px,
      clientY: py,
      button,
      buttons: type === "pointerdown" ? (button === 0 ? 1 : button === 2 ? 2 : 4) : 0,
      shiftKey: (modifiers & 1) !== 0,
      ctrlKey: (modifiers & 2) !== 0,
      altKey: (modifiers & 4) !== 0,
      metaKey: (modifiers & 8) !== 0,
      preventDefault: () => {},
      stopPropagation: () => {},
      nativeEvent: null,
      isTrusted: true,
      offsetX: px,
      offsetY: py,
      pageX: px,
      pageY: py,
      target: domElement,
      composedPath: () => [domElement],
      cancelable: true,
      isPrimary: true,
      width: 1,
      height: 1,
      tiltX: 0,
      tiltY: 0,
      pressure: 0.5,
      twist: 0,
      tangentialPressure: 0,
      ...extras,
    };
    const handler = eventSystem[HANDLERS[type] ?? type] as ((e: any) => void) | undefined;
    if (typeof handler === "function") {
      try { handler.call(eventSystem, syntheticEvent); } catch { /* ignore */ }
    }
  }
}
