// ============================================================================
// WorkerElement — worker-side proxy for a DOM Element. Extends WorkerNode
// with element-specific methods (attributes, classList, style, etc.).
// ============================================================================

import * as ids from "../../shared/op-ids";
import type { WorkerRuntime } from "../runtime";
import { WorkerCSSStyleDeclaration } from "./css-style-declaration";
import { WorkerNode } from "./node";

export class WorkerElement extends WorkerNode {
  private _style: WorkerCSSStyleDeclaration | null = null;

  constructor(id: number, rt: WorkerRuntime) {
    super(id, rt);
  }

  // --- Attributes ---
  async setAttribute(name: string, value: string): Promise<void> {
    await this.rt.call(ids.OP_ELEMENT_SET_ATTRIBUTE, this.handleId, [name, value]);
  }

  async getAttribute(name: string): Promise<string> {
    const r = await this.rt.call(ids.OP_ELEMENT_GET_ATTRIBUTE, this.handleId, [name]);
    return r.value as string;
  }

  async removeAttribute(name: string): Promise<void> {
    await this.rt.call(ids.OP_ELEMENT_REMOVE_ATTRIBUTE, this.handleId, [name]);
  }

  async hasAttribute(name: string): Promise<boolean> {
    const r = await this.rt.call(ids.OP_ELEMENT_HAS_ATTRIBUTE, this.handleId, [name]);
    return r.value as boolean;
  }

  async setAttributeNS(ns: string, name: string, value: string): Promise<void> {
    await this.rt.call(ids.OP_ELEMENT_SET_ATTRIBUTE_NS, this.handleId, [ns, name, value]);
  }

  async getAttributeNS(ns: string, name: string): Promise<string> {
    const r = await this.rt.call(ids.OP_ELEMENT_GET_ATTRIBUTE_NS, this.handleId, [ns, name]);
    return r.value as string;
  }

  async removeAttributeNS(ns: string, name: string): Promise<void> {
    await this.rt.call(ids.OP_ELEMENT_REMOVE_ATTRIBUTE_NS, this.handleId, [ns, name]);
  }

  // --- Properties ---
  get tagName(): Promise<string> {
    return this.rt.call(ids.OP_ELEMENT_GET_TAG_NAME, this.handleId, []).then((r) => r.value as string);
  }

  get id(): Promise<string> {
    return this.rt.call(ids.OP_ELEMENT_GET_ID, this.handleId, []).then((r) => r.value as string);
  }

  set id(v: string) {
    this.rt.call(ids.OP_ELEMENT_SET_ID, this.handleId, [v]);
  }

  get className(): Promise<string> {
    return this.rt.call(ids.OP_ELEMENT_GET_CLASS_NAME, this.handleId, []).then((r) => r.value as string);
  }

  set className(v: string) {
    this.rt.call(ids.OP_ELEMENT_SET_CLASS_NAME, this.handleId, [v]);
  }

  // --- style proxy ---
  get style(): WorkerCSSStyleDeclaration {
    if (!this._style) {
      this._style = WorkerCSSStyleDeclaration.create(this.handleId, this.rt);
    }
    return this._style;
  }

  // --- classList proxy ---
  get classList(): {
    add: (...tokens: string[]) => void;
    remove: (...tokens: string[]) => void;
    toggle: (token: string) => Promise<boolean>;
    contains: (token: string) => Promise<boolean>;
  } {
    const rt = this.rt;
    const handleId = this.handleId;
    return {
      add: (...tokens: string[]) => {
        for (const t of tokens) rt.call(ids.OP_ELEMENT_CLASS_LIST_ADD, handleId, [t]);
      },
      remove: (...tokens: string[]) => {
        for (const t of tokens) rt.call(ids.OP_ELEMENT_CLASS_LIST_REMOVE, handleId, [t]);
      },
      toggle: async (token: string): Promise<boolean> => {
        const r = await rt.call(ids.OP_ELEMENT_CLASS_LIST_TOGGLE, handleId, [token]);
        return r.value as boolean;
      },
      contains: async (token: string): Promise<boolean> => {
        const r = await rt.call(ids.OP_ELEMENT_CLASS_LIST_CONTAINS, handleId, [token]);
        return r.value as boolean;
      },
    };
  }

  // --- innerHTML / outerHTML ---
  get innerHTML(): Promise<string> {
    return this.rt.call(ids.OP_ELEMENT_GET_INNER_HTML, this.handleId, []).then((r) => r.value as string);
  }

  set innerHTML(v: string) {
    this.rt.call(ids.OP_ELEMENT_SET_INNER_HTML, this.handleId, [v]);
  }

  get outerHTML(): Promise<string> {
    return this.rt.call(ids.OP_ELEMENT_GET_OUTER_HTML, this.handleId, []).then((r) => r.value as string);
  }

  // --- Querying ---
  async querySelector(selector: string): Promise<WorkerElement | null> {
    const r = await this.rt.call(ids.OP_ELEMENT_QUERY_SELECTOR, this.handleId, [selector]);
    const h = r.value as number;
    return h === 0 ? null : new WorkerElement(h, this.rt);
  }

  async querySelectorAll(selector: string): Promise<WorkerElement[]> {
    const r = await this.rt.call(ids.OP_ELEMENT_QUERY_SELECTOR_ALL, this.handleId, [selector]);
    const handles = r.value as number[];
    return handles.map((h) => new WorkerElement(h, this.rt));
  }

  async closest(selector: string): Promise<WorkerElement | null> {
    const r = await this.rt.call(ids.OP_ELEMENT_CLOSEST, this.handleId, [selector]);
    const h = r.value as number;
    return h === 0 ? null : new WorkerElement(h, this.rt);
  }

  async matches(selector: string): Promise<boolean> {
    const r = await this.rt.call(ids.OP_ELEMENT_MATCHES, this.handleId, [selector]);
    return r.value as boolean;
  }

  // --- Layout ---
  get clientWidth(): Promise<number> {
    return this.rt.call(ids.OP_ELEMENT_GET_CLIENT_WIDTH, this.handleId, []).then((r) => r.value as number);
  }

  get clientHeight(): Promise<number> {
    return this.rt.call(ids.OP_ELEMENT_GET_CLIENT_HEIGHT, this.handleId, []).then((r) => r.value as number);
  }

  get offsetWidth(): Promise<number> {
    return this.rt.call(ids.OP_ELEMENT_GET_OFFSET_WIDTH, this.handleId, []).then((r) => r.value as number);
  }

  get offsetHeight(): Promise<number> {
    return this.rt.call(ids.OP_ELEMENT_GET_OFFSET_HEIGHT, this.handleId, []).then((r) => r.value as number);
  }

  get scrollTop(): Promise<number> {
    return this.rt.call(ids.OP_ELEMENT_GET_SCROLL_TOP, this.handleId, []).then((r) => r.value as number);
  }

  set scrollTop(v: number) {
    this.rt.call(ids.OP_ELEMENT_SET_SCROLL_TOP, this.handleId, [v]);
  }

  get scrollLeft(): Promise<number> {
    return this.rt.call(ids.OP_ELEMENT_GET_SCROLL_LEFT, this.handleId, []).then((r) => r.value as number);
  }

  set scrollLeft(v: number) {
    this.rt.call(ids.OP_ELEMENT_SET_SCROLL_LEFT, this.handleId, [v]);
  }

  get scrollHeight(): Promise<number> {
    return this.rt.call(ids.OP_ELEMENT_GET_SCROLL_HEIGHT, this.handleId, []).then((r) => r.value as number);
  }

  async getBoundingClientRect(): Promise<{ x: number; y: number; width: number; height: number; top: number; left: number; bottom: number; right: number }> {
    const r = await this.rt.call(ids.OP_ELEMENT_GET_BOUNDING_CLIENT_RECT, this.handleId, []);
    return r.value as any;
  }

  // --- Element methods ---
  async focus(): Promise<void> {
    await this.rt.call(ids.OP_ELEMENT_FOCUS, this.handleId, []);
  }

  async blur(): Promise<void> {
    await this.rt.call(ids.OP_ELEMENT_BLUR, this.handleId, []);
  }

  async click(): Promise<void> {
    await this.rt.call(ids.OP_ELEMENT_CLICK, this.handleId, []);
  }

  async scrollIntoView(arg?: boolean): Promise<void> {
    await this.rt.call(ids.OP_ELEMENT_SCROLL_INTO_VIEW, this.handleId, [arg ?? true]);
  }

  async remove(): Promise<void> {
    await this.rt.call(ids.OP_ELEMENT_REMOVE, this.handleId, []);
  }

  // --- children ---
  get children(): Promise<WorkerElement[]> {
    return this.rt.call(ids.OP_ELEMENT_GET_CHILDREN, this.handleId, []).then((r) => {
      const handles = r.value as number[];
      return handles.map((h) => new WorkerElement(h, this.rt));
    });
  }

  get childElementCount(): Promise<number> {
    return this.rt.call(ids.OP_ELEMENT_GET_CHILD_ELEMENT_COUNT, this.handleId, []).then((r) => r.value as number);
  }
}
