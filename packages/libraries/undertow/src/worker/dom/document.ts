// ============================================================================
// WorkerDocument — worker-side proxy for the DOM Document.
// ============================================================================

import * as ids from "../../shared/op-ids";
import { HANDLE_BODY, HANDLE_DOCUMENT, HANDLE_HEAD, HANDLE_HTML } from "../../shared/protocol";
import { Handle } from "../handle";
import type { WorkerRuntime } from "../runtime";
import { WorkerElement } from "./element";
import { WorkerNode } from "./node";
import { WorkerComment, WorkerText } from "./text";

export class WorkerDocument extends Handle {
  constructor(rt: WorkerRuntime) {
    super(HANDLE_DOCUMENT, rt);
  }

  async createElement(tag: string): Promise<WorkerElement> {
    const r = await this.rt.call(ids.OP_DOCUMENT_CREATE_ELEMENT, HANDLE_DOCUMENT, [tag]);
    return new WorkerElement(r.value as number, this.rt);
  }

  async createElementNS(ns: string, tag: string): Promise<WorkerElement> {
    const r = await this.rt.call(ids.OP_DOCUMENT_CREATE_ELEMENT_NS, HANDLE_DOCUMENT, [ns, tag]);
    return new WorkerElement(r.value as number, this.rt);
  }

  async createTextNode(text: string): Promise<WorkerText> {
    const r = await this.rt.call(ids.OP_DOCUMENT_CREATE_TEXT_NODE, HANDLE_DOCUMENT, [text]);
    return new WorkerText(r.value as number, this.rt);
  }

  async createComment(text: string): Promise<WorkerComment> {
    const r = await this.rt.call(ids.OP_DOCUMENT_CREATE_COMMENT, HANDLE_DOCUMENT, [text]);
    return new WorkerComment(r.value as number, this.rt);
  }

  async createDocumentFragment(): Promise<WorkerNode> {
    const r = await this.rt.call(ids.OP_DOCUMENT_CREATE_DOCUMENT_FRAGMENT, HANDLE_DOCUMENT, []);
    return new WorkerNode(r.value as number, this.rt);
  }

  async getElementById(id: string): Promise<WorkerElement | null> {
    const r = await this.rt.call(ids.OP_DOCUMENT_GET_ELEMENT_BY_ID, HANDLE_DOCUMENT, [id]);
    const h = r.value as number;
    return h === 0 ? null : new WorkerElement(h, this.rt);
  }

  async querySelector(selector: string): Promise<WorkerElement | null> {
    const r = await this.rt.call(ids.OP_DOCUMENT_QUERY_SELECTOR, HANDLE_DOCUMENT, [selector]);
    const h = r.value as number;
    return h === 0 ? null : new WorkerElement(h, this.rt);
  }

  async querySelectorAll(selector: string): Promise<WorkerElement[]> {
    const r = await this.rt.call(ids.OP_DOCUMENT_QUERY_SELECTOR_ALL, HANDLE_DOCUMENT, [selector]);
    const handles = r.value as number[];
    return handles.map((h) => new WorkerElement(h, this.rt));
  }

  get documentElement(): WorkerElement {
    return new WorkerElement(HANDLE_HTML, this.rt);
  }

  get head(): WorkerElement {
    return new WorkerElement(HANDLE_HEAD, this.rt);
  }

  get body(): WorkerElement {
    return new WorkerElement(HANDLE_BODY, this.rt);
  }

  get readyState(): Promise<string> {
    return this.rt.call(ids.OP_DOCUMENT_GET_READY_STATE, HANDLE_DOCUMENT, []).then((r) => r.value as string);
  }

  get visibilityState(): Promise<string> {
    return this.rt.call(ids.OP_DOCUMENT_GET_VISIBILITY_STATE, HANDLE_DOCUMENT, []).then((r) => r.value as string);
  }

  get defaultView(): WorkerWindow {
    return new WorkerWindow(this.rt);
  }
}

// Avoid circular import — import WorkerWindow lazily.
import { WorkerWindow } from "./window";
