// ============================================================================
// game-ui — game-facing mount layer over the imui stack.
//
// `GameRenderer` already owns the low-level lifecycle (UIRenderer, UIRoot,
// LayoutEngine, UIInputRouter). This module is the canonical way for a game
// to mount its UI: `renderer.useRendererModule(createGameUi({ build }))`.
//
// - `build(ui)` runs once at module registration; construct the element
//   tree under `ui.root` there.
// - `ui.onUpdate(fn)` registers per-frame state sync — runs at the
//   `afterViewports` phase, right before UI drawables are collected, so
//   mutations (text, visible, positions) land in the same frame.
// - `ui.bind(store, selector, apply)` wires a subscribe-style store
//   (zustand-shaped: `getState` + `subscribe`) to an element mutation.
//   Poll-style sync via `onUpdate` is equally fine — use whichever fits
//   the data source.
// - The mounted container is `pointerThrough` so non-hit canvas areas fall
//   through to game input. Size interactive children tightly.
// ============================================================================

import { resourceToken } from "../ecs/resource";
import type {
    FrameHook,
    FramePhase,
    RendererModule,
    ResizeHook,
} from "../module/renderer-module";
import type { UIElement } from "./element";
import { UIPanel } from "./element";

/** Minimal subscribe-style store shape (zustand-compatible). */
export interface UISubscribable<S> {
  getState(): S;
  subscribe(listener: (state: S, prev: S) => void): () => void;
}

export interface GameUiContext {
  /** Full-screen, hit-transparent container mounted under the `UIRoot`. */
  readonly root: UIPanel;
  /** Find a descendant element by `name` (set `el.name` in `build`). */
  find<T extends UIElement>(name: string): T | undefined;
  /** Per-frame sync hook, dispatched at `afterViewports` before UI draw. */
  onUpdate(fn: (dt: number, elapsedTime: number) => void): void;
  /** Raw frame-phase hook for unusual timing needs. */
  onFrame(phase: FramePhase, fn: FrameHook): () => void;
  onResize(fn: ResizeHook): () => void;
  /** Mark the UI tree dirty so layout re-runs next frame. */
  invalidate(): void;
  /** Register cleanup run when the UI module unloads (renderer destroy). */
  onDispose(fn: () => void): void;
  /** True when the pointer is over an interactive UI element. */
  isPointerOverUI(): boolean;
  /**
   * Bind a store slice to a mutation. `apply` runs immediately with the
   * current value, then on every store change where the selected slice
   * differs (per `equals`, default `Object.is`). Auto-unsubscribes on
   * module unload.
   */
  bind<S, T>(
    store: UISubscribable<S>,
    selector: (state: S) => T,
    apply: (value: T) => void,
    opts?: { equals?: (a: T, b: T) => boolean },
  ): void;
}

export interface GameUiOptions {
  /** Module name — defaults to "game-ui" (must be unique per renderer). */
  name?: string;
  /** Build the element tree under `ui.root`. Runs once at registration. */
  build(ui: GameUiContext): void;
}

/** DI token for the mounted game UI context (injected by other modules). */
export const GameUiTok = resourceToken<GameUiContext>("gameUi");

export function createGameUi(options: GameUiOptions): RendererModule {
  const moduleName = options.name ?? "game-ui";
  return {
    name: moduleName,
    version: "1.0.0",
    provides: [GameUiTok],
    register(ctx) {
      const uiRoot = ctx.getUIRoot();
      const container = new UIPanel(uiRoot.width, uiRoot.height);
      container.name = `${moduleName}:root`;
      container.pointerThrough = true;
      container.layoutMode = "absolute";
      // UIPanel defaults to a 90%-opaque dark background — the mount container
      // covers the whole screen, so it must be fully transparent.
      container.style.backgroundColor = [0, 0, 0, 0];
      container.style.borderWidth = 0;

      const updateFns: Array<(dt: number, elapsedTime: number) => void> = [];
      const unsubscribes: Array<() => void> = [];

      const ui: GameUiContext = {
        root: container,
        find<T extends UIElement>(name: string): T | undefined {
          const stack: UIElement[] = [container];
          while (stack.length > 0) {
            const el = stack.pop()!;
            if (el.name === name) return el as T;
            stack.push(...el.children);
          }
          return undefined;
        },
        onUpdate(fn) {
          updateFns.push(fn);
        },
        onFrame: (phase, fn) => ctx.onFrame(phase, fn),
        onResize: (fn) => ctx.onResize(fn),
        invalidate: () => ctx.invalidateUILayout(),
        onDispose: (fn) => ctx.onDispose(fn),
        isPointerOverUI: () => ctx.getUIInputRouter()?.isPointerOverUI() ?? false,
        bind(store, selector, apply, opts) {
          const equals = opts?.equals ?? Object.is;
          let prev = selector(store.getState());
          apply(prev);
          const unsub = store.subscribe((state) => {
            const next = selector(state);
            if (!equals(next, prev)) {
              prev = next;
              apply(next);
            }
          });
          unsubscribes.push(unsub);
        },
      };

      // Keep the hit-test container covering the screen on resize. This hook
      // must be registered BEFORE options.build() — resize hooks run in
      // registration order, and game layout callbacks read container.width /
      // .height via ui.root; if the container resized after them, every game
      // layout would lag one resize behind the real surface size.
      ctx.onResize(() => {
        container.width = uiRoot.width;
        container.height = uiRoot.height;
        ctx.invalidateUILayout();
      });

      options.build(ui);
      uiRoot.addChild(container);
      ctx.invalidateUILayout();
      ctx.provide(GameUiTok, ui);

      ctx.onFrame("afterViewports", (dt, elapsedTime) => {
        for (let i = 0; i < updateFns.length; i++) {
          updateFns[i](dt, elapsedTime);
        }
      });

      ctx.onDispose(() => {
        for (let i = unsubscribes.length - 1; i >= 0; i--) {
          unsubscribes[i]();
        }
        ctx.getUIRoot().removeChild(container);
      });
    },
  };
}

// ── Helpers ──

const baseFontSizes = new WeakMap<UIElement, number>();

/**
 * Scale `fontSize` across an element subtree relative to each element's
 * base size (captured on first call). Mirrors the per-game font-scale
 * plumbing that pixi scenes implemented by hand.
 */
export function setUIFontScale(root: UIElement, scale: number): void {
  const walk = (el: UIElement) => {
    let base = baseFontSizes.get(el);
    if (base === undefined) {
      base = el.style.fontSize;
      baseFontSizes.set(el, base);
    }
    el.style.fontSize = Math.round(base * scale);
    el.children.forEach((child) => { walk(child);; });
  };
  walk(root);
}
