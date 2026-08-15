// ============================================================================
// handle-table — main-thread id ↔ Node map with a free-list for recycling.
//
// Reserved handles (document, window, html, head, body) are allocated at init
// and never recycled. Worker releases (OP_RELEASE) return ids to the free-list.
// ============================================================================

import {
    HANDLE_BODY,
    HANDLE_DOCUMENT,
    HANDLE_FIRST_FREE,
    HANDLE_HEAD,
    HANDLE_HTML,
    HANDLE_NULL,
    HANDLE_WINDOW,
} from "../shared/protocol";

export class HandleTable {
  private readonly nodes: Map<number, Node> = new Map();
  private readonly freeList: number[] = [];
  private nextId: number = HANDLE_FIRST_FREE;

  constructor() {}

  /** Reserve the low handles for document/window/html/head/body. */
  initReserved(document: Document, window: Window): void {
    this.nodes.set(HANDLE_DOCUMENT, document);
    this.nodes.set(HANDLE_WINDOW, window as unknown as Node);
    this.nodes.set(HANDLE_HTML, document.documentElement);
    this.nodes.set(HANDLE_HEAD, document.head);
    this.nodes.set(HANDLE_BODY, document.body);
  }

  /** Allocate a handle for a real DOM node. Returns the integer handle. */
  alloc(node: Node): number {
    // Dedup: if this exact node already has a handle, return it.
    for (const [id, n] of this.nodes) {
      if (n === node) return id;
    }
    let id: number;
    if (this.freeList.length > 0) {
      id = this.freeList.pop()!;
    } else {
      id = this.nextId++;
    }
    this.nodes.set(id, node);
    // Tag the DOM node so the event dispatcher can find its handle from e.target
    try { (node as any)._undertowHandle = id; } catch { /* read-only */ }
    return id;
  }

  /** Resolve a handle to its real DOM node, or null. */
  resolve(handle: number): Node | null {
    if (handle === HANDLE_NULL) return null;
    return this.nodes.get(handle) ?? null;
  }

  /** Release a handle back to the free-list. No-op for reserved handles. */
  release(handle: number): void {
    if (handle < HANDLE_FIRST_FREE) return; // reserved
    if (this.nodes.delete(handle)) {
      this.freeList.push(handle);
    }
  }

  /** Bulk release (for batched OP_RELEASE from the worker). */
  releaseBatch(handles: number[]): void {
    for (const h of handles) this.release(h);
  }

  /** Number of live handles (for stats / GC pressure monitoring). */
  size(): number {
    return this.nodes.size;
  }
}
