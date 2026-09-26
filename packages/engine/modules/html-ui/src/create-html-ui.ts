// ============================================================================
// create-html-ui.ts — game-facing mount layer for the Blitz HTML/CSS UI stack.
//
//   renderer.useRendererModule(createHtmlUi({ build(ui) { ... } }))
//
// Panels are Blitz documents rasterized in a UI worker (per-panel dirty-rect
// uploads, :hover/:active/focus inside the doc, DOM events dispatched to
// data-action handlers). Authoring is JSX→markup; fine updates go through
// selector-scoped mutator ops so HUD ticks don't reparse the document.
// ============================================================================

import type { RendererModule, RendererModuleContext } from "@downdraft/engine";
import { createLogger, resourceToken } from "@downdraft/engine";
import type { OsrDomEvent } from "@downdraft/engine/libraries/blitz-ui/native-osr-ffi";
import { HtmlUiHost, type PanelSpec, type UiPanelHandle } from "./host";
import { renderHtml, type Child } from "./jsx-runtime";

const log = createLogger("info");

export interface UISubscribable<S> {
  getState(): S;
  subscribe(listener: (state: S, prev: S) => void): () => void;
}

export interface HtmlUiContext {
  /** Mount a panel from JSX vnodes or a markup string. */
  mount(markup: Child | string, spec: Omit<PanelSpec, "html">): UiPanelHandle;
  /** Subscribe a `data-action` across all panels: `<button data-action="x">`. */
  onAction(action: string, fn: (data: Record<string, string>, ev: OsrDomEvent) => void): () => void;
  /** Bind a store slice to a panel mutation (`fn` receives the handle). */
  bind<S, T>(
    store: UISubscribable<S>,
    selector: (state: S) => T,
    apply: (value: T) => void,
    opts?: { equals?: (a: T, b: T) => boolean },
  ): void;
  /** Load a font/image for `ui://` URLs. `url` can be a path, http(s) URL, or bytes. */
  loadResource(uiUrl: string, src: string | Uint8Array | ArrayBuffer): Promise<void>;
  /** Convenience: register a font and get the @font-face CSS rule to inject. */
  fontFaceCss(family: string, uiUrl: string): string;
  /** True when the pointer is inside any panel rect. */
  isPointerOverUI(): boolean;
  /** Per-frame hook (see createGameUi.onUpdate semantics). */
  onUpdate(fn: (dt: number, elapsed: number) => void): void;
  onResize(fn: (w: number, h: number, dpr: number) => void): void;
  onDispose(fn: () => void): void;
  /** The host, for bespoke integration (devtools overlay, world-space reuse). */
  readonly host: HtmlUiHost;
}

export interface HtmlUiOptions {
  name?: string;
  build(ui: HtmlUiContext): void;
}

export const HtmlUiTok = resourceToken<HtmlUiContext>("htmlUi");

export function createHtmlUi(options: HtmlUiOptions): RendererModule {
  const moduleName = options.name ?? "html-ui";
  return {
    name: moduleName,
    version: "1.0.0",
    provides: [HtmlUiTok],
    register(ctx: RendererModuleContext) {
      const host = new HtmlUiHost(ctx.getDevice(), ctx.getFormat());
      host.bindInput(ctx.getInputBus());
      ctx.onDispose(() => host.dispose());
      const unregCompositor = ctx.registerUiCompositor?.(host.compositor);
      if (unregCompositor) ctx.onDispose(unregCompositor);

      const updateSubs: Array<(dt: number, e: number) => void> = [];
      const disposeFns: Array<() => void> = [];

      const ui: HtmlUiContext = {
        host,
        mount(markup, spec) {
          const html = typeof markup === "string" ? markup : renderHtml(markup);
          const handle = host.mount({ ...spec, html });
          disposeFns.push(() => handle.dispose());
          return handle;
        },
        onAction: (action, fn) => {
          const off = host.onAction(action, fn);
          disposeFns.push(off);
          return off;
        },
        bind(store, selector, apply, opts) {
          const equals = opts?.equals ?? Object.is;
          let prev = selector(store.getState());
          apply(prev);
          const unsub = store.subscribe((s) => {
            const next = selector(s);
            if (!equals(next, prev)) { prev = next; apply(next); }
          });
          disposeFns.push(unsub);
        },
        async loadResource(uiUrl, src) {
          let bytes: Uint8Array | ArrayBuffer;
          if (typeof src === "string") {
            const r = await fetch(src);
            if (!r.ok) throw new Error(`loadResource ${src}: ${r.status}`);
            bytes = await r.arrayBuffer();
          } else {
            bytes = src;
          }
          host.registerResource(uiUrl, bytes);
        },
        fontFaceCss: (family, uiUrl) =>
          `@font-face { font-family: '${family}'; src: url('${uiUrl}'); }`,
        isPointerOverUI: () => host.isPointerOverUI(),
        onUpdate(fn) { updateSubs.push(fn); },
        onResize(fn) { ctx.onResize(fn); },
        onDispose(fn) { disposeFns.push(fn); },
      };

      ctx.provide(HtmlUiTok, ui);
      ctx.onFrame("afterViewports", (dt: number, e: number) => { updateSubs.forEach((fn) => { fn(dt, e);; }); });
      ctx.onDispose(() => { disposeFns.forEach((fn) => { fn();; }); disposeFns.length = 0; });

      try {
        options.build(ui);
      } catch (err) {
        log.error("html-ui", `${moduleName} build failed: ${err}`);
      }
    },
  };
}
