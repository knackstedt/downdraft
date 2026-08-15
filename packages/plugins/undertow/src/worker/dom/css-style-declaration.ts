// ============================================================================
// WorkerCSSStyleDeclaration — worker-side proxy for CSSStyleDeclaration.
// Returned by element.style. Forwards property get/set to the main thread
// via OP_ELEMENT_GET_STYLE_PROP / OP_ELEMENT_SET_STYLE_PROP.
//
// React sets styles via element.style.setProperty(name, value) or direct
// property access like element.style.color = "red". Both paths are supported.
// ============================================================================

import * as ids from "../../shared/op-ids";
import type { WorkerRuntime } from "../runtime";

export class WorkerCSSStyleDeclaration {
  protected readonly rt: WorkerRuntime;
  protected readonly handleId: number;

  constructor(handleId: number, rt: WorkerRuntime) {
    this.handleId = handleId;
    this.rt = rt;
  }

  getPropertyValue(name: string): Promise<string> {
    return this.rt.call(ids.OP_ELEMENT_GET_STYLE_PROP, this.handleId, [name]).then((r) => r.value as string);
  }

  setProperty(name: string, value: string): Promise<void> {
    return this.rt.call(ids.OP_ELEMENT_SET_STYLE_PROP, this.handleId, [name, value]).then(() => undefined);
  }

  removeProperty(name: string): Promise<void> {
    // Setting to empty string effectively removes.
    return this.rt.call(ids.OP_ELEMENT_SET_STYLE_PROP, this.handleId, [name, ""]).then(() => undefined);
  }

  get cssText(): Promise<string> {
    return this.rt.call(ids.OP_ELEMENT_GET_STYLE_CSS_TEXT, this.handleId, []).then((r) => r.value as string);
  }

  set cssText(v: string) {
    this.rt.call(ids.OP_ELEMENT_SET_STYLE_CSS_TEXT, this.handleId, [v]);
  }

  get length(): number {
    // We don't know the length without a round-trip. Return 0 for now —
    // React doesn't typically iterate style.length.
    return 0;
  }

  // Proxy: element.style.color = "red" → setProperty("color", "red")
  // element.style.color → getPropertyValue("color")
  // This uses a Proxy to support arbitrary CSS property names.
  static create(handleId: number, rt: WorkerRuntime): WorkerCSSStyleDeclaration {
    const decl = new WorkerCSSStyleDeclaration(handleId, rt);
    return new Proxy(decl, {
      get(target, prop: string) {
        if (prop in target) return (target as any)[prop];
        // CSS property access — return a Promise (async read).
        return target.getPropertyValue(prop);
      },
      set(target, prop: string, value: any) {
        if (prop in target) {
          (target as any)[prop] = value;
          return true;
        }
        // CSS property write — fire-and-forget.
        target.setProperty(prop, String(value));
        return true;
      },
    });
  }
}
