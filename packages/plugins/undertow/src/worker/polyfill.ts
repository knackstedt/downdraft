// ============================================================================
// polyfill — installs a DOM environment in the worker using undertow.
//
// This module sets up global `document`, `window`, `Node`, `Element`, `Text`,
// `Comment`, `DocumentFragment`, `Event`, `CustomEvent`, `MouseEvent`, etc.
// so that Solid (or any DOM library) can run in the worker.
//
// The polyfill creates WorkerDocument / WorkerWindow instances and patches
// the wrapNode function so that node handles are wrapped in the correct
// subclass (WorkerElement for element nodes, WorkerText for text nodes, etc.)
// based on a cached node type.
// ============================================================================

import * as ids from "../shared/op-ids";
import { HANDLE_DOCUMENT } from "../shared/protocol";
import { WorkerDocument } from "./dom/document";
import { COMMENT_NODE, DOCUMENT_FRAGMENT_NODE, DOCUMENT_NODE, ELEMENT_NODE, TEXT_NODE } from "./dom/node";
import { WorkerWindow } from "./dom/window";
import type { WorkerRuntime } from "./runtime";
import { SyncComment, SyncDocument, SyncElement, SyncNode, SyncText, SyncWindow, wrapSyncNode } from "./sync-dom";

// Re-export wrapSyncNode for use by the DOM classes
export { wrapSyncNode as wrapNode };

/**
 * Install the DOM polyfill in the worker's global scope.
 * Call this once at worker startup, before loading Solid (or any DOM library).
 */
export function installPolyfill(rt: WorkerRuntime): { document: WorkerDocument; window: WorkerWindow } {
  const document = new SyncDocument(rt);
  const window = new SyncWindow(rt);

  // Store on runtime so sync DOM classes can access ownerDocument/defaultView
  rt.document = document;
  rt.window = window;

  // Install globals
  const g = globalThis as any;
  g.document = document;
  g.window = window;
  // self and globalThis are read-only in workers — skip assignment
  try { g.self = window; } catch { /* read-only */ }
  try { g.globalThis = g; } catch { /* read-only */ }

  // Node constructors (for instanceof checks) — use sync classes
  g.Node = SyncNode;
  g.Element = SyncElement;
  g.HTMLElement = SyncElement; // simplified
  g.Text = SyncText;
  g.Comment = SyncComment;
  g.DocumentFragment = SyncNode;
  g.Document = SyncDocument;
  g.Window = SyncWindow;
  g.Event = WorkerEventPolyfill;
  g.CustomEvent = WorkerEventPolyfill;
  g.MouseEvent = WorkerEventPolyfill;
  g.KeyboardEvent = WorkerEventPolyfill;
  g.PointerEvent = WorkerEventPolyfill;
  g.WheelEvent = WorkerEventPolyfill;
  g.InputEvent = WorkerEventPolyfill;

  // HTML element constructors — DOM libraries do `instanceof` checks against
  // these. All map to SyncElement since we don't distinguish element subtypes.
  const htmlTags = [
    "HTMLDivElement", "HTMLSpanElement", "HTMLAnchorElement", "HTMLImageElement",
    "HTMLInputElement", "HTMLButtonElement", "HTMLFormElement", "HTMLSelectElement",
    "HTMLTextAreaElement", "HTMLLabelElement", "HTMLHeadingElement", "HTMLParagraphElement",
    "HTMLUListElement", "HTMLOListElement", "HTMLLIElement", "HTMLTableElement",
    "HTMLTableRowElement", "HTMLTableCellElement", "HTMLTableSectionElement",
    "HTMLCanvasElement", "HTMLVideoElement", "HTMLAudioElement", "HTMLIFrameElement",
    "HTMLScriptElement", "HTMLLinkElement", "HTMLMetaElement", "HTMLStyleElement",
    "HTMLBodyElement", "HTMLHeadElement", "HTMLHtmlElement", "HTMLBRElement",
    "HTMLHRElement", "HTMLPreElement", "HTMLBlockquoteElement", "HTMLDListElement",
    "HTMLFieldSetElement", "HTMLOptGroupElement", "HTMLOptionElement", "HTMLOutputElement",
    "HTMLProgressElement", "HTMLMeterElement", "HTMLDataListElement", "HTMLPictureElement",
    "HTMLSourceElement", "HTMLTrackElement", "HTMLMapElement", "HTMLAreaElement",
    "HTMLDialogElement", "HTMLDetailsElement", "HTMLSummaryElement", "HTMLMenuElement",
    "HTMLSlotElement", "HTMLTemplateElement", "HTMLDataElement", "HTMLTimeElement",
    "HTMLWbrElement", "HTMLUnknownElement",
  ];
  for (const tag of htmlTags) {
    g[tag] = SyncElement;
  }

  // Also set HTML constructors on the window object — DOM libraries access
  // `window.HTMLIFrameElement` etc. for instanceof checks.
  const w = window as any;
  for (const tag of htmlTags) {
    w[tag] = SyncElement;
  }
  w.Node = SyncNode;
  w.Element = SyncElement;
  w.HTMLElement = SyncElement;
  w.Text = SyncText;
  w.Comment = SyncComment;
  w.Document = SyncDocument;
  w.DocumentFragment = SyncNode;
  w.Event = WorkerEventPolyfill;
  w.CustomEvent = WorkerEventPolyfill;
  w.MouseEvent = WorkerEventPolyfill;
  w.KeyboardEvent = WorkerEventPolyfill;
  w.PointerEvent = WorkerEventPolyfill;
  w.WheelEvent = WorkerEventPolyfill;
  w.InputEvent = WorkerEventPolyfill;

  // Node constants
  g.Node.ELEMENT_NODE = ELEMENT_NODE;
  g.Node.TEXT_NODE = TEXT_NODE;
  g.Node.COMMENT_NODE = COMMENT_NODE;
  g.Node.DOCUMENT_NODE = DOCUMENT_NODE;
  g.Node.DOCUMENT_FRAGMENT_NODE = DOCUMENT_FRAGMENT_NODE;

  // DocumentFragment — already aliased to SyncNode above, no prototype reassignment
  // needed (class .prototype is read-only in strict mode).

  // Document properties that game code accesses but aren't proxied via ops.
  // These are stubs — pointer lock and focus management happen on the main thread.
  // pointerLockElement is dynamic: it reflects the synced pointerLocked state
  // from the main thread (set via the store bridge).
  const doc = document as any;
  let _pointerLocked = false;
  Object.defineProperty(doc, "pointerLockElement", {
    get: () => (_pointerLocked ? doc.body : null),
    configurable: true,
  });
  // Called by the store bridge when pointerLocked changes.
  // Does NOT dispatch pointerlockchange — the main thread handles that event
  // and the store sync updates pointerLocked here. Dispatching it in the worker
  // would cause App's onPointerLockChange to re-trigger pause menu logic,
  // double-toggling menus.
  doc._setPointerLocked = (v: boolean) => { _pointerLocked = v; };
  // Proxy exitPointerLock to the main thread via a synchronous op call.
  // The worker's game code (e.g. App's keydown handler) calls this to release
  // pointer lock so the main thread's pointerlockchange handler can open menus.
  // A no-op stub here meant pointer lock was never released from the worker,
  // breaking Tab/I/M/B menu toggling.
  doc.exitPointerLock = () => {
    rt.callSync(ids.OP_DOCUMENT_EXIT_POINTER_LOCK, HANDLE_DOCUMENT, []);
  };
  // requestPointerLock must be called within a user gesture on the main thread.
  // The worker cannot satisfy that, so this is a no-op — pointer lock is
  // acquired via the main thread's onUserGesture callback (undertow-host.ts).
  if (typeof doc.requestPointerLock !== "function") doc.requestPointerLock = () => {};
  if (typeof doc.activeElement === "undefined") {
    Object.defineProperty(doc, "activeElement", {
      get: () => doc.body || null,
      configurable: true,
    });
  }
  if (typeof doc.fullscreenElement === "undefined") doc.fullscreenElement = null;
  if (typeof doc.exitFullscreen !== "function") doc.exitFullscreen = () => {};
  if (typeof doc.requestFullscreen !== "function") doc.requestFullscreen = () => {};
  if (typeof doc.hasFocus !== "function") doc.hasFocus = () => true;

  // requestAnimationFrame / cancelAnimationFrame
  g.requestAnimationFrame = (cb: (time: number) => void) => rt.requestAnimationFrame(cb);
  g.cancelAnimationFrame = (id: number) => rt.cancelAnimationFrame(id);

  // setTimeout / clearTimeout — use the worker's native ones (already available)
  // setInterval / clearInterval — same

  // performance — use the worker's native performance (already available)

  // location — minimal stub (workers have a limited location object)
  if (!g.location) {
    g.location = { href: "about:blank", origin: "", protocol: "about:", host: "", hostname: "", port: "", pathname: "/", search: "", hash: "" };
  }
  // location.reload / location.replace — not available in workers, stub them
  if (typeof g.location.reload !== "function") g.location.reload = () => {};
  if (typeof g.location.replace !== "function") g.location.replace = () => {};

  // navigator — minimal stub
  if (!g.navigator) {
    g.navigator = { userAgent: "undertow-worker", platform: "", language: "en" };
  }

  // CSS — stub for styled-components etc.
  if (!g.CSS) {
    g.CSS = { supports: () => true, escape: (s: string) => s };
  }

  // MutationObserver — stub (React doesn't use it, but some libs do)
  if (!g.MutationObserver) {
    g.MutationObserver = class {
      observe() {}
      disconnect() {}
      takeRecords() { return []; }
    };
  }

  // ResizeObserver — stub
  if (!g.ResizeObserver) {
    g.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  // IntersectionObserver — stub
  if (!g.IntersectionObserver) {
    g.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    };
  }

  return { document, window } as unknown as { document: WorkerDocument; window: WorkerWindow };
}

/**
 * Minimal Event polyfill. DOM libraries create Event objects for synthetic
 * events. In the worker, events arrive via the event pump as WorkerEvent
 * instances. This constructor allows code to create new events for
 * dispatchEvent.
 */
export class WorkerEventPolyfill {
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly target: any = null;
  readonly currentTarget: any = null;
  readonly defaultPrevented: boolean = false;
  readonly isTrusted: boolean = false;
  readonly timeStamp: number;
  readonly eventPhase: number = 0;
  readonly composed: boolean = false;

  constructor(type: string, init: { bubbles?: boolean; cancelable?: boolean; composed?: boolean } = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? false;
    this.cancelable = init.cancelable ?? false;
    this.composed = init.composed ?? false;
    this.timeStamp = typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  preventDefault(): void { (this as any).defaultPrevented = true; }
  stopPropagation(): void {}
  stopImmediatePropagation(): void {}
  composedPath(): any[] { return []; }
  initEvent(type: string, bubbles?: boolean, cancelable?: boolean): void {
    (this as any).type = type;
    (this as any).bubbles = bubbles ?? false;
    (this as any).cancelable = cancelable ?? false;
  }
}
