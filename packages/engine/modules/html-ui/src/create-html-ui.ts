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

import type { RendererModule, RendererModuleContext } from "@downdraft/engine/module/renderer-module";
import { resourceToken } from "@downdraft/engine/ecs/resource";
import { createLogger } from "@downdraft/engine/util/logger";
import type { OsrDomEvent } from "@downdraft/engine/libraries/blitz-ui/native-osr-ffi";
import { GamepadSourceTok } from "@downdraft/engine/libraries/gamepad/library";
import { UiNavRouter, type UiNavRouterOptions } from "@downdraft/engine/libraries/html-ui-kit/nav/router";
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
  /**
   * Controller/keyboard navigation router — every mounted panel is
   * auto-attached, the topmost panel captures input, and confirming an
   * editable node with a pad auto-opens the OSK. `null` when `nav:false`.
   */
  readonly nav: UiNavRouter | null;
  /** The host, for bespoke integration (devtools overlay, world-space reuse). */
  readonly host: HtmlUiHost;
}

export interface HtmlUiOptions {
  name?: string;
  /**
   * Controller nav wiring. `false` disables; `true`/object enables
   * (default). The pad source comes from `GamepadSourceTok` (GamepadLib)
   * unless `source` is supplied explicitly. Keyboard arrow/enter/escape
   * nav is always wired when enabled.
   */
  nav?: boolean | Omit<UiNavRouterOptions, "screenW" | "screenH">;
  /**
   * Upload panel frames via the ui worker's shared-device view (native only,
   * default true). The worker queue.writeTextures straight into panel
   * textures instead of posting SAB frames for the host to upload. `false`
   * forces the SAB path; `DOWNDRAFT_NO_UI_GPU=1` forces it globally.
   */
  gpuUpload?: boolean;
  build(ui: HtmlUiContext): void;
}

export const HtmlUiTok = resourceToken<HtmlUiContext>("htmlUi");

// Mounted contexts — lets input handlers/renderers hit-test panels without
// each game keeping its own `activeUi` singleton. Multiple coexisting
// contexts (game UI + devtools overlay) OR together.
const activeContexts = new Set<HtmlUiContext>();

/** True when the pointer is inside any mounted html-ui panel. */
export function isPointerOverUI(): boolean {
  let over = false;
  activeContexts.forEach((ui) => {
    if (ui.isPointerOverUI()) over = true;
  });
  return over;
}

export function createHtmlUi(options: HtmlUiOptions): RendererModule {
  const moduleName = options.name ?? "html-ui";
  return {
    name: moduleName,
    version: "1.0.0",
    provides: [HtmlUiTok],
    register(ctx: RendererModuleContext) {
      const host = new HtmlUiHost(ctx.getDevice(), ctx.getFormat(), undefined, { profilingTag: `ui:${moduleName}`, gpuUpload: options.gpuUpload });
      host.bindInput(ctx.getInputBus());
      ctx.onDispose(() => host.dispose());
      const unregCompositor = ctx.registerUiCompositor?.(host.compositor);
      if (unregCompositor) ctx.onDispose(unregCompositor);

      const updateSubs: Array<(dt: number, e: number) => void> = [];
      const disposeFns: Array<() => void> = [];

      // Controller/keyboard navigation — batteries-included when enabled:
      // every mounted panel gets a NavController, any connected pad or the
      // keyboard drives the topmost panel, OSK auto-opens on editable focus.
      const navCfg = options.nav;
      const nav = navCfg !== false
        ? new UiNavRouter(host, {
            ...(typeof navCfg === "object" ? navCfg : {}),
            source: (typeof navCfg === "object" ? navCfg.source : undefined)
              ?? ctx.injectOptional(GamepadSourceTok)
              ?? null,
            screenW: ctx.getSurface().clientWidth,
            screenH: ctx.getSurface().clientHeight,
          })
        : null;
      if (nav) {
        ctx.onDispose(() => nav.dispose());
        ctx.onResize((w, h) => nav.setScreen(w, h));
        // Before the host's key routing (-10): consume nav keys unless the
        // focused node is editable (then the doc owns the keys).
        const offKey = ctx.getInputBus().onKeyDown((e) => {
          if (nav.handleKey(e as KeyboardEvent)) { /* consumed */ }
        }, -20);
        disposeFns.push(offKey);
      }

      const ui: HtmlUiContext = {
        host,
        nav,
        mount(markup, spec) {
          const html = typeof markup === "string" ? markup : renderHtml(markup);
          const handle = host.mount({ ...spec, html });
          disposeFns.push(() => { nav?.detach(handle); handle.dispose(); });
          if (spec.interactive !== false && nav) nav.attach(handle);
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
      activeContexts.add(ui);
      ctx.onDispose(() => activeContexts.delete(ui));
      ctx.onFrame("afterViewports", (dt: number, e: number) => {
        nav?.update();
        updateSubs.forEach((fn) => { fn(dt, e);; });
      });
      ctx.onDispose(() => { disposeFns.forEach((fn) => { fn();; }); disposeFns.length = 0; });

      try {
        options.build(ui);
      } catch (err) {
        log.error("html-ui", `${moduleName} build failed: ${err}`);
      }
    },
  };
}
