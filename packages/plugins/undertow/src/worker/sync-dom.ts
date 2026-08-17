// @ts-nocheck — sync methods intentionally narrow Promise<T> return types to T
// for React's synchronous reconciler. TypeScript can't express this narrowing.
// ============================================================================
// sync-dom — synchronous DOM class wrappers for the polyfill.
//
// React's reconciler calls DOM methods synchronously and expects immediate
// results (not Promises). These wrappers use rt.callSync() which blocks the
// worker via Atomics.wait until the main thread drains and replies, then
// returns the raw value directly.
// ============================================================================

import * as ids from "../shared/op-ids";
import { HANDLE_BODY, HANDLE_DOCUMENT, HANDLE_HEAD, HANDLE_HTML, HANDLE_WINDOW } from "../shared/protocol";
import { WorkerCSSStyleDeclaration } from "./dom/css-style-declaration";
import { WorkerDocument } from "./dom/document";
import { WorkerElement } from "./dom/element";
import { WorkerNode } from "./dom/node";
import { WorkerComment, WorkerText } from "./dom/text";
import { WorkerWindow } from "./dom/window";
import type { WorkerRuntime } from "./runtime";

// ============================================================================
// Handle cache — ensures the same handle always returns the same JS object.
// React sets internal properties (internalInstanceKey, internalPropsKey) on
// DOM element instances. If we create new SyncElement instances for the same
// handle, React's event delegation can't find the component instance from
// event.target. This cache ensures identity stability.
// ============================================================================
const handleCache: Map<number, WorkerNode | WorkerElement | WorkerText | WorkerComment> = new Map();

/** Get or create a cached SyncElement for the given handle. */
export function getSyncElement(handleId: number, rt: WorkerRuntime): SyncElement {
  const cached = handleCache.get(handleId);
  if (cached) {
    // If the cached object is already a SyncElement, return it.
    if (cached instanceof SyncElement) return cached;
    // If it's a SyncNode (e.g. firstChild was called before createElement),
    // we need to upgrade it to a SyncElement so it has setAttribute etc.
    // IMPORTANT: Copy React's internal properties (__reactFiber, __reactProps,
    // etc.) from the old SyncNode to the new SyncElement. React sets these
    // properties on the DOM element instances. If we replace the cached object
    // without copying them, React's event delegation can't find the fiber for
    // the element, and onClick/onChange handlers won't fire.
    const el = new SyncElement(handleId, rt);
    for (const key of Object.getOwnPropertyNames(cached)) {
      if (key.startsWith("__react") || key.startsWith("__eventTag")) {
        (el as any)[key] = (cached as any)[key];
      }
    }
    handleCache.set(handleId, el);
    return el;
  }
  const el = new SyncElement(handleId, rt);
  handleCache.set(handleId, el);
  return el;
}

/** Get or create a cached sync node wrapper for the given handle. */
export function getSyncNode(handleId: number, rt: WorkerRuntime): WorkerNode {
  const cached = handleCache.get(handleId);
  if (cached) return cached;
  const node = wrapSyncNode(handleId, rt);
  handleCache.set(handleId, node);
  return node;
}

export class SyncElement extends WorkerElement {
  constructor(id: number, rt: WorkerRuntime) {
    super(id, rt);
  }

  private _attrCache: Map<string, string> | null = null;
  setAttribute(name: string, value: string): void {
    this._attrCache?.delete(name);
    // Fire-and-forget: setAttribute doesn't return a value. The main thread
    // processes it in the next drain, batched with other fire-and-forget ops.
    // This avoids a blocking round-trip for every attribute set during React
    // reconciliation, which would add ~16ms per attribute (one frame).
    this.rt.callFireAndForget(ids.OP_ELEMENT_SET_ATTRIBUTE, this.handleId, [name, value]);
  }

  getAttribute(name: string): string {
    if (this._attrCache) {
      const cached = this._attrCache.get(name);
      if (cached !== undefined) return cached;
    }
    const v = this.rt.callSync(ids.OP_ELEMENT_GET_ATTRIBUTE, this.handleId, [name]).value as string;
    if (this._attrCache) this._attrCache.set(name, v);
    return v;
  }

  removeAttribute(name: string): void {
    this._attrCache?.delete(name);
    this.rt.callFireAndForget(ids.OP_ELEMENT_REMOVE_ATTRIBUTE, this.handleId, [name]);
  }

  hasAttribute(name: string): boolean {
    const v = this.getAttribute(name);
    return v !== null && v !== undefined;
  }

  private _tagName: string | null = null;
  get tagName(): string {
    if (this._tagName !== null) return this._tagName;
    this._tagName = (this.rt.callSync(ids.OP_ELEMENT_GET_TAG_NAME, this.handleId, []).value as string) ?? "";
    return this._tagName;
  }

  private _id: string | null = null;
  get id(): string {
    if (this._id !== null) return this._id;
    this._id = this.rt.callSync(ids.OP_ELEMENT_GET_ID, this.handleId, []).value as string;
    return this._id;
  }

  set id(v: string) {
    this._id = v;
    this.rt.callFireAndForget(ids.OP_ELEMENT_SET_ID, this.handleId, [v]);
  }

  private _className: string | null = null;
  get className(): string {
    if (this._className !== null) return this._className;
    this._className = this.rt.callSync(ids.OP_ELEMENT_GET_CLASS_NAME, this.handleId, []).value as string;
    return this._className;
  }

  set className(v: string) {
    this._className = v;
    this.rt.callFireAndForget(ids.OP_ELEMENT_SET_CLASS_NAME, this.handleId, [v]);
  }

  get innerHTML(): string {
    return this.rt.callSync(ids.OP_ELEMENT_GET_INNER_HTML, this.handleId, []).value as string;
  }

  set innerHTML(v: string) {
    this.rt.callFireAndForget(ids.OP_ELEMENT_SET_INNER_HTML, this.handleId, [v]);
  }

  get style(): WorkerCSSStyleDeclaration {
    return SyncCSSStyleDeclaration.create(this.handleId, this.rt);
  }

  get classList(): {
    add: (...tokens: string[]) => void;
    remove: (...tokens: string[]) => void;
    toggle: (token: string) => boolean;
    contains: (token: string) => boolean;
  } {
    const rt = this.rt;
    const handleId = this.handleId;
    return {
      add: (...tokens: string[]) => {
        for (const t of tokens) rt.callFireAndForget(ids.OP_ELEMENT_CLASS_LIST_ADD, handleId, [t]);
      },
      remove: (...tokens: string[]) => {
        for (const t of tokens) rt.callFireAndForget(ids.OP_ELEMENT_CLASS_LIST_REMOVE, handleId, [t]);
      },
      toggle: (token: string): boolean => {
        return rt.callSync(ids.OP_ELEMENT_CLASS_LIST_TOGGLE, handleId, [token]).value as boolean;
      },
      contains: (token: string): boolean => {
        return rt.callSync(ids.OP_ELEMENT_CLASS_LIST_CONTAINS, handleId, [token]).value as boolean;
      },
    };
  }

  querySelector(selector: string): WorkerElement | null {
    const h = this.rt.callSync(ids.OP_ELEMENT_QUERY_SELECTOR, this.handleId, [selector]).value as number;
    return h === 0 ? null : getSyncElement(h, this.rt);
  }

  querySelectorAll(selector: string): WorkerElement[] {
    const r = this.rt.callSync(ids.OP_ELEMENT_QUERY_SELECTOR_ALL, this.handleId, [selector]);
    const handles = r.value as number[];
    return handles.map((h) => getSyncElement(h, this.rt));
  }

  // Canvas elements — getContext is not supported in the worker DOM polyfill
  // (canvas rendering happens on the main thread). Return null so callers
  // that check for a falsy context (e.g. map-view.tsx) gracefully skip drawing.
  getContext(_type: string): CanvasRenderingContext2D | null {
    return null;
  }

  remove(): void {
    this.rt.callFireAndForget(ids.OP_ELEMENT_REMOVE, this.handleId, []);
  }

  // Node methods — all tree mutations use fire-and-forget. React's commit
  // phase doesn't use the return values of appendChild/insertBefore/
  // replaceChild/removeChild, and doesn't read back DOM tree state (parentNode,
  // nextSibling, etc.) after mutations — it tracks the DOM structure via its
  // internal fiber tree. Using callSync for these would block the worker for
  // ~16ms per call (the main thread processes sync requests as macrotasks via
  // MessageChannel, which preempt rAF and starve the render loop), causing
  // 0 FPS during React reconciliation (hundreds of appendChild calls).
  appendChild(child: WorkerNode): WorkerNode {
    this.rt.callFireAndForget(ids.OP_NODE_APPEND_CHILD, this.handleId, [child.handleId]);
    return child;
  }

  removeChild(child: WorkerNode): WorkerNode {
    this.rt.callFireAndForget(ids.OP_NODE_REMOVE_CHILD, this.handleId, [child.handleId]);
    return child;
  }

  insertBefore(newChild: WorkerNode, refChild: WorkerNode | null): WorkerNode {
    const refHandle = refChild ? refChild.handleId : 0;
    this.rt.callFireAndForget(ids.OP_NODE_INSERT_BEFORE, this.handleId, [newChild.handleId, refHandle]);
    return newChild;
  }

  replaceChild(newChild: WorkerNode, oldChild: WorkerNode): WorkerNode {
    this.rt.callFireAndForget(ids.OP_NODE_REPLACE_CHILD, this.handleId, [newChild.handleId, oldChild.handleId]);
    return oldChild;
  }

  get textContent(): string {
    return this.rt.callSync(ids.OP_NODE_GET_TEXT_CONTENT, this.handleId, []).value as string;
  }

  set textContent(v: string) {
    this.rt.callFireAndForget(ids.OP_NODE_SET_TEXT_CONTENT, this.handleId, [v]);
  }

  get parentNode(): WorkerNode | null {
    const h = this.rt.callSync(ids.OP_NODE_GET_PARENT_NODE, this.handleId, []).value as number;
    return h === 0 ? null : getSyncNode(h, this.rt);
  }

  get parentElement(): WorkerElement | null {
    const h = this.rt.callSync(ids.OP_NODE_GET_PARENT_ELEMENT, this.handleId, []).value as number;
    return h === 0 ? null : getSyncElement(h, this.rt);
  }

  get firstChild(): WorkerNode | null {
    const h = this.rt.callSync(ids.OP_NODE_GET_FIRST_CHILD, this.handleId, []).value as number;
    return h === 0 ? null : getSyncNode(h, this.rt);
  }

  get lastChild(): WorkerNode | null {
    const h = this.rt.callSync(ids.OP_NODE_GET_LAST_CHILD, this.handleId, []).value as number;
    return h === 0 ? null : getSyncNode(h, this.rt);
  }

  get nextSibling(): WorkerNode | null {
    const h = this.rt.callSync(ids.OP_NODE_GET_NEXT_SIBLING, this.handleId, []).value as number;
    return h === 0 ? null : getSyncNode(h, this.rt);
  }

  get previousSibling(): WorkerNode | null {
    const h = this.rt.callSync(ids.OP_NODE_GET_PREVIOUS_SIBLING, this.handleId, []).value as number;
    return h === 0 ? null : getSyncNode(h, this.rt);
  }

  get childNodes(): WorkerNode[] {
    const r = this.rt.callSync(ids.OP_NODE_GET_CHILD_NODES, this.handleId, []);
    const handles = r.value as number[];
    return handles.map((h) => getSyncNode(h, this.rt));
  }

  private _nodeType: number | null = null;
  get nodeType(): number {
    if (this._nodeType !== null) return this._nodeType;
    this._nodeType = this.rt.callSync(ids.OP_NODE_GET_NODE_TYPE, this.handleId, []).value as number;
    return this._nodeType;
  }

  private _nodeName: string | null = null;
  get nodeName(): string {
    if (this._nodeName !== null) return this._nodeName;
    this._nodeName = (this.rt.callSync(ids.OP_NODE_GET_NODE_NAME, this.handleId, []).value as string) ?? "";
    return this._nodeName;
  }

  get nodeValue(): string {
    return this.rt.callSync(ids.OP_NODE_GET_NODE_VALUE, this.handleId, []).value as string;
  }

  set nodeValue(v: string) {
    this.rt.callFireAndForget(ids.OP_NODE_SET_NODE_VALUE, this.handleId, [v]);
  }

  hasChildNodes(): boolean {
    return this.rt.callSync(ids.OP_NODE_HAS_CHILD_NODES, this.handleId, []).value as boolean;
  }

  contains(other: WorkerNode): boolean {
    return this.rt.callSync(ids.OP_NODE_CONTAINS, this.handleId, [other.handleId]).value as boolean;
  }

  cloneNode(deep = false): WorkerNode {
    const r = this.rt.callSync(ids.OP_NODE_CLONE_NODE, this.handleId, [deep]);
    const h = r.value as number;
    // Cloned nodes inherit the source's node type — cache it so wrapSyncNode
    // doesn't need a callSync round-trip.
    cacheNodeType(h, 1); // ELEMENT_NODE (SyncElement.cloneNode)
    return getSyncElement(h, this.rt);
  }

  // ownerDocument — React accesses this for event delegation
  get ownerDocument(): WorkerDocument {
    return this.rt.document;
  }

  // Sync events — React calls addEventListener synchronously
  addEventListener(type: string, listener: any): void {
    this.rt.eventPump.add(this.handleId, type, listener);
    this.rt.callFireAndForget(ids.OP_ADD_EVENT_LISTENER, this.handleId, [type]);
  }

  removeEventListener(type: string, listener: any): void {
    this.rt.eventPump.remove(this.handleId, type, listener);
    this.rt.callFireAndForget(ids.OP_REMOVE_EVENT_LISTENER, this.handleId, [type]);
  }
}

export class SyncNode extends WorkerNode {
  constructor(id: number, rt: WorkerRuntime) {
    super(id, rt);
  }

  appendChild(child: WorkerNode): WorkerNode {
    this.rt.callFireAndForget(ids.OP_NODE_APPEND_CHILD, this.handleId, [child.handleId]);
    return child;
  }

  removeChild(child: WorkerNode): WorkerNode {
    this.rt.callFireAndForget(ids.OP_NODE_REMOVE_CHILD, this.handleId, [child.handleId]);
    return child;
  }

  insertBefore(newChild: WorkerNode, refChild: WorkerNode | null): WorkerNode {
    const refHandle = refChild ? refChild.handleId : 0;
    this.rt.callFireAndForget(ids.OP_NODE_INSERT_BEFORE, this.handleId, [newChild.handleId, refHandle]);
    return newChild;
  }

  replaceChild(newChild: WorkerNode, oldChild: WorkerNode): WorkerNode {
    this.rt.callFireAndForget(ids.OP_NODE_REPLACE_CHILD, this.handleId, [newChild.handleId, oldChild.handleId]);
    return oldChild;
  }

  get textContent(): string {
    return this.rt.callSync(ids.OP_NODE_GET_TEXT_CONTENT, this.handleId, []).value as string;
  }

  set textContent(v: string) {
    this.rt.callFireAndForget(ids.OP_NODE_SET_TEXT_CONTENT, this.handleId, [v]);
  }

  get parentNode(): WorkerNode | null {
    const h = this.rt.callSync(ids.OP_NODE_GET_PARENT_NODE, this.handleId, []).value as number;
    return h === 0 ? null : getSyncNode(h, this.rt);
  }

  get parentElement(): WorkerElement | null {
    const h = this.rt.callSync(ids.OP_NODE_GET_PARENT_ELEMENT, this.handleId, []).value as number;
    return h === 0 ? null : getSyncElement(h, this.rt);
  }

  get firstChild(): WorkerNode | null {
    const h = this.rt.callSync(ids.OP_NODE_GET_FIRST_CHILD, this.handleId, []).value as number;
    return h === 0 ? null : getSyncNode(h, this.rt);
  }

  get lastChild(): WorkerNode | null {
    const h = this.rt.callSync(ids.OP_NODE_GET_LAST_CHILD, this.handleId, []).value as number;
    return h === 0 ? null : getSyncNode(h, this.rt);
  }

  get nextSibling(): WorkerNode | null {
    const h = this.rt.callSync(ids.OP_NODE_GET_NEXT_SIBLING, this.handleId, []).value as number;
    return h === 0 ? null : getSyncNode(h, this.rt);
  }

  get previousSibling(): WorkerNode | null {
    const h = this.rt.callSync(ids.OP_NODE_GET_PREVIOUS_SIBLING, this.handleId, []).value as number;
    return h === 0 ? null : getSyncNode(h, this.rt);
  }

  get childNodes(): WorkerNode[] {
    const r = this.rt.callSync(ids.OP_NODE_GET_CHILD_NODES, this.handleId, []);
    const handles = r.value as number[];
    return handles.map((h) => getSyncNode(h, this.rt));
  }

  private _nodeType: number | null = null;
  get nodeType(): number {
    if (this._nodeType !== null) return this._nodeType;
    this._nodeType = this.rt.callSync(ids.OP_NODE_GET_NODE_TYPE, this.handleId, []).value as number;
    return this._nodeType;
  }

  private _nodeName: string | null = null;
  get nodeName(): string {
    if (this._nodeName !== null) return this._nodeName;
    this._nodeName = (this.rt.callSync(ids.OP_NODE_GET_NODE_NAME, this.handleId, []).value as string) ?? "";
    return this._nodeName;
  }

  get nodeValue(): string {
    return this.rt.callSync(ids.OP_NODE_GET_NODE_VALUE, this.handleId, []).value as string;
  }

  set nodeValue(v: string) {
    this.rt.callFireAndForget(ids.OP_NODE_SET_NODE_VALUE, this.handleId, [v]);
  }

  hasChildNodes(): boolean {
    return this.rt.callSync(ids.OP_NODE_HAS_CHILD_NODES, this.handleId, []).value as boolean;
  }

  contains(other: WorkerNode): boolean {
    return this.rt.callSync(ids.OP_NODE_CONTAINS, this.handleId, [other.handleId]).value as boolean;
  }

  cloneNode(deep = false): WorkerNode {
    const r = this.rt.callSync(ids.OP_NODE_CLONE_NODE, this.handleId, [deep]);
    return getSyncNode(r.value as number, this.rt);
  }

  // ownerDocument — React accesses this for event delegation
  get ownerDocument(): WorkerDocument {
    return this.rt.document;
  }

  // Sync events — React calls addEventListener synchronously
  addEventListener(type: string, listener: any): void {
    this.rt.eventPump.add(this.handleId, type, listener);
    this.rt.callFireAndForget(ids.OP_ADD_EVENT_LISTENER, this.handleId, [type]);
  }

  removeEventListener(type: string, listener: any): void {
    this.rt.eventPump.remove(this.handleId, type, listener);
    this.rt.callFireAndForget(ids.OP_REMOVE_EVENT_LISTENER, this.handleId, [type]);
  }
}

export class SyncText extends WorkerText {
  constructor(id: number, rt: WorkerRuntime) {
    super(id, rt);
  }

  get data(): string {
    return this.rt.callSync(ids.OP_NODE_GET_DATA, this.handleId, []).value as string;
  }

  set data(v: string) {
    this.rt.callFireAndForget(ids.OP_NODE_SET_DATA, this.handleId, [v]);
  }

  get textContent(): string {
    return this.rt.callSync(ids.OP_NODE_GET_TEXT_CONTENT, this.handleId, []).value as string;
  }

  set textContent(v: string) {
    this.rt.callFireAndForget(ids.OP_NODE_SET_TEXT_CONTENT, this.handleId, [v]);
  }

  get nodeValue(): string {
    return this.rt.callSync(ids.OP_NODE_GET_NODE_VALUE, this.handleId, []).value as string;
  }

  set nodeValue(v: string) {
    this.rt.callFireAndForget(ids.OP_NODE_SET_NODE_VALUE, this.handleId, [v]);
  }
}

export class SyncComment extends WorkerComment {
  constructor(id: number, rt: WorkerRuntime) {
    super(id, rt);
  }

  get data(): string {
    return this.rt.callSync(ids.OP_NODE_GET_DATA, this.handleId, []).value as string;
  }

  set data(v: string) {
    this.rt.callFireAndForget(ids.OP_NODE_SET_DATA, this.handleId, [v]);
  }

  get textContent(): string {
    return this.rt.callSync(ids.OP_NODE_GET_TEXT_CONTENT, this.handleId, []).value as string;
  }

  set textContent(v: string) {
    this.rt.callFireAndForget(ids.OP_NODE_SET_TEXT_CONTENT, this.handleId, [v]);
  }

  get nodeValue(): string {
    return this.rt.callSync(ids.OP_NODE_GET_NODE_VALUE, this.handleId, []).value as string;
  }

  set nodeValue(v: string) {
    this.rt.callFireAndForget(ids.OP_NODE_SET_NODE_VALUE, this.handleId, [v]);
  }
}

export class SyncCSSStyleDeclaration extends WorkerCSSStyleDeclaration {
  static create(handleId: number, rt: WorkerRuntime): WorkerCSSStyleDeclaration {
    const decl = new SyncCSSStyleDeclaration(handleId, rt);
    return new Proxy(decl, {
      get(target: SyncCSSStyleDeclaration, prop: string) {
        if (prop in target) return (target as any)[prop];
        return target.rt.callSync(ids.OP_ELEMENT_GET_STYLE_PROP, target.handleId, [prop]).value as string;
      },
      set(target: SyncCSSStyleDeclaration, prop: string, value: any) {
        if (prop in target) {
          (target as any)[prop] = value;
          return true;
        }
        target.rt.callFireAndForget(ids.OP_ELEMENT_SET_STYLE_PROP, target.handleId, [prop, String(value)]);
        return true;
      },
    });
  }

  getPropertyValue(name: string): string {
    return this.rt.callSync(ids.OP_ELEMENT_GET_STYLE_PROP, this.handleId, [name]).value as string;
  }

  setProperty(name: string, value: string): void {
    this.rt.callFireAndForget(ids.OP_ELEMENT_SET_STYLE_PROP, this.handleId, [name, value]);
  }

  removeProperty(name: string): void {
    this.rt.callFireAndForget(ids.OP_ELEMENT_SET_STYLE_PROP, this.handleId, [name, ""]);
  }
}

// Cache: handle → node type. Populated by createElement/createTextNode/etc.
// and by wrapSyncNode when it has to query. This avoids a callSync round-trip
// for every uncached node during React reconciliation (which would add seconds
// of latency when opening menus).
const nodeTypeCache: Map<number, number> = new Map();

/** Cache the node type for a handle (used by SyncDocument methods). */
export function cacheNodeType(handleId: number, nodeType: number): void {
  nodeTypeCache.set(handleId, nodeType);
}

export function wrapSyncNode(handleId: number, rt: WorkerRuntime): WorkerNode {
  // Check the node type cache first — createElement/createTextNode/etc.
  // populate this, avoiding a callSync round-trip.
  const cachedType = nodeTypeCache.get(handleId);
  if (cachedType !== undefined) {
    if (cachedType === 1) return new SyncElement(handleId, rt); // ELEMENT_NODE
    if (cachedType === 3) return new SyncText(handleId, rt);    // TEXT_NODE
    if (cachedType === 8) return new SyncComment(handleId, rt); // COMMENT_NODE
    return new SyncNode(handleId, rt);
  }
  // Default to SyncElement — the vast majority of DOM nodes React creates
  // and traverses are element nodes. Text/comment nodes are created via
  // createTextNode/createComment which populate the cache. If this is wrong
  // (e.g. a text node returned by firstChild), the nodeType getter will
  // still return the correct value lazily.
  // This avoids a callSync round-trip for every uncached node, which was
  // adding several seconds of latency when opening menus.
  return new SyncElement(handleId, rt);
}

export class SyncDocument extends WorkerDocument {
  constructor(rt: WorkerRuntime) {
    super(rt);
  }

  createElement(tag: string): WorkerElement {
    const r = this.rt.callSync(ids.OP_DOCUMENT_CREATE_ELEMENT, HANDLE_DOCUMENT, [tag]);
    const h = r.value as number;
    cacheNodeType(h, 1); // ELEMENT_NODE
    return getSyncElement(h, this.rt);
  }

  createElementNS(ns: string, tag: string): WorkerElement {
    const r = this.rt.callSync(ids.OP_DOCUMENT_CREATE_ELEMENT_NS, HANDLE_DOCUMENT, [ns, tag]);
    const h = r.value as number;
    cacheNodeType(h, 1); // ELEMENT_NODE
    return getSyncElement(h, this.rt);
  }

  createTextNode(text: string): WorkerText {
    const r = this.rt.callSync(ids.OP_DOCUMENT_CREATE_TEXT_NODE, HANDLE_DOCUMENT, [text]);
    const h = r.value as number;
    cacheNodeType(h, 3); // TEXT_NODE
    return new SyncText(h, this.rt);
  }

  createComment(text: string): WorkerComment {
    const r = this.rt.callSync(ids.OP_DOCUMENT_CREATE_COMMENT, HANDLE_DOCUMENT, [text]);
    const h = r.value as number;
    cacheNodeType(h, 8); // COMMENT_NODE
    return new SyncComment(h, this.rt);
  }

  createDocumentFragment(): WorkerNode {
    const r = this.rt.callSync(ids.OP_DOCUMENT_CREATE_DOCUMENT_FRAGMENT, HANDLE_DOCUMENT, []);
    const h = r.value as number;
    cacheNodeType(h, 11); // DOCUMENT_FRAGMENT_NODE
    return new SyncNode(h, this.rt);
  }

  getElementById(id: string): WorkerElement | null {
    const h = this.rt.callSync(ids.OP_DOCUMENT_GET_ELEMENT_BY_ID, HANDLE_DOCUMENT, [id]).value as number;
    return h === 0 ? null : getSyncElement(h, this.rt);
  }

  querySelector(selector: string): WorkerElement | null {
    const h = this.rt.callSync(ids.OP_DOCUMENT_QUERY_SELECTOR, HANDLE_DOCUMENT, [selector]).value as number;
    return h === 0 ? null : getSyncElement(h, this.rt);
  }

  querySelectorAll(selector: string): WorkerElement[] {
    const r = this.rt.callSync(ids.OP_DOCUMENT_QUERY_SELECTOR_ALL, HANDLE_DOCUMENT, [selector]);
    const handles = r.value as number[];
    return handles.map((h) => getSyncElement(h, this.rt));
  }

  get documentElement(): WorkerElement {
    return getSyncElement(HANDLE_HTML, this.rt);
  }

  get head(): WorkerElement {
    return getSyncElement(HANDLE_HEAD, this.rt);
  }

  get body(): WorkerElement {
    return getSyncElement(HANDLE_BODY, this.rt);
  }

  get readyState(): string {
    return this.rt.callSync(ids.OP_DOCUMENT_GET_READY_STATE, HANDLE_DOCUMENT, []).value as string;
  }

  // Return the same SyncWindow instance the polyfill installed (with HTML
  // constructors set on it). The base class creates a new WorkerWindow each
  // time, which lacks those properties.
  get defaultView(): any {
    return this.rt.window;
  }

  // React attaches event listeners to the document (e.g. selectionchange)
  addEventListener(type: string, listener: any): void {
    this.rt.eventPump.add(HANDLE_DOCUMENT, type, listener);
    this.rt.callFireAndForget(ids.OP_ADD_EVENT_LISTENER, HANDLE_DOCUMENT, [type]);
  }

  removeEventListener(type: string, listener: any): void {
    this.rt.eventPump.remove(HANDLE_DOCUMENT, type, listener);
    this.rt.callFireAndForget(ids.OP_REMOVE_EVENT_LISTENER, HANDLE_DOCUMENT, [type]);
  }

  get nodeType(): number {
    return 9; // DOCUMENT_NODE
  }
}

export class SyncWindow extends WorkerWindow {
  constructor(rt: WorkerRuntime) {
    super(rt);
  }

  get innerWidth(): number {
    return this.rt.callSync(ids.OP_WINDOW_GET_INNER_WIDTH, HANDLE_WINDOW, []).value as number;
  }

  get innerHeight(): number {
    return this.rt.callSync(ids.OP_WINDOW_GET_INNER_HEIGHT, HANDLE_WINDOW, []).value as number;
  }

  get devicePixelRatio(): number {
    return this.rt.callSync(ids.OP_WINDOW_GET_DEVICE_PIXEL_RATIO, HANDLE_WINDOW, []).value as number;
  }
}
