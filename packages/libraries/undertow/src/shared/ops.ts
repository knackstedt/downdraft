// ============================================================================
// ops — registers the initial op entries into the op-table.
//
// Phase 2 registers the core 6 ops needed for a round-trip:
//   document.createElement, appendChild, setAttribute, getTextContent,
//   setTextContent, release
//
// Phase 3 appends the rest of the worker-dom subset. Each registration is a
// single registerOp() call — adding an API is one entry.
// ============================================================================

import * as ids from "./op-ids";
import {
    boolResult,
    errorResult,
    f64Result,
    handleResult,
    i32Result,
    registerOp,
    stringResult,
    voidResult,
    type ArgValue,
    type DecodedArgs,
    type MainExecCtx,
    type Result,
} from "./op-table";
import { encodePayload } from "./payload-codec";
import {
    ArgKind,
} from "./protocol";

// --- helpers ---
function argString(args: DecodedArgs, i: number): string {
  const v = args.values[i];
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function argHandle(args: DecodedArgs, i: number): number {
  const v = args.values[i];
  // Handles flow as numbers (the worker sends the raw integer).
  return typeof v === "number" ? v : 0;
}

// Type guards that use nodeType instead of instanceof — the polyfill may
// overwrite globalThis.Element/HTMLElement with worker-side classes, which
// would cause instanceof checks to fail on real DOM nodes from happy-dom.
function isElement(node: Node | null): node is Element {
  return node != null && node.nodeType === 1;
}
function isHTMLElement(node: Node | null): node is HTMLElement {
  return node != null && node.nodeType === 1;
}
function isDocument(node: Node | null): node is Document {
  return node != null && node.nodeType === 9;
}

// --- Document ops ---

registerOp({
  id: ids.OP_DOCUMENT_CREATE_ELEMENT,
  name: "Document.createElement",
  kind: "method",
  target: "document",
  argSpec: [ArgKind.StringAtom],
  resultSpec: "handle",
  exec: (ctx: MainExecCtx, _node: Node | null, args: DecodedArgs): Result => {
    const tag = argString(args, 0);
    try {
      const el = ctx.document.createElement(tag);
      return handleResult(ctx.allocHandle(el));
    } catch (e) {
      return errorResult((e as Error).message);
    }
  },
});

registerOp({
  id: ids.OP_DOCUMENT_CREATE_TEXT_NODE,
  name: "Document.createTextNode",
  kind: "method",
  target: "document",
  argSpec: [ArgKind.StringAtom],
  resultSpec: "handle",
  exec: (ctx: MainExecCtx, _node: Node | null, args: DecodedArgs): Result => {
    const text = argString(args, 0);
    const node = ctx.document.createTextNode(text);
    return handleResult(ctx.allocHandle(node));
  },
});

registerOp({
  id: ids.OP_DOCUMENT_CREATE_DOCUMENT_FRAGMENT,
  name: "Document.createDocumentFragment",
  kind: "method",
  target: "document",
  argSpec: [],
  resultSpec: "handle",
  exec: (ctx: MainExecCtx): Result => {
    const frag = ctx.document.createDocumentFragment();
    return handleResult(ctx.allocHandle(frag));
  },
});

registerOp({
  id: ids.OP_DOCUMENT_GET_ELEMENT_BY_ID,
  name: "Document.getElementById",
  kind: "method",
  target: "document",
  argSpec: [ArgKind.StringAtom],
  resultSpec: "handle",
  exec: (ctx: MainExecCtx, _node: Node | null, args: DecodedArgs): Result => {
    const id = argString(args, 0);
    const el = ctx.document.getElementById(id);
    if (!el) return handleResult(0); // 0 = null handle
    return handleResult(ctx.allocHandle(el));
  },
});

// --- Node ops ---

registerOp({
  id: ids.OP_NODE_APPEND_CHILD,
  name: "Node.appendChild",
  kind: "method",
  target: "node",
  argSpec: [ArgKind.Handle],
  resultSpec: "handle",
  exec: (ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!node) return handleResult(0);
    const childHandle = argHandle(args, 0);
    const child = ctx.resolveHandle(childHandle);
    if (!child) return handleResult(0);
    try {
      node.appendChild(child);
      return handleResult(ctx.allocHandle(child));
    } catch (e) {
      return errorResult((e as Error).message);
    }
  },
});

registerOp({
  id: ids.OP_NODE_REMOVE_CHILD,
  name: "Node.removeChild",
  kind: "method",
  target: "node",
  argSpec: [ArgKind.Handle],
  resultSpec: "handle",
  exec: (ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!node) return handleResult(0);
    const child = ctx.resolveHandle(argHandle(args, 0));
    if (!child) return handleResult(0);
    try {
      if ((child as any).parentNode !== node) return handleResult(ctx.allocHandle(child));
      node.removeChild(child);
      return handleResult(ctx.allocHandle(child));
    } catch (e) {
      return errorResult((e as Error).message);
    }
  },
});

registerOp({
  id: ids.OP_NODE_GET_PARENT_NODE,
  name: "Node.parentNode",
  kind: "getter",
  target: "node",
  argSpec: [],
  resultSpec: "handle",
  exec: (ctx: MainExecCtx, node: Node | null): Result => {
    if (!node || !node.parentNode) return handleResult(0);
    return handleResult(ctx.allocHandle(node.parentNode));
  },
});

registerOp({
  id: ids.OP_NODE_GET_TEXT_CONTENT,
  name: "Node.textContent",
  kind: "getter",
  target: "node",
  argSpec: [],
  resultSpec: ArgKind.StringAtom,
  exec: (ctx: MainExecCtx, node: Node | null): Result => {
    if (!node) return errorResult("textContent: null node");
    const text = node.textContent ?? "";
    return stringResult(ctx.internString(text));
  },
});

registerOp({
  id: ids.OP_NODE_SET_TEXT_CONTENT,
  name: "Node.textContent",
  kind: "setter",
  target: "node",
  argSpec: [ArgKind.StringAtom],
  resultSpec: "void",
  exec: (_ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!node) return errorResult("textContent: null node");
    node.textContent = argString(args, 0);
    return voidResult();
  },
});

// --- Element ops ---

registerOp({
  id: ids.OP_ELEMENT_SET_ATTRIBUTE,
  name: "Element.setAttribute",
  kind: "method",
  target: "element",
  argSpec: [ArgKind.StringAtom, ArgKind.StringAtom],
  resultSpec: "void",
  exec: (_ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!isElement(node)) return errorResult("setAttribute: not an element");
    const name = argString(args, 0);
    const value = argString(args, 1);
    try {
      node.setAttribute(name, value);
      return voidResult();
    } catch (e) {
      return errorResult((e as Error).message);
    }
  },
});

registerOp({
  id: ids.OP_ELEMENT_GET_ATTRIBUTE,
  name: "Element.getAttribute",
  kind: "method",
  target: "element",
  argSpec: [ArgKind.StringAtom],
  resultSpec: ArgKind.StringAtom,
  exec: (ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!isElement(node)) return errorResult("getAttribute: not an element");
    const v = node.getAttribute(argString(args, 0));
    if (v == null) return stringResult(ctx.internString(""));
    return stringResult(ctx.internString(v));
  },
});

registerOp({
  id: ids.OP_ELEMENT_REMOVE_ATTRIBUTE,
  name: "Element.removeAttribute",
  kind: "method",
  target: "element",
  argSpec: [ArgKind.StringAtom],
  resultSpec: "void",
  exec: (_ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!isElement(node)) return errorResult("removeAttribute: not an element");
    node.removeAttribute(argString(args, 0));
    return voidResult();
  },
});

registerOp({
  id: ids.OP_ELEMENT_HAS_ATTRIBUTE,
  name: "Element.hasAttribute",
  kind: "method",
  target: "element",
  argSpec: [ArgKind.StringAtom],
  resultSpec: ArgKind.Bool,
  exec: (_ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!isElement(node)) return errorResult("hasAttribute: not an element");
    return boolResult(node.hasAttribute(argString(args, 0)));
  },
});

registerOp({
  id: ids.OP_ELEMENT_GET_TAG_NAME,
  name: "Element.tagName",
  kind: "getter",
  target: "element",
  argSpec: [],
  resultSpec: ArgKind.StringAtom,
  exec: (ctx: MainExecCtx, node: Node | null): Result => {
    if (!isElement(node)) return errorResult("tagName: not an element");
    return stringResult(ctx.internString(node.tagName));
  },
});

registerOp({
  id: ids.OP_ELEMENT_GET_ID,
  name: "Element.id",
  kind: "getter",
  target: "element",
  argSpec: [],
  resultSpec: ArgKind.StringAtom,
  exec: (ctx: MainExecCtx, node: Node | null): Result => {
    if (!isElement(node)) return errorResult("id: not an element");
    return stringResult(ctx.internString(node.id));
  },
});

registerOp({
  id: ids.OP_ELEMENT_SET_ID,
  name: "Element.id",
  kind: "setter",
  target: "element",
  argSpec: [ArgKind.StringAtom],
  resultSpec: "void",
  exec: (_ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!isElement(node)) return errorResult("id: not an element");
    node.id = argString(args, 0);
    return voidResult();
  },
});

registerOp({
  id: ids.OP_ELEMENT_GET_CLASS_NAME,
  name: "Element.className",
  kind: "getter",
  target: "element",
  argSpec: [],
  resultSpec: ArgKind.StringAtom,
  exec: (ctx: MainExecCtx, node: Node | null): Result => {
    if (!isElement(node)) return errorResult("className: not an element");
    return stringResult(ctx.internString(node.className));
  },
});

registerOp({
  id: ids.OP_ELEMENT_SET_CLASS_NAME,
  name: "Element.className",
  kind: "setter",
  target: "element",
  argSpec: [ArgKind.StringAtom],
  resultSpec: "void",
  exec: (_ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!isElement(node)) return errorResult("className: not an element");
    node.className = argString(args, 0);
    return voidResult();
  },
});

registerOp({
  id: ids.OP_ELEMENT_CLASS_LIST_ADD,
  name: "Element.classList.add",
  kind: "method",
  target: "element",
  argSpec: [ArgKind.StringAtom],
  resultSpec: "void",
  exec: (_ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!isElement(node)) return errorResult("classList.add: not an element");
    node.classList.add(argString(args, 0));
    return voidResult();
  },
});

registerOp({
  id: ids.OP_ELEMENT_CLASS_LIST_REMOVE,
  name: "Element.classList.remove",
  kind: "method",
  target: "element",
  argSpec: [ArgKind.StringAtom],
  resultSpec: "void",
  exec: (_ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!isElement(node)) return errorResult("classList.remove: not an element");
    node.classList.remove(argString(args, 0));
    return voidResult();
  },
});

registerOp({
  id: ids.OP_ELEMENT_CLASS_LIST_TOGGLE,
  name: "Element.classList.toggle",
  kind: "method",
  target: "element",
  argSpec: [ArgKind.StringAtom],
  resultSpec: ArgKind.Bool,
  exec: (_ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!isElement(node)) return errorResult("classList.toggle: not an element");
    return boolResult(node.classList.toggle(argString(args, 0)));
  },
});

registerOp({
  id: ids.OP_ELEMENT_CLASS_LIST_CONTAINS,
  name: "Element.classList.contains",
  kind: "method",
  target: "element",
  argSpec: [ArgKind.StringAtom],
  resultSpec: ArgKind.Bool,
  exec: (_ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!isElement(node)) return errorResult("classList.contains: not an element");
    return boolResult(node.classList.contains(argString(args, 0)));
  },
});

registerOp({
  id: ids.OP_ELEMENT_GET_INNER_HTML,
  name: "Element.innerHTML",
  kind: "getter",
  target: "element",
  argSpec: [],
  resultSpec: ArgKind.StringAtom,
  exec: (ctx: MainExecCtx, node: Node | null): Result => {
    if (!isElement(node)) return errorResult("innerHTML: not an element");
    return stringResult(ctx.internString(node.innerHTML));
  },
});

registerOp({
  id: ids.OP_ELEMENT_SET_INNER_HTML,
  name: "Element.innerHTML",
  kind: "setter",
  target: "element",
  argSpec: [ArgKind.StringAtom],
  resultSpec: "void",
  exec: (_ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!isElement(node)) return errorResult("innerHTML: not an element");
    node.innerHTML = argString(args, 0);
    return voidResult();
  },
});

registerOp({
  id: ids.OP_ELEMENT_QUERY_SELECTOR,
  name: "Element.querySelector",
  kind: "method",
  target: "element",
  argSpec: [ArgKind.StringAtom],
  resultSpec: "handle",
  exec: (ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!isElement(node)) return errorResult("querySelector: not an element");
    const el = node.querySelector(argString(args, 0));
    if (!el) return handleResult(0);
    return handleResult(ctx.allocHandle(el));
  },
});

registerOp({
  id: ids.OP_ELEMENT_FOCUS,
  name: "Element.focus",
  kind: "method",
  target: "element",
  argSpec: [],
  resultSpec: "void",
  exec: (_ctx: MainExecCtx, node: Node | null): Result => {
    if (!isHTMLElement(node)) return errorResult("focus: not an HTMLElement");
    node.focus();
    return voidResult();
  },
});

registerOp({
  id: ids.OP_ELEMENT_BLUR,
  name: "Element.blur",
  kind: "method",
  target: "element",
  argSpec: [],
  resultSpec: "void",
  exec: (_ctx: MainExecCtx, node: Node | null): Result => {
    if (!isHTMLElement(node)) return errorResult("blur: not an HTMLElement");
    node.blur();
    return voidResult();
  },
});

// --- Control ops ---

registerOp({
  id: ids.OP_RELEASE,
  name: "release",
  kind: "method",
  target: "any",
  argSpec: [ArgKind.Handle],
  resultSpec: "void",
  exec: (ctx: MainExecCtx, _node: Node | null, args: DecodedArgs): Result => {
    // The host intercepts OP_RELEASE before calling exec (it needs to free the
    // handle, not resolve it). This entry exists so the op-map has a name for
    // debugging. If we get here, just no-op.
    void ctx;
    void args;
    return voidResult();
  },
});

// --- EventTarget ops ---
// These are intercepted by the host (which delegates to EventDispatcher)
// rather than going through the normal exec path. The entries exist so the
// op-map has names for debugging and the op-ids are documented.

registerOp({
  id: ids.OP_ADD_EVENT_LISTENER,
  name: "EventTarget.addEventListener",
  kind: "method",
  target: "any",
  argSpec: [ArgKind.StringAtom],
  resultSpec: "void",
  exec: () => voidResult(), // host intercepts
});

registerOp({
  id: ids.OP_REMOVE_EVENT_LISTENER,
  name: "EventTarget.removeEventListener",
  kind: "method",
  target: "any",
  argSpec: [ArgKind.StringAtom],
  resultSpec: "void",
  exec: () => voidResult(), // host intercepts
});

// --- Window ops (viewport) ---
// In Phase 5 these will be served from the LayoutChannel SAB. For now they
// round-trip through the RPC. The exec reads from the real window.

registerOp({
  id: ids.OP_WINDOW_GET_INNER_WIDTH,
  name: "Window.innerWidth",
  kind: "getter",
  target: "window",
  argSpec: [],
  resultSpec: ArgKind.F64,
  exec: (ctx: MainExecCtx): Result => f64Result(ctx.window.innerWidth),
});

registerOp({
  id: ids.OP_WINDOW_GET_INNER_HEIGHT,
  name: "Window.innerHeight",
  kind: "getter",
  target: "window",
  argSpec: [],
  resultSpec: ArgKind.F64,
  exec: (ctx: MainExecCtx): Result => f64Result(ctx.window.innerHeight),
});

registerOp({
  id: ids.OP_WINDOW_GET_DEVICE_PIXEL_RATIO,
  name: "Window.devicePixelRatio",
  kind: "getter",
  target: "window",
  argSpec: [],
  resultSpec: ArgKind.F64,
  exec: (ctx: MainExecCtx): Result => f64Result(ctx.window.devicePixelRatio),
});

registerOp({
  id: ids.OP_WINDOW_GET_SCROLL_X,
  name: "Window.scrollX",
  kind: "getter",
  target: "window",
  argSpec: [],
  resultSpec: ArgKind.F64,
  exec: (ctx: MainExecCtx): Result => f64Result(ctx.window.scrollX),
});

registerOp({
  id: ids.OP_WINDOW_GET_SCROLL_Y,
  name: "Window.scrollY",
  kind: "getter",
  target: "window",
  argSpec: [],
  resultSpec: ArgKind.F64,
  exec: (ctx: MainExecCtx): Result => f64Result(ctx.window.scrollY),
});

registerOp({
  id: ids.OP_WINDOW_SCROLL_TO,
  name: "Window.scrollTo",
  kind: "method",
  target: "window",
  argSpec: [ArgKind.F64, ArgKind.F64],
  resultSpec: "void",
  exec: (ctx: MainExecCtx, _node: Node | null, args: DecodedArgs): Result => {
    ctx.window.scrollTo(args.values[0] as number, args.values[1] as number);
    return voidResult();
  },
});

// --- Layout ops (Phase 5 will redirect these to the LayoutChannel) ---

registerOp({
  id: ids.OP_ELEMENT_GET_CLIENT_WIDTH,
  name: "Element.clientWidth",
  kind: "getter",
  target: "element",
  argSpec: [],
  resultSpec: ArgKind.F64,
  exec: (_ctx: MainExecCtx, node: Node | null): Result => {
    if (!isElement(node)) return errorResult("clientWidth: not an element");
    return f64Result((node as Element).clientWidth);
  },
});

registerOp({
  id: ids.OP_ELEMENT_GET_CLIENT_HEIGHT,
  name: "Element.clientHeight",
  kind: "getter",
  target: "element",
  argSpec: [],
  resultSpec: ArgKind.F64,
  exec: (_ctx: MainExecCtx, node: Node | null): Result => {
    if (!isElement(node)) return errorResult("clientHeight: not an element");
    return f64Result((node as Element).clientHeight);
  },
});

registerOp({
  id: ids.OP_ELEMENT_GET_BOUNDING_CLIENT_RECT,
  name: "Element.getBoundingClientRect",
  kind: "method",
  target: "element",
  argSpec: [],
  resultSpec: ArgKind.PayloadRef,
  exec: (_ctx: MainExecCtx, node: Node | null): Result => {
    if (!isElement(node)) return errorResult("getBoundingClientRect: not an element");
    const r = (node as Element).getBoundingClientRect();
    const encoded = encodePayload({ x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, left: r.left, bottom: r.bottom, right: r.right });
    return { kind: ArgKind.PayloadRef, bytes: encoded };
  },
});

// --- Node tree manipulation (missing from initial set) ---

registerOp({
  id: ids.OP_NODE_INSERT_BEFORE,
  name: "Node.insertBefore",
  kind: "method",
  target: "any",
  argSpec: [ArgKind.Handle, ArgKind.Handle],
  resultSpec: "handle",
  exec: (ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!node) return errorResult("insertBefore: null node");
    const newChild = ctx.resolveHandle(args.values[0] as number);
    const refChild = args.values[1] as number;
    const refNode = refChild === 0 ? null : ctx.resolveHandle(refChild);
    if (!newChild) return errorResult("insertBefore: newChild not found");
    const inserted = node.insertBefore(newChild, refNode);
    return handleResult(ctx.allocHandle(inserted));
  },
});

registerOp({
  id: ids.OP_NODE_REPLACE_CHILD,
  name: "Node.replaceChild",
  kind: "method",
  target: "any",
  argSpec: [ArgKind.Handle, ArgKind.Handle],
  resultSpec: "handle",
  exec: (ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!node) return errorResult("replaceChild: null node");
    const newChild = ctx.resolveHandle(args.values[0] as number);
    const oldChild = ctx.resolveHandle(args.values[1] as number);
    if (!newChild || !oldChild) return errorResult("replaceChild: child not found");
    const replaced = node.replaceChild(newChild, oldChild);
    return handleResult(ctx.allocHandle(replaced));
  },
});

registerOp({
  id: ids.OP_NODE_HAS_CHILD_NODES,
  name: "Node.hasChildNodes",
  kind: "method",
  target: "any",
  argSpec: [],
  resultSpec: ArgKind.Bool,
  exec: (_ctx: MainExecCtx, node: Node | null): Result => {
    if (!node) return errorResult("hasChildNodes: null node");
    return boolResult(node.hasChildNodes());
  },
});

registerOp({
  id: ids.OP_NODE_GET_PARENT_ELEMENT,
  name: "Node.parentElement",
  kind: "getter",
  target: "any",
  argSpec: [],
  resultSpec: "handle",
  exec: (ctx: MainExecCtx, node: Node | null): Result => {
    if (!node) return handleResult(0);
    const pe = node.parentElement;
    return handleResult(pe ? ctx.allocHandle(pe) : 0);
  },
});

registerOp({
  id: ids.OP_NODE_GET_CHILD_NODES,
  name: "Node.childNodes",
  kind: "getter",
  target: "any",
  argSpec: [],
  resultSpec: ArgKind.PayloadRef,
  exec: (ctx: MainExecCtx, node: Node | null): Result => {
    if (!node) return { kind: ArgKind.PayloadRef, bytes: encodePayload([] as ArgValue[]) };
    const handles = Array.from(node.childNodes).map((c) => ctx.allocHandle(c));
    return { kind: ArgKind.PayloadRef, bytes: encodePayload(handles as ArgValue[]) };
  },
});

registerOp({
  id: ids.OP_NODE_GET_FIRST_CHILD,
  name: "Node.firstChild",
  kind: "getter",
  target: "any",
  argSpec: [],
  resultSpec: "handle",
  exec: (ctx: MainExecCtx, node: Node | null): Result => {
    if (!node) return handleResult(0);
    const fc = node.firstChild;
    return handleResult(fc ? ctx.allocHandle(fc) : 0);
  },
});

registerOp({
  id: ids.OP_NODE_GET_LAST_CHILD,
  name: "Node.lastChild",
  kind: "getter",
  target: "any",
  argSpec: [],
  resultSpec: "handle",
  exec: (ctx: MainExecCtx, node: Node | null): Result => {
    if (!node) return handleResult(0);
    const lc = node.lastChild;
    return handleResult(lc ? ctx.allocHandle(lc) : 0);
  },
});

registerOp({
  id: ids.OP_NODE_GET_NEXT_SIBLING,
  name: "Node.nextSibling",
  kind: "getter",
  target: "any",
  argSpec: [],
  resultSpec: "handle",
  exec: (ctx: MainExecCtx, node: Node | null): Result => {
    if (!node) return handleResult(0);
    const ns = node.nextSibling;
    return handleResult(ns ? ctx.allocHandle(ns) : 0);
  },
});

registerOp({
  id: ids.OP_NODE_GET_PREVIOUS_SIBLING,
  name: "Node.previousSibling",
  kind: "getter",
  target: "any",
  argSpec: [],
  resultSpec: "handle",
  exec: (ctx: MainExecCtx, node: Node | null): Result => {
    if (!node) return handleResult(0);
    const ps = node.previousSibling;
    return handleResult(ps ? ctx.allocHandle(ps) : 0);
  },
});

registerOp({
  id: ids.OP_NODE_CLONE_NODE,
  name: "Node.cloneNode",
  kind: "method",
  target: "any",
  argSpec: [ArgKind.Bool],
  resultSpec: "handle",
  exec: (ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!node) return errorResult("cloneNode: null node");
    const deep = args.values[0] as boolean;
    const clone = node.cloneNode(deep);
    return handleResult(ctx.allocHandle(clone));
  },
});

registerOp({
  id: ids.OP_NODE_CONTAINS,
  name: "Node.contains",
  kind: "method",
  target: "any",
  argSpec: [ArgKind.Handle],
  resultSpec: ArgKind.Bool,
  exec: (ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!node) return boolResult(false);
    const other = ctx.resolveHandle(args.values[0] as number);
    if (!other) return boolResult(false);
    return boolResult(node.contains(other));
  },
});

registerOp({
  id: ids.OP_NODE_GET_NODE_TYPE,
  name: "Node.nodeType",
  kind: "getter",
  target: "any",
  argSpec: [],
  resultSpec: ArgKind.I32,
  exec: (_ctx: MainExecCtx, node: Node | null): Result => {
    if (!node) return i32Result(0);
    return i32Result(node.nodeType);
  },
});

registerOp({
  id: ids.OP_NODE_GET_NODE_NAME,
  name: "Node.nodeName",
  kind: "getter",
  target: "any",
  argSpec: [],
  resultSpec: ArgKind.StringAtom,
  exec: (ctx: MainExecCtx, node: Node | null): Result => {
    if (!node) return stringResult(ctx.internString(""));
    return stringResult(ctx.internString(node.nodeName));
  },
});

registerOp({
  id: ids.OP_NODE_GET_NODE_VALUE,
  name: "Node.nodeValue",
  kind: "getter",
  target: "any",
  argSpec: [],
  resultSpec: ArgKind.StringAtom,
  exec: (ctx: MainExecCtx, node: Node | null): Result => {
    if (!node) return stringResult(ctx.internString(""));
    return stringResult(ctx.internString(node.nodeValue ?? ""));
  },
});

registerOp({
  id: ids.OP_NODE_SET_NODE_VALUE,
  name: "Node.nodeValue",
  kind: "setter",
  target: "any",
  argSpec: [ArgKind.StringAtom],
  resultSpec: "void",
  exec: (_ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!node) return voidResult();
    node.nodeValue = argString(args, 0);
    return voidResult();
  },
});

registerOp({
  id: ids.OP_NODE_GET_DATA,
  name: "CharacterData.data",
  kind: "getter",
  target: "any",
  argSpec: [],
  resultSpec: ArgKind.StringAtom,
  exec: (ctx: MainExecCtx, node: Node | null): Result => {
    if (!node) return stringResult(ctx.internString(""));
    const data = (node as Text | Comment).data ?? "";
    return stringResult(ctx.internString(data));
  },
});

registerOp({
  id: ids.OP_NODE_SET_DATA,
  name: "CharacterData.data",
  kind: "setter",
  target: "any",
  argSpec: [ArgKind.StringAtom],
  resultSpec: "void",
  exec: (_ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!node) return voidResult();
    (node as Text | Comment).data = argString(args, 0);
    return voidResult();
  },
});

registerOp({
  id: ids.OP_NODE_DISPATCH_EVENT,
  name: "Node.dispatchEvent",
  kind: "method",
  target: "any",
  argSpec: [ArgKind.PayloadRef],
  resultSpec: ArgKind.Bool,
  exec: (_ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!node) return boolResult(false);
    // The event payload contains { type, bubbles, cancelable, ... }
    const payload = args.values[0];
    if (!payload || typeof payload !== "object") return boolResult(false);
    const p = payload as Record<string, ArgValue>;
    const type = p.type as string;
    const bubbles = (p.bubbles as boolean) ?? false;
    const cancelable = (p.cancelable as boolean) ?? false;
    const event = new Event(type, { bubbles, cancelable });
    return boolResult((node as EventTarget).dispatchEvent(event));
  },
});

registerOp({
  id: ids.OP_NODE_IS_EQUAL_NODE,
  name: "Node.isEqualNode",
  kind: "method",
  target: "any",
  argSpec: [ArgKind.Handle],
  resultSpec: ArgKind.Bool,
  exec: (ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!node) return boolResult(false);
    const other = ctx.resolveHandle(args.values[0] as number);
    if (!other) return boolResult(false);
    return boolResult(node.isEqualNode(other));
  },
});

// --- Document (missing) ---

registerOp({
  id: ids.OP_DOCUMENT_CREATE_COMMENT,
  name: "Document.createComment",
  kind: "method",
  target: "document",
  argSpec: [ArgKind.StringAtom],
  resultSpec: "handle",
  exec: (ctx: MainExecCtx, _node: Node | null, args: DecodedArgs): Result => {
    const comment = ctx.document.createComment(argString(args, 0));
    return handleResult(ctx.allocHandle(comment));
  },
});

registerOp({
  id: ids.OP_DOCUMENT_CREATE_ELEMENT_NS,
  name: "Document.createElementNS",
  kind: "method",
  target: "document",
  argSpec: [ArgKind.StringAtom, ArgKind.StringAtom],
  resultSpec: "handle",
  exec: (ctx: MainExecCtx, _node: Node | null, args: DecodedArgs): Result => {
    const ns = argString(args, 0);
    const tag = argString(args, 1);
    const el = ctx.document.createElementNS(ns, tag);
    return handleResult(ctx.allocHandle(el));
  },
});

registerOp({
  id: ids.OP_DOCUMENT_QUERY_SELECTOR,
  name: "Document.querySelector",
  kind: "method",
  target: "document",
  argSpec: [ArgKind.StringAtom],
  resultSpec: "handle",
  exec: (ctx: MainExecCtx, _node: Node | null, args: DecodedArgs): Result => {
    const el = ctx.document.querySelector(argString(args, 0));
    return handleResult(el ? ctx.allocHandle(el) : 0);
  },
});

registerOp({
  id: ids.OP_DOCUMENT_QUERY_SELECTOR_ALL,
  name: "Document.querySelectorAll",
  kind: "method",
  target: "document",
  argSpec: [ArgKind.StringAtom],
  resultSpec: ArgKind.PayloadRef,
  exec: (ctx: MainExecCtx, _node: Node | null, args: DecodedArgs): Result => {
    const els = ctx.document.querySelectorAll(argString(args, 0));
    const handles = Array.from(els).map((e) => ctx.allocHandle(e));
    return { kind: ArgKind.PayloadRef, bytes: encodePayload(handles as ArgValue[]) };
  },
});

registerOp({
  id: ids.OP_DOCUMENT_GET_DOCUMENT_ELEMENT,
  name: "Document.documentElement",
  kind: "getter",
  target: "document",
  argSpec: [],
  resultSpec: "handle",
  exec: (ctx: MainExecCtx): Result => {
    return handleResult(ctx.allocHandle(ctx.document.documentElement));
  },
});

registerOp({
  id: ids.OP_DOCUMENT_GET_HEAD,
  name: "Document.head",
  kind: "getter",
  target: "document",
  argSpec: [],
  resultSpec: "handle",
  exec: (ctx: MainExecCtx): Result => {
    return handleResult(ctx.allocHandle(ctx.document.head));
  },
});

registerOp({
  id: ids.OP_DOCUMENT_GET_BODY,
  name: "Document.body",
  kind: "getter",
  target: "document",
  argSpec: [],
  resultSpec: "handle",
  exec: (ctx: MainExecCtx): Result => {
    return handleResult(ctx.allocHandle(ctx.document.body));
  },
});

registerOp({
  id: ids.OP_DOCUMENT_GET_READY_STATE,
  name: "Document.readyState",
  kind: "getter",
  target: "document",
  argSpec: [],
  resultSpec: ArgKind.StringAtom,
  exec: (ctx: MainExecCtx): Result => {
    return stringResult(ctx.internString(ctx.document.readyState));
  },
});

registerOp({
  id: ids.OP_DOCUMENT_GET_VISIBILITY_STATE,
  name: "Document.visibilityState",
  kind: "getter",
  target: "document",
  argSpec: [],
  resultSpec: ArgKind.StringAtom,
  exec: (ctx: MainExecCtx): Result => {
    return stringResult(ctx.internString(ctx.document.visibilityState));
  },
});

registerOp({
  id: ids.OP_DOCUMENT_GET_DEFAULT_VIEW,
  name: "Document.defaultView",
  kind: "getter",
  target: "document",
  argSpec: [],
  resultSpec: "handle",
  exec: (_ctx: MainExecCtx): Result => {
    // defaultView is the window — return the reserved window handle.
    return handleResult(4); // HANDLE_WINDOW
  },
});

// --- Element (missing) ---

registerOp({
  id: ids.OP_ELEMENT_SET_ATTRIBUTE_NS,
  name: "Element.setAttributeNS",
  kind: "method",
  target: "element",
  argSpec: [ArgKind.StringAtom, ArgKind.StringAtom, ArgKind.StringAtom],
  resultSpec: "void",
  exec: (_ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!isElement(node)) return errorResult("setAttributeNS: not an element");
    (node as Element).setAttributeNS(argString(args, 0), argString(args, 1), argString(args, 2));
    return voidResult();
  },
});

registerOp({
  id: ids.OP_ELEMENT_GET_ATTRIBUTE_NS,
  name: "Element.getAttributeNS",
  kind: "method",
  target: "element",
  argSpec: [ArgKind.StringAtom, ArgKind.StringAtom],
  resultSpec: ArgKind.StringAtom,
  exec: (ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!isElement(node)) return errorResult("getAttributeNS: not an element");
    const v = (node as Element).getAttributeNS(argString(args, 0), argString(args, 1));
    return stringResult(ctx.internString(v ?? ""));
  },
});

registerOp({
  id: ids.OP_ELEMENT_REMOVE_ATTRIBUTE_NS,
  name: "Element.removeAttributeNS",
  kind: "method",
  target: "element",
  argSpec: [ArgKind.StringAtom, ArgKind.StringAtom],
  resultSpec: "void",
  exec: (_ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!isElement(node)) return errorResult("removeAttributeNS: not an element");
    (node as Element).removeAttributeNS(argString(args, 0), argString(args, 1));
    return voidResult();
  },
});

registerOp({
  id: ids.OP_ELEMENT_HAS_ATTRIBUTE_NS,
  name: "Element.hasAttributeNS",
  kind: "method",
  target: "element",
  argSpec: [ArgKind.StringAtom, ArgKind.StringAtom],
  resultSpec: ArgKind.Bool,
  exec: (_ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!isElement(node)) return boolResult(false);
    return boolResult((node as Element).hasAttributeNS(argString(args, 0), argString(args, 1)));
  },
});

registerOp({
  id: ids.OP_ELEMENT_GET_STYLE_PROP,
  name: "Element.style.getPropertyValue",
  kind: "method",
  target: "element",
  argSpec: [ArgKind.StringAtom],
  resultSpec: ArgKind.StringAtom,
  exec: (ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!isElement(node)) return stringResult(ctx.internString(""));
    const v = (node as HTMLElement).style.getPropertyValue(argString(args, 0));
    return stringResult(ctx.internString(v));
  },
});

registerOp({
  id: ids.OP_ELEMENT_SET_STYLE_PROP,
  name: "Element.style.setProperty",
  kind: "method",
  target: "element",
  argSpec: [ArgKind.StringAtom, ArgKind.StringAtom],
  resultSpec: "void",
  exec: (_ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!isElement(node)) return errorResult("style.setProperty: not an element");
    (node as HTMLElement).style.setProperty(argString(args, 0), argString(args, 1));
    return voidResult();
  },
});

registerOp({
  id: ids.OP_ELEMENT_GET_STYLE_CSS_TEXT,
  name: "Element.style.cssText",
  kind: "getter",
  target: "element",
  argSpec: [],
  resultSpec: ArgKind.StringAtom,
  exec: (ctx: MainExecCtx, node: Node | null): Result => {
    if (!isElement(node)) return stringResult(ctx.internString(""));
    return stringResult(ctx.internString((node as HTMLElement).style.cssText));
  },
});

registerOp({
  id: ids.OP_ELEMENT_SET_STYLE_CSS_TEXT,
  name: "Element.style.cssText",
  kind: "setter",
  target: "element",
  argSpec: [ArgKind.StringAtom],
  resultSpec: "void",
  exec: (_ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!isElement(node)) return errorResult("style.cssText: not an element");
    (node as HTMLElement).style.cssText = argString(args, 0);
    return voidResult();
  },
});

registerOp({
  id: ids.OP_ELEMENT_GET_OUTER_HTML,
  name: "Element.outerHTML",
  kind: "getter",
  target: "element",
  argSpec: [],
  resultSpec: ArgKind.StringAtom,
  exec: (ctx: MainExecCtx, node: Node | null): Result => {
    if (!isElement(node)) return stringResult(ctx.internString(""));
    return stringResult(ctx.internString((node as Element).outerHTML));
  },
});

registerOp({
  id: ids.OP_ELEMENT_QUERY_SELECTOR_ALL,
  name: "Element.querySelectorAll",
  kind: "method",
  target: "element",
  argSpec: [ArgKind.StringAtom],
  resultSpec: ArgKind.PayloadRef,
  exec: (ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!isElement(node)) return { kind: ArgKind.PayloadRef, bytes: encodePayload([] as ArgValue[]) };
    const els = (node as Element).querySelectorAll(argString(args, 0));
    const handles = Array.from(els).map((e) => ctx.allocHandle(e));
    return { kind: ArgKind.PayloadRef, bytes: encodePayload(handles as ArgValue[]) };
  },
});

registerOp({
  id: ids.OP_ELEMENT_CLICK,
  name: "Element.click",
  kind: "method",
  target: "element",
  argSpec: [],
  resultSpec: "void",
  exec: (_ctx: MainExecCtx, node: Node | null): Result => {
    if (!isElement(node)) return errorResult("click: not an element");
    (node as HTMLElement).click();
    return voidResult();
  },
});

registerOp({
  id: ids.OP_ELEMENT_SCROLL_INTO_VIEW,
  name: "Element.scrollIntoView",
  kind: "method",
  target: "element",
  argSpec: [ArgKind.Bool],
  resultSpec: "void",
  exec: (_ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!isElement(node)) return errorResult("scrollIntoView: not an element");
    (node as Element).scrollIntoView(args.values[0] as boolean);
    return voidResult();
  },
});

registerOp({
  id: ids.OP_ELEMENT_GET_OFFSET_WIDTH,
  name: "Element.offsetWidth",
  kind: "getter",
  target: "element",
  argSpec: [],
  resultSpec: ArgKind.F64,
  exec: (_ctx: MainExecCtx, node: Node | null): Result => {
    if (!isElement(node)) return f64Result(0);
    return f64Result((node as HTMLElement).offsetWidth);
  },
});

registerOp({
  id: ids.OP_ELEMENT_GET_OFFSET_HEIGHT,
  name: "Element.offsetHeight",
  kind: "getter",
  target: "element",
  argSpec: [],
  resultSpec: ArgKind.F64,
  exec: (_ctx: MainExecCtx, node: Node | null): Result => {
    if (!isElement(node)) return f64Result(0);
    return f64Result((node as HTMLElement).offsetHeight);
  },
});

registerOp({
  id: ids.OP_ELEMENT_GET_SCROLL_TOP,
  name: "Element.scrollTop",
  kind: "getter",
  target: "element",
  argSpec: [],
  resultSpec: ArgKind.F64,
  exec: (_ctx: MainExecCtx, node: Node | null): Result => {
    if (!isElement(node)) return f64Result(0);
    return f64Result((node as Element).scrollTop);
  },
});

registerOp({
  id: ids.OP_ELEMENT_SET_SCROLL_TOP,
  name: "Element.scrollTop",
  kind: "setter",
  target: "element",
  argSpec: [ArgKind.F64],
  resultSpec: "void",
  exec: (_ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!isElement(node)) return errorResult("scrollTop: not an element");
    (node as Element).scrollTop = args.values[0] as number;
    return voidResult();
  },
});

registerOp({
  id: ids.OP_ELEMENT_GET_SCROLL_LEFT,
  name: "Element.scrollLeft",
  kind: "getter",
  target: "element",
  argSpec: [],
  resultSpec: ArgKind.F64,
  exec: (_ctx: MainExecCtx, node: Node | null): Result => {
    if (!isElement(node)) return f64Result(0);
    return f64Result((node as Element).scrollLeft);
  },
});

registerOp({
  id: ids.OP_ELEMENT_SET_SCROLL_LEFT,
  name: "Element.scrollLeft",
  kind: "setter",
  target: "element",
  argSpec: [ArgKind.F64],
  resultSpec: "void",
  exec: (_ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!isElement(node)) return errorResult("scrollLeft: not an element");
    (node as Element).scrollLeft = args.values[0] as number;
    return voidResult();
  },
});

registerOp({
  id: ids.OP_ELEMENT_GET_SCROLL_HEIGHT,
  name: "Element.scrollHeight",
  kind: "getter",
  target: "element",
  argSpec: [],
  resultSpec: ArgKind.F64,
  exec: (_ctx: MainExecCtx, node: Node | null): Result => {
    if (!isElement(node)) return f64Result(0);
    return f64Result((node as Element).scrollHeight);
  },
});

registerOp({
  id: ids.OP_ELEMENT_GET_CHILDREN,
  name: "Element.children",
  kind: "getter",
  target: "element",
  argSpec: [],
  resultSpec: ArgKind.PayloadRef,
  exec: (ctx: MainExecCtx, node: Node | null): Result => {
    if (!isElement(node)) return { kind: ArgKind.PayloadRef, bytes: encodePayload([] as ArgValue[]) };
    const handles = Array.from((node as Element).children).map((e) => ctx.allocHandle(e));
    return { kind: ArgKind.PayloadRef, bytes: encodePayload(handles as ArgValue[]) };
  },
});

registerOp({
  id: ids.OP_ELEMENT_GET_CHILD_ELEMENT_COUNT,
  name: "Element.childElementCount",
  kind: "getter",
  target: "element",
  argSpec: [],
  resultSpec: ArgKind.I32,
  exec: (_ctx: MainExecCtx, node: Node | null): Result => {
    if (!isElement(node)) return i32Result(0);
    return i32Result((node as Element).childElementCount);
  },
});

registerOp({
  id: ids.OP_ELEMENT_REMOVE,
  name: "Element.remove",
  kind: "method",
  target: "element",
  argSpec: [],
  resultSpec: "void",
  exec: (_ctx: MainExecCtx, node: Node | null): Result => {
    if (!isElement(node)) return errorResult("remove: not an element");
    (node as Element).remove();
    return voidResult();
  },
});

registerOp({
  id: ids.OP_ELEMENT_CLOSEST,
  name: "Element.closest",
  kind: "method",
  target: "element",
  argSpec: [ArgKind.StringAtom],
  resultSpec: "handle",
  exec: (ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!isElement(node)) return handleResult(0);
    const el = (node as Element).closest(argString(args, 0));
    return handleResult(el ? ctx.allocHandle(el) : 0);
  },
});

registerOp({
  id: ids.OP_ELEMENT_MATCHES,
  name: "Element.matches",
  kind: "method",
  target: "element",
  argSpec: [ArgKind.StringAtom],
  resultSpec: ArgKind.Bool,
  exec: (_ctx: MainExecCtx, node: Node | null, args: DecodedArgs): Result => {
    if (!isElement(node)) return boolResult(false);
    return boolResult((node as Element).matches(argString(args, 0)));
  },
});

// --- Template element content ---

registerOp({
  id: ids.OP_ELEMENT_GET_TEMPLATE_CONTENT,
  name: "HTMLTemplateElement.content",
  kind: "getter",
  target: "element",
  argSpec: [],
  resultSpec: "handle",
  exec: (ctx: MainExecCtx, node: Node | null): Result => {
    if (!node) return handleResult(0);
    const el = node as any;
    // .content is only on HTMLTemplateElement; return 0 for non-template elements
    if (typeof el.content === "undefined") return handleResult(0);
    return handleResult(ctx.allocHandle(el.content));
  },
});

// --- Window (missing) ---

registerOp({
  id: ids.OP_WINDOW_REQUEST_ANIMATION_FRAME,
  name: "Window.requestAnimationFrame",
  kind: "method",
  target: "window",
  argSpec: [],
  resultSpec: ArgKind.I32,
  exec: (ctx: MainExecCtx): Result => {
    // The host intercepts rAF to manage the callback on the worker side.
    // If we get here, just return a fake id.
    void ctx;
    return i32Result(0);
  },
});

registerOp({
  id: ids.OP_WINDOW_CANCEL_ANIMATION_FRAME,
  name: "Window.cancelAnimationFrame",
  kind: "method",
  target: "window",
  argSpec: [ArgKind.I32],
  resultSpec: "void",
  exec: (ctx: MainExecCtx, _node: Node | null, _args: DecodedArgs): Result => {
    void ctx;
    return voidResult();
  },
});

registerOp({
  id: ids.OP_WINDOW_GET_COMPUTED_STYLE,
  name: "Window.getComputedStyle",
  kind: "method",
  target: "window",
  argSpec: [ArgKind.Handle],
  resultSpec: ArgKind.PayloadRef,
  exec: (ctx: MainExecCtx, _node: Node | null, args: DecodedArgs): Result => {
    const el = ctx.resolveHandle(args.values[0] as number);
    if (!isElement(el)) return { kind: ArgKind.PayloadRef, bytes: encodePayload({} as ArgValue) };
    const style = ctx.window.getComputedStyle(el as Element);
    // Extract a snapshot of common CSS properties.
    const snapshot: Record<string, string> = {};
    for (let i = 0; i < style.length; i++) {
      const prop = style.item(i);
      snapshot[prop] = style.getPropertyValue(prop);
    }
    return { kind: ArgKind.PayloadRef, bytes: encodePayload(snapshot as ArgValue) };
  },
});

registerOp({
  id: ids.OP_WINDOW_ADD_EVENT_LISTENER,
  name: "Window.addEventListener",
  kind: "method",
  target: "window",
  argSpec: [ArgKind.StringAtom],
  resultSpec: "void",
  exec: () => voidResult(), // host intercepts
});

registerOp({
  id: ids.OP_WINDOW_REMOVE_EVENT_LISTENER,
  name: "Window.removeEventListener",
  kind: "method",
  target: "window",
  argSpec: [ArgKind.StringAtom],
  resultSpec: "void",
  exec: () => voidResult(), // host intercepts
});

// --- Layout subscription ops ---

registerOp({
  id: ids.OP_TRACK_LAYOUT,
  name: "trackLayout",
  kind: "method",
  target: "any",
  argSpec: [ArgKind.Handle],
  resultSpec: "void",
  exec: () => voidResult(), // host intercepts
});

registerOp({
  id: ids.OP_UNTRACK_LAYOUT,
  name: "untrackLayout",
  kind: "method",
  target: "any",
  argSpec: [ArgKind.Handle],
  resultSpec: "void",
  exec: () => voidResult(), // host intercepts
});

// Importing this module registers all the above ops as a side effect.
export const __opsRegistered = true;
