import { describe, expect, it, vi } from "bun:test";
import type { RenderSurface } from "../platform/render-surface";
import { CanvasResizeWatcher } from "./canvas-resize-watcher";

// Minimal RenderSurface fake — the native NativeSurface shape: no DOM APIs,
// clientWidth/Height track the backing size, resize is delivered by
// dispatching a "resize" event.
function createMockSurface() {
  const listeners = new Map<string, Set<(e: any) => void>>();
  const surface = {
    _w: 800,
    _h: 600,
    get width() { return surface._w; },
    set width(v: number) { surface._w = v; },
    get height() { return surface._h; },
    set height(v: number) { surface._h = v; },
    get clientWidth() { return surface._w; },
    get clientHeight() { return surface._h; },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: surface._w, bottom: surface._h, width: surface._w, height: surface._h }),
    getContext: () => null,
    addEventListener: (type: string, l: (e: any) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(l);
    },
    removeEventListener: (type: string, l: (e: any) => void) => listeners.get(type)?.delete(l),
    dispatchEvent: (e: any) => { listeners.get(e.type)?.forEach((l) => l(e)); return true; },
    dispatch: (type: string) => surface.dispatchEvent({ type }),
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
  };
  return surface as RenderSurface & {
    _w: number; _h: number;
    dispatch(type: string): void;
    listenerCount(type: string): number;
  };
}

describe("CanvasResizeWatcher", () => {
  it("reports the initial size on construction", () => {
    const surface = createMockSurface();
    const onResize = vi.fn();
    new CanvasResizeWatcher(surface, { onResize });
    expect(onResize).toHaveBeenCalledWith(800, 600, 1);
  });

  it("responds to surface \"resize\" events (native path, no ResizeObserver)", () => {
    const surface = createMockSurface();
    const onResize = vi.fn();
    new CanvasResizeWatcher(surface, { onResize });
    surface.width = 1024;
    surface.height = 768;
    surface.dispatch("resize");
    expect(onResize).toHaveBeenCalledWith(1024, 768, 1);
  });

  it("stops listening after destroy", () => {
    const surface = createMockSurface();
    const onResize = vi.fn();
    const watcher = new CanvasResizeWatcher(surface, { onResize });
    watcher.destroy();
    expect(surface.listenerCount("resize")).toBe(0);
    onResize.mockClear();
    surface.dispatch("resize");
    expect(onResize).not.toHaveBeenCalled();
  });

  it("setDpr re-reports with the new ratio", () => {
    const surface = createMockSurface();
    const onResize = vi.fn();
    const watcher = new CanvasResizeWatcher(surface, { onResize });
    watcher.setDpr(2);
    expect(onResize).toHaveBeenLastCalledWith(800, 600, 2);
  });
});
