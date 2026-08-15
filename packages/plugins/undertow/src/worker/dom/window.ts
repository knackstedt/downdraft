// ============================================================================
// WorkerWindow — worker-side proxy for the DOM Window.
// ============================================================================

import * as ids from "../../shared/op-ids";
import { HANDLE_WINDOW } from "../../shared/protocol";
import type { EventListener } from "../event-pump";
import { Handle } from "../handle";
import type { WorkerRuntime } from "../runtime";
import { WorkerElement } from "./element";

export class WorkerWindow extends Handle {
  constructor(rt: WorkerRuntime) {
    super(HANDLE_WINDOW, rt);
  }

  get innerWidth(): Promise<number> {
    return this.rt.call(ids.OP_WINDOW_GET_INNER_WIDTH, HANDLE_WINDOW, []).then((r) => r.value as number);
  }

  get innerHeight(): Promise<number> {
    return this.rt.call(ids.OP_WINDOW_GET_INNER_HEIGHT, HANDLE_WINDOW, []).then((r) => r.value as number);
  }

  get devicePixelRatio(): Promise<number> {
    return this.rt.call(ids.OP_WINDOW_GET_DEVICE_PIXEL_RATIO, HANDLE_WINDOW, []).then((r) => r.value as number);
  }

  get scrollX(): Promise<number> {
    return this.rt.call(ids.OP_WINDOW_GET_SCROLL_X, HANDLE_WINDOW, []).then((r) => r.value as number);
  }

  get scrollY(): Promise<number> {
    return this.rt.call(ids.OP_WINDOW_GET_SCROLL_Y, HANDLE_WINDOW, []).then((r) => r.value as number);
  }

  async scrollTo(x: number, y: number): Promise<void> {
    await this.rt.call(ids.OP_WINDOW_SCROLL_TO, HANDLE_WINDOW, [x, y]);
  }

  // --- requestAnimationFrame ---
  // The worker's rAF is proxied to the main thread. When the main thread's
  // rAF fires, it sends a reply to the worker. The polyfill wraps this in
  // a callback system.
  requestAnimationFrame(callback: (time: number) => void): number {
    return this.rt.requestAnimationFrame(callback);
  }

  cancelAnimationFrame(id: number): void {
    this.rt.cancelAnimationFrame(id);
  }

  // --- Events ---
  addEventListener(type: string, listener: EventListener): void {
    this.rt.eventPump.add(HANDLE_WINDOW, type, listener);
    this.rt.callFireAndForget(ids.OP_WINDOW_ADD_EVENT_LISTENER, HANDLE_WINDOW, [type]);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.rt.eventPump.remove(HANDLE_WINDOW, type, listener);
    this.rt.callFireAndForget(ids.OP_WINDOW_REMOVE_EVENT_LISTENER, HANDLE_WINDOW, [type]);
  }

  // --- getComputedStyle ---
  async getComputedStyle(el: WorkerElement): Promise<Record<string, string>> {
    const r = await this.rt.call(ids.OP_WINDOW_GET_COMPUTED_STYLE, HANDLE_WINDOW, [el.handleId]);
    return r.value as Record<string, string>;
  }
}
