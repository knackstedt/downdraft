// ============================================================================
// WorkerNode — worker-side proxy for a DOM Node. Base class for WorkerElement,
// WorkerText, WorkerComment. Each method encodes an op and awaits the reply.
//
// React's reconciler calls these methods synchronously. To support that,
// fire-and-forget setters use the runtime's sync-call mode where available.
// Getters return Promises — React's async reconciler (React 18+ concurrent
// mode) can handle these, but the classic sync reconciler needs the polyfill
// to buffer calls and flush them in batches.
// ============================================================================

import * as ids from "../../shared/op-ids";
import type { EventListener } from "../event-pump";
import { Handle } from "../handle";
import type { WorkerRuntime } from "../runtime";

// Node type constants (matching the DOM spec)
export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;
export const COMMENT_NODE = 8;
export const DOCUMENT_NODE = 9;
export const DOCUMENT_FRAGMENT_NODE = 11;

export class WorkerNode extends Handle {
  constructor(id: number, rt: WorkerRuntime) {
    super(id, rt);
  }

  // --- Tree mutation ---
  async appendChild(child: WorkerNode): Promise<WorkerNode> {
    const r = await this.rt.call(ids.OP_NODE_APPEND_CHILD, this.handleId, [child.handleId]);
    return wrapNode(r.value as number, this.rt);
  }

  async removeChild(child: WorkerNode): Promise<WorkerNode> {
    const r = await this.rt.call(ids.OP_NODE_REMOVE_CHILD, this.handleId, [child.handleId]);
    return wrapNode(r.value as number, this.rt);
  }

  async insertBefore(newChild: WorkerNode, refChild: WorkerNode | null): Promise<WorkerNode> {
    const refHandle = refChild ? refChild.handleId : 0;
    const r = await this.rt.call(ids.OP_NODE_INSERT_BEFORE, this.handleId, [newChild.handleId, refHandle]);
    return wrapNode(r.value as number, this.rt);
  }

  async replaceChild(newChild: WorkerNode, oldChild: WorkerNode): Promise<WorkerNode> {
    const r = await this.rt.call(ids.OP_NODE_REPLACE_CHILD, this.handleId, [newChild.handleId, oldChild.handleId]);
    return wrapNode(r.value as number, this.rt);
  }

  async hasChildNodes(): Promise<boolean> {
    const r = await this.rt.call(ids.OP_NODE_HAS_CHILD_NODES, this.handleId, []);
    return r.value as boolean;
  }

  async contains(other: WorkerNode): Promise<boolean> {
    const r = await this.rt.call(ids.OP_NODE_CONTAINS, this.handleId, [other.handleId]);
    return r.value as boolean;
  }

  async cloneNode(deep = false): Promise<WorkerNode> {
    const r = await this.rt.call(ids.OP_NODE_CLONE_NODE, this.handleId, [deep]);
    return wrapNode(r.value as number, this.rt);
  }

  // --- Tree traversal (getters return Promises) ---
  get parentNode(): Promise<WorkerNode | null> {
    return this.rt.call(ids.OP_NODE_GET_PARENT_NODE, this.handleId, []).then((r) => {
      const h = r.value as number;
      return h === 0 ? null : wrapNode(h, this.rt);
    });
  }

  async getParentNode(): Promise<WorkerNode | null> {
    const r = await this.rt.call(ids.OP_NODE_GET_PARENT_NODE, this.handleId, []);
    const h = r.value as number;
    return h === 0 ? null : wrapNode(h, this.rt);
  }

  get parentElement(): Promise<WorkerNode | null> {
    return this.rt.call(ids.OP_NODE_GET_PARENT_ELEMENT, this.handleId, []).then((r) => {
      const h = r.value as number;
      return h === 0 ? null : wrapNode(h, this.rt);
    });
  }

  get firstChild(): Promise<WorkerNode | null> {
    return this.rt.call(ids.OP_NODE_GET_FIRST_CHILD, this.handleId, []).then((r) => {
      const h = r.value as number;
      return h === 0 ? null : wrapNode(h, this.rt);
    });
  }

  get lastChild(): Promise<WorkerNode | null> {
    return this.rt.call(ids.OP_NODE_GET_LAST_CHILD, this.handleId, []).then((r) => {
      const h = r.value as number;
      return h === 0 ? null : wrapNode(h, this.rt);
    });
  }

  get nextSibling(): Promise<WorkerNode | null> {
    return this.rt.call(ids.OP_NODE_GET_NEXT_SIBLING, this.handleId, []).then((r) => {
      const h = r.value as number;
      return h === 0 ? null : wrapNode(h, this.rt);
    });
  }

  get previousSibling(): Promise<WorkerNode | null> {
    return this.rt.call(ids.OP_NODE_GET_PREVIOUS_SIBLING, this.handleId, []).then((r) => {
      const h = r.value as number;
      return h === 0 ? null : wrapNode(h, this.rt);
    });
  }

  get childNodes(): Promise<WorkerNode[]> {
    return this.rt.call(ids.OP_NODE_GET_CHILD_NODES, this.handleId, []).then((r) => {
      const handles = r.value as number[];
      return handles.map((h) => wrapNode(h, this.rt));
    });
  }

  // --- Node properties ---
  get nodeType(): Promise<number> {
    return this.rt.call(ids.OP_NODE_GET_NODE_TYPE, this.handleId, []).then((r) => r.value as number);
  }

  get nodeName(): Promise<string> {
    return this.rt.call(ids.OP_NODE_GET_NODE_NAME, this.handleId, []).then((r) => r.value as string);
  }

  get nodeValue(): Promise<string> {
    return this.rt.call(ids.OP_NODE_GET_NODE_VALUE, this.handleId, []).then((r) => r.value as string);
  }

  set nodeValue(v: string) {
    this.rt.call(ids.OP_NODE_SET_NODE_VALUE, this.handleId, [v]);
  }

  get textContent(): Promise<string> {
    return this.rt.call(ids.OP_NODE_GET_TEXT_CONTENT, this.handleId, []).then((r) => r.value as string);
  }

  set textContent(v: string) {
    this.rt.call(ids.OP_NODE_SET_TEXT_CONTENT, this.handleId, [v]);
  }

  // Explicit async versions (for code that prefers await over getter)
  async getTextContent(): Promise<string> {
    const r = await this.rt.call(ids.OP_NODE_GET_TEXT_CONTENT, this.handleId, []);
    return r.value as string;
  }

  async setTextContent(text: string): Promise<void> {
    await this.rt.call(ids.OP_NODE_SET_TEXT_CONTENT, this.handleId, [text]);
  }

  // --- Events ---
  async addEventListener(type: string, listener: EventListener): Promise<void> {
    this.rt.eventPump.add(this.handleId, type, listener);
    await this.rt.call(ids.OP_ADD_EVENT_LISTENER, this.handleId, [type]);
  }

  async removeEventListener(type: string, listener: EventListener): Promise<void> {
    this.rt.eventPump.remove(this.handleId, type, listener);
    await this.rt.call(ids.OP_REMOVE_EVENT_LISTENER, this.handleId, [type]);
  }

  async dispatchEvent(event: { type: string; bubbles?: boolean; cancelable?: boolean }): Promise<boolean> {
    const r = await this.rt.call(ids.OP_NODE_DISPATCH_EVENT, this.handleId, [event]);
    return r.value as boolean;
  }
}

/**
 * Wrap a handle in the appropriate WorkerNode subclass based on node type.
 * Since we can't know the type without a round-trip, we default to WorkerNode.
 * The polyfill can override this if it has cached the node type.
 */
export function wrapNode(handleId: number, rt: WorkerRuntime): WorkerNode {
  // Avoid importing WorkerElement at module load (circular dep).
  // The polyfill patches this function to return the right subclass.
  return new WorkerNode(handleId, rt);
}
