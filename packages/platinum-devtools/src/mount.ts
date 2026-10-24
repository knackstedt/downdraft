// ============================================================================
// mount.ts — mountPlatinumDevtools: the whole devtools surface, embeddable.
//
// Two modes share one code path:
//
//   standalone — the viewer app (src/standalone.ts → `draft devtools` or
//     `draft dev` in apps/devtools). Fullscreen, always visible.
//
//   overlay — inside a host game's ui() hook. Fullscreen overlay drawn above
//     the game (high compositor order + html-ui z), toggled by F12, zero GPU
//     cost and zero input capture while hidden.
//
// Both modes run the target runtime (discovery + feed + sessions), so an
// embedded surface can attach to the host game itself (self-agent), other
// running targets, or flaky/crashing targets — exactly like the standalone
// viewer.
// ============================================================================

import type { GameContext } from "@downdraft/engine/app/main";
import type { DevtoolsBackend } from "@downdraft/engine/libraries/devtools";
import type { RendererModule } from "@downdraft/engine/module/renderer-module";
import { createHtmlUi, HtmlUiTok, type HtmlUiContext } from "@downdraft/engine/modules/html-ui";
import { createLogger } from "@downdraft/engine/util/logger";
import { store } from "./app/store";
import { sessions, startTargetRuntime, stopTargetRuntime } from "./targets/runtime";
import { TextAtlas } from "./text/atlas";
import { loadFaces } from "./text/fonts";
import { RunCache } from "./text/run-cache";
import { installDockDrag, setLayoutPersistence } from "./ui/drawer";
import { PanelHost } from "./ui/host";
import { installHotkeys } from "./ui/hotkeys";
import { setHtmlUi } from "./ui/panels";
import { registerAllPanels, setSurfaceCtx } from "./ui/register";
import { mountShell, type ShellHandles } from "./ui/shell";

const log = createLogger();

let rejectionGuardInstalled = false;
/** The engine's native-error-handlers treat unhandledRejection as fatal
 *  (crash report + dialog + exit). A devtools host watches flaky targets —
 *  routine async channel failures shouldn't kill the viewer (or the host
 *  game it's embedded in). Swap exit for a loud log; synchronous
 *  uncaughtException keeps engine fatal semantics. */
function installRejectionGuard(): void {
  if (rejectionGuardInstalled) return;
  rejectionGuardInstalled = true;
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    log.error("app", `unhandled rejection (non-fatal): ${detail}`);
  });
}

export interface PlatinumMountOptions {
  /** Embedded mode: overlay hidden until toggled; compositors/docs drawn
   *  above game UI; layout prefs not persisted to the standalone viewer's
   *  file. Default false (standalone viewer). */
  overlay?: boolean;
  /** The host game's HtmlUiContext — pass `ui` from inside the game's own
   *  `createHtmlUi({ build(ui) { ... } })` so the devtools docs share the
   *  game's html-ui host (one worker, unified input routing/z-order). If
   *  omitted: reuses a `HtmlUiTok` provider when one is already registered;
   *  otherwise mounts a private non-providing host. */
  ui?: HtmlUiContext;
  /** Key that toggles the overlay on the input bus. Default "F12" in
   *  overlay mode; pass null for programmatic control only. */
  toggleKey?: string | null;
  /** Overlay starts visible. Default false. */
  initiallyVisible?: boolean;
  /** html-ui z-order for the shell docs. Default 10 standalone / 1000 overlay. */
  chromeZ?: number;
  /** ScreenUiCompositor order for the GPU panel pass — must outrank the host
   *  game's own compositors for the overlay to draw on top. Default 0 / 1000. */
  surfaceOrder?: number;
  /** Inject the bundled devtools agent into this process so the viewer can
   *  self-attach. "auto" = only when embedded AND DOWNDRAFT_DEV=1 (i.e. under
   *  `draft dev`); true = always; false = never. Default "auto". */
  selfAgent?: "auto" | boolean;
  /** Embedded only: expose the host game's devtools backend (the Blitz
   *  dock's in-process DevtoolsBackend) over a loopback mirror WS, so this
   *  overlay — and any external viewer — can pull provider data (GPU, sim,
   *  render-graph…) from the game itself. No-op when the game already runs
   *  devtools.ui:"web" (mirror exists) or "none" (no backend). Default true. */
  selfMirror?: boolean;
  /** Target runtime + selection mode. `false` disables discovery/feed/
   *  sessions entirely. `"self"` pins the host process as the active target
   *  and hides the targets sidebar — embedded default: the overlay inspects
   *  the game it's mounted in. `"all"` shows the full target list —
   *  standalone default, also valid embedded for multi-target inspection. */
  targets?: boolean | "self" | "all";
  /** Persist dock/sidebar/zoom prefs to the viewer's shared layout.json.
   *  Default true standalone, false embedded. */
  persistLayout?: boolean;
  /** Downgrade unhandledRejection from the engine's fatal handler to a
   *  logged error — a flaky target's channel must never take down the
   *  viewer (or, embedded, the host game). The trade-off: other unhandled
   *  rejections in the process also become non-fatal. Pass false to keep
   *  strict engine semantics. Default true. */
  rejectionGuard?: boolean;
}

export interface PlatinumMount {
  setVisible(on: boolean): void;
  readonly visible: boolean;
  dispose(): void;
}

/** Expose the host game's devtools backend over a loopback mirror WS.
 *  Blitz games keep their backend in-process — this attaches a
 *  DevToolsServer to it so remote viewers (this overlay included) get the
 *  provider channel, and writes the ~/.downdraft/devtools/<pid>.json
 *  discovery record. Skips web hosts (already mirrored) and missing
 *  backends (devtools.ui:"none"). */
async function attachSelfMirror(ctx: GameContext): Promise<(() => void) | null> {
  const host = (ctx.renderer as {
    nativeDebugger?: { devtoolsMirror?: DevtoolsBackend; url?: string };
  }).nativeDebugger;
  const backend = host?.devtoolsMirror;
  if (!backend || typeof host?.url === "string") return null;
  const { DevToolsServer } = await import("@downdraft/engine/libraries/devtools");
  const server = new DevToolsServer({
    call: (method, params) => backend.dispatch(method, params ?? {}),
  });
  const detach = backend.attachRemote({
    emit: (e, d) => server.emit(e, d),
    hasClient: () => server.clientCount > 0,
  });
  server.setHello(() => ({
    version: 1,
    panels: backend.providerSlots(),
    inspector: backend.inspectorMethodNames(),
  }));
  await server.start();
  log.info("app", `self mirror exposed at ${server.url}`);
  return () => { detach(); void server.stop(); };
}

export function mountPlatinumDevtools(ctx: GameContext, opts: PlatinumMountOptions = {}): PlatinumMount {
  const overlay = opts.overlay ?? false;
  const visible0 = overlay ? (opts.initiallyVisible ?? false) : true;
  const toggleKey = opts.toggleKey === undefined ? (overlay ? "F12" : null) : opts.toggleKey;
  const chromeZ = opts.chromeZ ?? (overlay ? 1000 : 10);
  const surfaceOrder = opts.surfaceOrder ?? (overlay ? 1000 : 0);

  if (opts.rejectionGuard !== false) installRejectionGuard();
  setLayoutPersistence(opts.persistLayout ?? !overlay);
  registerAllPanels();
  store.setState({ overlayVisible: visible0 });

  // ── Shell docs: lazily mounted on first show (embedded pays nothing until
  //    the toggle key is pressed); hidden by zero-rect + non-interactive. ──
  let shellUi: HtmlUiContext | null = null;
  let shell: ShellHandles | null = null;
  const shellDocs = () => shell
    ? [shell.sidebar, shell.tabstrip, shell.dockBottom, shell.dockRight, shell.statusbar].filter((h) => h !== null)
    : [];
  const showShell = () => {
    if (!shellUi) return;
    shell ??= mountShell(shellUi, ctx, { z: chromeZ });
    shellDocs().forEach((h) => h.setInteractive(true));
    shell.relayout();
  };
  const hideShell = () => {
    shellDocs().forEach((h) => {
      h.setRect({ x: 0, y: 0, w: 0, h: 0 });
      h.setInteractive(false);
    });
  };
  const setVisible = (on: boolean) => {
    store.setState({ overlayVisible: on });
    if (on) {
      // Games that hold pointer lock (FPS look) must release it for the
      // overlay's panels to be clickable — same contract the game's own
      // overlays use. No-op when the surface isn't locked.
      (ctx.surface as { exitPointerLock?: () => void }).exitPointerLock?.();
      showShell();
    } else {
      hideShell();
    }
  };

  // ── html-ui: prefer the host game's context (one worker + unified input
  //    routing). When none exists, mount a private host that does NOT provide
  //    HtmlUiTok — a game registering createHtmlUi afterwards then can't hit
  //    the duplicate-provides error regardless of mount order. ──
  const attachUi = (ui: HtmlUiContext) => {
    shellUi = ui;
    setHtmlUi(ui);
    (globalThis as Record<string, unknown>).__platinumUi = ui;
    if (store.getState().overlayVisible) showShell();
  };
  if (opts.ui) {
    attachUi(opts.ui);
  } else {
    const moduleHost = (ctx.renderer as {
      getRendererModuleHost?(): { injectResourceOptional<T>(t: unknown): T | undefined } | null;
    }).getRendererModuleHost?.();
    const shared = moduleHost?.injectResourceOptional?.<HtmlUiContext>(HtmlUiTok);
    if (shared) {
      attachUi(shared);
    } else {
      ctx.renderer.useRendererModule?.(createHtmlUi({
        name: "platinum-shell",
        nav: false,
        provideToken: false,
        build: attachUi,
      }));
    }
  }

  const surfacesModule: RendererModule = {
    name: "platinum-surfaces",
    version: "0.1.0",
    register(mctx) {
      (globalThis as Record<string, unknown>).__platinumBus = mctx.getInputBus();
      (globalThis as Record<string, unknown>).__platinumStore = store;
      const atlas = new TextAtlas(mctx.getDevice(), 2048);
      const cache = new RunCache(atlas);
      setSurfaceCtx({ mctx, cache, order: surfaceOrder });
      const host = new PanelHost(mctx, cache);
      (globalThis as Record<string, unknown>).__platinumHost = host;
      void cache.init().then(async () => {
        const defs = await loadFaces();
        defs.forEach((d) => cache.registerFace(d));
      }).catch((e) => log.warn("text", `font init failed: ${e}`));
      mctx.onFrame("afterFrame", (dt) => host.tick(dt));
      const isVisible = () => store.getState().overlayVisible;
      const unhotkey = installHotkeys(mctx, { isVisible, toggleKey, onToggle: () => setVisible(!isVisible()) });
      const undockdrag = installDockDrag(mctx.getInputBus(), isVisible);
      mctx.onDispose(() => {
        unhotkey();
        undockdrag();
        host.dispose();
        cache.dispose();
        atlas.destroy();
        setSurfaceCtx(null as never);
      });
    },
  };
  ctx.renderer.useRendererModule?.(surfacesModule);

  // ── Pointer lock: games re-lock on canvas click, and their DOM-level
  //    handlers can't see the input bus's consumed flags. Swallow lock
  //  requests while the overlay is up — the game's own overlays use the
  //    same contract. Restored on dispose. ──
  const lockable = ctx.surface as { requestPointerLock?: () => Promise<void> | void };
  const origRequestPointerLock = lockable.requestPointerLock;
  if (origRequestPointerLock) {
    try {
      lockable.requestPointerLock = function (this: unknown) {
        if (store.getState().overlayVisible) return undefined;
        return origRequestPointerLock.call(this);
      };
    } catch { /* non-writable surface — the game's gate still applies */ }
  }

  // ── Target runtime: discovery + feed + sessions. Refcounted — safe when
  //    the host process embeds this alongside another viewer instance. ──
  let detachSelfMirror: (() => void) | null = null;
  let mirrorPending = false;
  let unsubMirrorRetry: (() => void) | null = null;
  const stopMirrorRetry = () => { unsubMirrorRetry?.(); unsubMirrorRetry = null; };
  const tryMirror = () => {
    if (mirrorPending || detachSelfMirror) return;
    const host = (ctx.renderer as { nativeDebugger?: { url?: string; devtoolsMirror?: unknown } }).nativeDebugger;
    // Terminal states — stop retrying: already mirrored (web host), no
    // backend to expose (ui:"none"), or attach previously succeeded.
    if (host && (typeof host.url === "string" || !host.devtoolsMirror)) { stopMirrorRetry(); return; }
    mirrorPending = true;
    attachSelfMirror(ctx)
      .then((d) => { detachSelfMirror = d; if (d) stopMirrorRetry(); })
      .catch((e) => log.warn("app", `self mirror failed: ${e}`))
      .finally(() => { mirrorPending = false; });
  };
  const targetsMode = opts.targets === undefined || opts.targets === true
    ? (overlay ? "self" : "all")
    : opts.targets;
  if (targetsMode !== false) {
    void startTargetRuntime().then(() => {
      log.info("app", "target runtime started");
    });
    if (overlay) {
      // The host game is a legitimate target here — let its own discovery
      // records (mirror, agent, mcp) register it as a session. "self" mode
      // pins it as the active target and hides the list; "all" merely
      // prefers it when nothing else is selected yet.
      sessions.setSelfTarget(process.pid, { pin: targetsMode === "self" });
      if (targetsMode === "self") store.setState({ sidebarVisible: false });
      if (opts.selfMirror !== false) {
        tryMirror();
        // nativeDebugger lands on the renderer during devtools wiring —
        // a mount that raced it retries on first show.
        unsubMirrorRetry = store.subscribe((s) => {
          if (s.overlayVisible) tryMirror();
        });
      }
    }
  }

  // ── Self-target: import the bundled agent so this process announces
  //    itself on ~/.downdraft/platinum-agent/ and appears in the target
  //    list. The dynamic import keeps tsc/bundlers from resolving the .mjs
  //    (it has no typings) — the path is stable via the package exports map.
  const wantAgent = opts.selfAgent === true
    || (opts.selfAgent !== false && overlay && process.env.DOWNDRAFT_DEV === "1");
  if (wantAgent) {
    const agentSpec = "@downdraft/platform-native/dev/devtools-agent.mjs";
    void import(/* @vite-ignore */ agentSpec)
      .then(() => log.info("app", "self devtools-agent loaded"))
      .catch((e) => log.warn("app", `devtools-agent unavailable: ${e}`));
  }

  return {
    setVisible,
    get visible() { return store.getState().overlayVisible; },
    dispose() {
      stopMirrorRetry();
      detachSelfMirror?.();
      if (origRequestPointerLock) {
        try { lockable.requestPointerLock = origRequestPointerLock; } catch { /* ignore */ }
      }
      if (overlay) {
        sessions.setSelfTarget(null);
        if (targetsMode === "self") store.setState({ sidebarVisible: true });
      }
      stopTargetRuntime();
    },
  };
}
