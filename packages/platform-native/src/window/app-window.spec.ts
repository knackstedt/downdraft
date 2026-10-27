// ============================================================================
// app-window.spec.ts — AppWindow registry + close-veto semantics, plus the
// NativeWindow routing for the new desktop events (closerequest / occluded /
// themechanged). Mocked NativeWindow instances (prototype objects — no
// display needed) exercise the JS layer; the Rust side is covered by the
// manual smoke harness + e2e.
// ============================================================================

import { describe, expect, it } from "bun:test";
import { AppWindow } from "./app-window";
import { NativeWindow } from "./native-window";
import {
    DD_EVENT_CLOSE_REQUEST,
    DD_EVENT_OCCLUDED,
    DD_EVENT_THEME_CHANGED,
} from "./window-ffi";

interface MockWindow extends NativeWindow {
  calls: string[];
  fire(type: string, ev?: Record<string, unknown>): void;
}

/** A NativeWindow-shaped mock — prototype methods (handleEvent) real, the
 *  constructor's FFI side-effects replaced by call recording. */
function mockWindow(handle: number): MockWindow {
  const calls: string[] = [];
  const listeners = new Map<string, Set<(e: any) => void>>();
  const w = Object.create(NativeWindow.prototype);
  Object.defineProperty(w, "windowHandle", { value: handle, writable: false });
  w.calls = calls;
  const record = (name: string) => (...args: unknown[]) => {
    calls.push(`${name}(${args.join(",")})`);
  };
  w.setCloseIntercept = (on: boolean) => calls.push(`setCloseIntercept(${on})`);
  w.setWindowVisible = (v: boolean) => calls.push(`setWindowVisible(${v})`);
  w.setTitle = (t: string) => calls.push(`setTitle(${t})`);
  w.requestQuit = () => calls.push("requestQuit()");
  w.destroy = () => calls.push("destroy()");
  w.addEventListener = (type: string, fn: any) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(fn);
  };
  w.removeEventListener = (type: string, fn: any) => {
    listeners.get(type)?.delete(fn);
  };
  // Simplified MiniEventTarget: synchronous listeners, preventDefault flag
  // honored on plain-object events.
  w.dispatchEvent = (ev: any) => {
    if (ev && typeof ev === "object" && ev.defaultPrevented === undefined) {
      ev.defaultPrevented = false;
      const orig = ev.preventDefault?.bind(ev);
      ev.preventDefault = () => { ev.defaultPrevented = true; orig?.(); };
    }
    listeners.get(ev.type)?.forEach((fn) => fn(ev));
    return true;
  };
  w.fire = (type: string, ev: Record<string, unknown> = {}) => w.dispatchEvent({ type, ...ev });
  // Private at compile time, reachable at runtime — the real routing code.
  w.handleEvent = NativeWindow.prototype["handleEvent" as never];
  return w as MockWindow;
}

function routeNative(w: MockWindow, eventType: number, slots: Partial<Record<number, number>> = {}): void {
  const ints = new Int32Array(16);
  for (const [k, v] of Object.entries(slots)) ints[Number(k)] = v!;
  (w as any).handleEvent(eventType, ints, new Float32Array(ints.buffer));
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("AppWindow", () => {
  it("wraps one AppWindow per NativeWindow handle", () => {
    const n1 = mockWindow(7);
    const n2 = mockWindow(8);
    expect(AppWindow.of(n1)).toBe(AppWindow.of(n1));
    expect(AppWindow.of(n2)).not.toBe(AppWindow.of(n1));
    expect(AppWindow.of(n1).id).toBe(7);
    expect(AppWindow.of(n1).isPrimary).toBe(false);
  });

  it("list()/primary() read the shared handle registry", () => {
    const primary = mockWindow(0);
    const aux = mockWindow(3);
    const registry = (NativeWindow as any).byHandle as Map<number, NativeWindow>;
    registry.set(0, primary);
    registry.set(3, aux);
    try {
      expect(AppWindow.primary()!.native).toBe(primary);
      expect(AppWindow.primary()!.isPrimary).toBe(true);
      expect(AppWindow.list().map((w) => w.id).sort()).toEqual([0, 3]);
    } finally {
      registry.delete(0);
      registry.delete(3);
    }
  });

  it("delegates controls to the NativeWindow", () => {
    const n = mockWindow(4);
    const w = AppWindow.of(n);
    w.setTitle("Hello");
    w.setVisible(false);
    expect(n.calls).toContain("setTitle(Hello)");
    expect(n.calls).toContain("setWindowVisible(false)");
  });
});

describe("closerequest veto", () => {
  it("unarmed close path: no listener → close proceeds", () => {
    const n = mockWindow(0);
    routeNative(n, DD_EVENT_CLOSE_REQUEST);
    // Primary close = requestQuit (the normal quit path).
    expect(n.calls).toContain("requestQuit()");
  });

  it("preventDefault vetoes — window stays mapped", () => {
    const n = mockWindow(0);
    n.addEventListener("closerequest", (e: any) => e.preventDefault());
    routeNative(n, DD_EVENT_CLOSE_REQUEST);
    expect(n.calls).not.toContain("requestQuit()");
    expect(n.calls).not.toContain("destroy()");
  });

  it("explicit close policy: unvetoed request hides instead of quitting", () => {
    const n = mockWindow(0);
    n.closePolicy = "explicit";
    routeNative(n, DD_EVENT_CLOSE_REQUEST);
    expect(n.calls).toContain("setWindowVisible(false)");
    expect(n.calls).not.toContain("requestQuit()");
  });

  it("explicit policy still honors a synchronous veto", () => {
    const n = mockWindow(0);
    n.closePolicy = "explicit";
    n.addEventListener("closerequest", (e: any) => e.preventDefault());
    routeNative(n, DD_EVENT_CLOSE_REQUEST);
    expect(n.calls).not.toContain("setWindowVisible(false)");
    expect(n.calls).not.toContain("requestQuit()");
  });

  it("secondary window close() dispatches close + destroys, no quit", () => {
    const n = mockWindow(5);
    let sawClose = false;
    n.addEventListener("close", () => { sawClose = true; });
    routeNative(n, DD_EVENT_CLOSE_REQUEST);
    expect(sawClose).toBe(true);
    expect(n.calls).toContain("destroy()");
    expect(n.calls).not.toContain("requestQuit()");
  });

  it("onCloseRequest arms the intercept; false veto → no close", async () => {
    const n = mockWindow(0);
    const w = AppWindow.of(n);
    w.onCloseRequest(() => false);
    expect(n.calls).toContain("setCloseIntercept(true)");
    routeNative(n, DD_EVENT_CLOSE_REQUEST);
    await tick();
    expect(n.calls).not.toContain("requestQuit()");
  });

  it("onCloseRequest accept → close proceeds (async)", async () => {
    const n = mockWindow(0);
    const w = AppWindow.of(n);
    w.onCloseRequest(async () => true);
    routeNative(n, DD_EVENT_CLOSE_REQUEST);
    await tick();
    expect(n.calls).toContain("requestQuit()");
  });

  it("unsubscribed handler leaves the default close path intact", async () => {
    const n = mockWindow(0);
    const w = AppWindow.of(n);
    const off = w.onCloseRequest(() => false);
    off();
    routeNative(n, DD_EVENT_CLOSE_REQUEST);
    await tick();
    expect(n.calls).toContain("requestQuit()");
  });
});

describe("new event routing", () => {
  it("DD_EVENT_OCCLUDED dispatches occluded with the state", () => {
    const n = mockWindow(0);
    const seen: boolean[] = [];
    n.addEventListener("occluded", (e: any) => seen.push(e.occluded));
    routeNative(n, DD_EVENT_OCCLUDED, { 0: 1 });
    routeNative(n, DD_EVENT_OCCLUDED, { 0: 0 });
    expect(seen).toEqual([true, false]);
  });

  it("DD_EVENT_THEME_CHANGED maps codes to theme names", () => {
    const n = mockWindow(0);
    const seen: string[] = [];
    n.addEventListener("themechanged", (e: any) => seen.push(e.theme));
    routeNative(n, DD_EVENT_THEME_CHANGED, { 0: 1 });
    routeNative(n, DD_EVENT_THEME_CHANGED, { 0: 2 });
    routeNative(n, DD_EVENT_THEME_CHANGED, { 0: 0 });
    expect(seen).toEqual(["light", "dark", "unknown"]);
  });
});
