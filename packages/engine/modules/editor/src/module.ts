// ============================================================================
// createEditorModule — the editor as a RendererModule.
//
//   viewer.useRendererModule(createEditorModule({ scene: "dock.ddscene", ui: true }));
//
// Registers an `EditorContext` (design world + document + command registry),
// provides it via `EditorModuleTok`, and stashes it on
// `globalThis.__downdraftEditor` so a game's `mcp:` hook can surface
// `editor_*` tools via `editorMcpTools()`.
//
// `ui: true` mounts the Blitz shell (toolbar/hierarchy/inspector/journal) —
// reusing the game's HtmlUiTok when present, else self-hosting an
// HtmlUiHost — plus the viewport gizmo/picking layer (EditorViewport).
// ============================================================================

import { resourceToken, type RendererModule, type RendererModuleContext } from "@downdraft/engine";
import type { OsrDomEvent } from "@downdraft/engine/modules/html-ui";
import {
    HtmlUiHost,
    HtmlUiTok,
    renderHtml,
    type HtmlUiContext,
    type PanelSpec,
} from "@downdraft/engine/modules/html-ui";

import { registerDefaultCommands } from "./commands";
import { EditorContext, type EditorFs, type EditorSceneAdapter } from "./editor-context";
import { EditorShell } from "./shell";
import { EditorViewport } from "./viewport";

export const EditorModuleTok = resourceToken<EditorContext>("editor");

export interface EditorModuleConfig {
  /** Design-world scene name. Default "editor-scene". */
  sceneName?: string;
  /** Filesystem implementation — defaults to node:fs via lazy import. */
  fs?: EditorFs | null;
  /** Game-provided visual bridge (entities ↔ GPU). Required for picking +
   *  model sync; the shell works without it. */
  adapter?: EditorSceneAdapter;
  /** Open this .ddscene path on register. */
  scene?: string;
  /** Component name used by transform.* commands. Default "transform". */
  transformComponent?: string;
  /** Mount the Blitz editor shell (panels + gizmo + picking). */
  ui?: boolean;
}

/**
 * Self-hosted HtmlUiContext for games that don't already mount html-ui.
 * Owns an HtmlUiHost + input binding + compositor registration.
 */
function createSelfHostedUi(ctx: RendererModuleContext): HtmlUiContext {
  const host = new HtmlUiHost(ctx.getDevice(), ctx.getFormat(), undefined, { profilingTag: "editor-ui" });
  host.bindInput(ctx.getInputBus());
  ctx.onDispose(() => host.dispose());
  const unreg = ctx.registerUiCompositor?.(host.compositor);
  if (unreg) ctx.onDispose(unreg);

  const disposeFns: Array<() => void> = [];
  const updateSubs: Array<(dt: number, e: number) => void> = [];
  ctx.onFrame("afterViewports", (dt, e) => { updateSubs.forEach((fn) => fn(dt, e)); });
  ctx.onDispose(() => { disposeFns.forEach((fn) => fn()); disposeFns.length = 0; });

  return {
    host,
    nav: null,
    mount(markup, spec: Omit<PanelSpec, "html">) {
      const html = typeof markup === "string" ? markup : renderHtml(markup);
      const handle = host.mount({ ...spec, html });
      disposeFns.push(() => handle.dispose());
      return handle;
    },
    onAction(action: string, fn: (data: Record<string, string>, ev: OsrDomEvent) => void) {
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
      const bytes = typeof src === "string"
        ? await (await fetch(src)).arrayBuffer()
        : src;
      host.registerResource(uiUrl, bytes);
    },
    fontFaceCss: (family, uiUrl) =>
      `@font-face { font-family: '${family}'; src: url('${uiUrl}'); }`,
    isPointerOverUI: () => host.isPointerOverUI(),
    onUpdate: (fn) => { updateSubs.push(fn); },
    onResize: (fn) => { ctx.onResize(fn); },
    onDispose: (fn) => { disposeFns.push(fn); },
  };
}

export function createEditorModule(config: EditorModuleConfig = {}): RendererModule {
  return {
    name: "editor",
    version: "0.1.0",
    provides: [EditorModuleTok],

    register(ctx: RendererModuleContext) {
      const editor = new EditorContext({
        sceneName: config.sceneName,
        fs: config.fs,
        adapter: config.adapter,
      });
      if (config.transformComponent) editor.transformComponent = config.transformComponent;

      registerDefaultCommands(editor.commands);

      ctx.provide(EditorModuleTok, editor);
      (globalThis as Record<string, unknown>).__downdraftEditor = editor;

      ctx.onDispose(() => {
        editor.dispose();
        if ((globalThis as Record<string, unknown>).__downdraftEditor === editor) {
          delete (globalThis as Record<string, unknown>).__downdraftEditor;
        }
      });

      if (config.ui) {
        const ui = ctx.injectOptional(HtmlUiTok) ?? createSelfHostedUi(ctx);
        const shell = new EditorShell(editor, ui);
        const surface = ctx.getSurface();
        shell.mount(surface.clientWidth, surface.clientHeight);
        ctx.onResize((w, h) => shell.resize(w, h));
        ctx.onDispose(() => shell.dispose());

        const viewport = new EditorViewport(ctx, editor);
        viewport.attachShell(shell);
        viewport.start();
      }

      if (config.scene) {
        void editor.commands.dispatch("scene.open", { path: config.scene }, "internal");
      }
    },
  };
}
