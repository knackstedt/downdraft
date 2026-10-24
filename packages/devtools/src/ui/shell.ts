// ============================================================================
// shell.tsx — html-ui chrome for devtools.
//
// Mounted panels: sidebar (targets), tabstrip (main tabs + dock toggles),
// bottom dock strip, right dock strip, statusbar. The dock/main bodies are
// left uncovered so the GPU surfaces + snapshot html panels occupy them.
// ============================================================================

import type { GameContext } from "@downdraft/engine/app/main";
import type { HtmlUiContext, UiPanelHandle } from "@downdraft/engine/modules/html-ui";
import { createLogger } from "@downdraft/engine/util/logger";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { store } from "../app/store";
import { chromeCss, tokens } from "../app/theme";
import {
    computeLayout,
    dockMove, dockRemove, dockSelect, dockToggle,
    loadLayout,
    setMainTab,
} from "./drawer";
import { dockStripMarkup, sidebarMarkup, statusbarMarkup, tabstripMarkup } from "./markup";

import { sessions } from "../targets/runtime";

const log = createLogger();

const FONTS: Array<[string, string]> = [
  ["Inter", "ui://fonts/Inter-Regular.ttf"],
  ["Inter Medium", "ui://fonts/Inter-Medium.ttf"],
  ["Inter SemiBold", "ui://fonts/Inter-SemiBold.ttf"],
  ["Inter Bold", "ui://fonts/Inter-Bold.ttf"],
  ["JetBrains Mono", "ui://fonts/JetBrainsMono-Regular.ttf"],
  ["JetBrains Mono Medium", "ui://fonts/JetBrainsMono-Medium.ttf"],
  ["JetBrains Mono Bold", "ui://fonts/JetBrainsMono-Bold.ttf"],
];

function fontDir(): string {
  // Same dir fonts.ts' FONTS_DIR resolves: src/assets/fonts in the source
  // tree, dist/src/assets/fonts in the mirrored build.
  return join(new URL("../assets/fonts", import.meta.url).pathname);
}

/** Options for mountShell — `z` is the html-ui stacking order for the five
 *  chrome docs; embedded overlays pass a high value to sit above game UI. */
export interface ShellMountOptions { z?: number }

async function loadUiFonts(ui: HtmlUiContext): Promise<string> {
  const dir = fontDir();
  let faces = "";
  for (let i = 0; i < FONTS.length; i++) {
    const [family, url] = FONTS[i]!;
    const file = url.replace("ui://fonts/", "");
    try {
      const bytes = readFileSync(join(dir, file));
      await ui.loadResource(url, bytes);
      faces += ui.fontFaceCss(family, url);
    } catch (e) {
      log.warn("ui", `font ${file} failed: ${e}`);
    }
  }
  return faces;
}

/** Dock tab-strip height — carved out of the dock rect (host.ts does the
 *  same subtraction for the surface body). */
export const STRIP_H = 26;

export interface ShellHandles {
  /** Null when the store mounts with `sidebarVisible: false` (embedded
   *  single-target mode). */
  sidebar: UiPanelHandle | null;
  tabstrip: UiPanelHandle;
  dockBottom: UiPanelHandle;
  dockRight: UiPanelHandle;
  statusbar: UiPanelHandle;
  relayout: () => void;
}

export function mountShell(ui: HtmlUiContext, ctx: GameContext, opts: ShellMountOptions = {}): ShellHandles {
  const z = opts.z ?? 10;
  loadLayout();
  const s0 = store.getState();
  store.setState({ windowW: ctx.surface.width, windowH: ctx.surface.height });
  computeLayout();

  let fontFaces = "";
  const t = tokens("dark");
  const css = () => `<style>${fontFaces}${chromeCss(t)}</style>`;

  function wrap(inner: string): string {
    return `${css()}<div class="pt-panel">${inner}</div>`;
  }

  /** Effective sidebar width — 0 when the target list is hidden. */
  const sw = (s: { sidebarVisible: boolean; sidebarWidth: number }) => s.sidebarVisible ? s.sidebarWidth : 0;

  function dockStripRect(which: "bottom" | "right"): { x: number; y: number; w: number; h: number } {
    const s = store.getState();
    if (which === "bottom") {
      if (s.docks.bottom.collapsed || !s.docks.bottom.active) return { x: sw(s), y: s.windowH, w: 0, h: 0 };
      return { x: sw(s), y: s.bottomRect.y, w: s.bottomRect.w, h: STRIP_H };
    }
    if (s.docks.right.collapsed || !s.docks.right.active) return { x: s.windowW, y: 0, w: 0, h: 0 };
    return { x: s.rightRect.x, y: s.rightRect.y, w: s.rightRect.w, h: STRIP_H };
  }

  // Dedupe by rendered markup — targetsVersion bumps on every provider
  // snapshot push (~8Hz), but the chrome markup is usually unchanged;
  // resending identical HTML still costs a Blitz re-layout in the worker.
  const lastHtml = new Map<UiPanelHandle, string>();
  const setIfChanged = (h: UiPanelHandle, html: string) => {
    if (lastHtml.get(h) !== html) { lastHtml.set(h, html); h.setHtml(html); }
  };

  // False until every mount succeeds — a mid-mount throw must not leave the
  // deferred font callback (or a store subscription) touching dead handles.
  let mounted = false;
  function rerenderAll(): void {
    if (!mounted) return;
    const s = store.getState();
    if (sidebar) setIfChanged(sidebar, wrap(sidebarMarkup(s)));
    setIfChanged(tabstrip, wrap(tabstripMarkup(s)));
    setIfChanged(dockBottom, wrap(dockStripMarkup(s.docks.bottom, "bottom", s)));
    setIfChanged(dockRight, wrap(dockStripMarkup(s.docks.right, "right", s)));
    setIfChanged(statusbar, wrap(statusbarMarkup(s)));
  }

  void loadUiFonts(ui)
    .then((f) => { fontFaces = f; rerenderAll(); })
    .catch((e) => log.warn("ui", `font load failed: ${e}`));

  const sidebar = s0.sidebarVisible
    ? ui.mount(wrap(sidebarMarkup(s0)), { id: "sidebar", rect: { x: 0, y: 0, w: s0.sidebarWidth, h: s0.windowH }, z, scale: 2 })
    : null;
  const tabstrip = ui.mount(wrap(tabstripMarkup(s0)), { id: "tabstrip", rect: { x: sw(s0), y: 0, w: s0.windowW - sw(s0), h: s0.topbarHeight }, z, scale: 2 });
  const dockBottom = ui.mount(wrap(dockStripMarkup(s0.docks.bottom, "bottom", s0)), { id: "dock-bottom", rect: dockStripRect("bottom"), z, scale: 2 });
  const dockRight = ui.mount(wrap(dockStripMarkup(s0.docks.right, "right", s0)), { id: "dock-right", rect: dockStripRect("right"), z, scale: 2 });
  const statusbar = ui.mount(wrap(statusbarMarkup(s0)), { id: "statusbar", rect: { x: sw(s0), y: s0.windowH - 22, w: s0.windowW - sw(s0), h: 22 }, z, scale: 2 });
  mounted = true;

  function relayout(): void {
    computeLayout();
    const s = store.getState();
    // Hidden overlay: hideShell zeroed every doc rect — a targetsVersion
    // bump or window resize must not resurrect the chrome. showShell()
    // re-runs this once overlayVisible flips back.
    if (!s.overlayVisible) return;
    sidebar?.setRect({ x: 0, y: 0, w: sw(s), h: s.windowH });
    tabstrip.setRect({ x: sw(s), y: 0, w: s.windowW - sw(s), h: s.topbarHeight });
    dockBottom.setRect(dockStripRect("bottom"));
    dockRight.setRect(dockStripRect("right"));
    statusbar.setRect({ x: sw(s), y: s.windowH - 22, w: s.windowW - sw(s), h: 22 });
  }

  // Selective re-render on chrome-relevant state.
  let lastKey = "";
  const unsub = store.subscribe((s) => {
    const key = [
      s.targetsVersion, s.activeTargetId, s.mainTab, s.theme,
      JSON.stringify(s.docks), s.sidebarWidth, s.sidebarVisible, s.windowW, s.windowH, s.attachOpen,
    ].join("|");
    if (key !== lastKey) {
      lastKey = key;
      relayout();
      rerenderAll();
    }
  });
  ui.onDispose(unsub);

  ui.onResize(() => {
    const s = store.getState();
    store.setState({ windowW: s.windowW, windowH: s.windowH });
    relayout();
  });

  // ── Actions ──
  ui.onAction("select-target", (d) => { if (d.id) sessions.setActive(String(d.id)); });
  ui.onAction("detach-target", (d) => {
    const pid = Number(d.pid);
    if (Number.isFinite(pid)) sessions.detach(pid);
  });
  ui.onAction("attach-target", (d) => {
    const pid = Number(d.pid);
    if (Number.isFinite(pid)) sessions.attachManual({ pid });
  });
  const doAttach = () => {
    void sidebar?.getAttr("#attach-input", "value").then((raw) => {
      const v = (raw ?? "").trim();
      if (v) {
        if (/^\d+$/.test(v)) sessions.attachManual({ pid: Number(v) });
        else if (/^wss?:\/\//i.test(v) || /^https?:\/\//i.test(v)) sessions.attachManual({ cdpUrl: v });
        else if (/^[\w.-]+:\d+$/.test(v)) sessions.attachManual({ mcpPort: Number(v.split(":").pop()) });
        else return; // unrecognized — keep the dialog open
      }
      store.setState({ attachOpen: false });
    });
  };
  ui.onAction("attach-manual", () => {
    store.setState({ attachOpen: !store.getState().attachOpen });
    setTimeout(() => sidebar?.focus("#attach-input"), 80);
  });
  ui.onAction("attach-do", doAttach);
  ui.onAction("attach-cancel", () => store.setState({ attachOpen: false }));
  sidebar?.onEvent((ev) => {
    if (ev.t === "keydown" && ev.k === "Enter" && ev.g === "input") doAttach();
    if (ev.t === "keydown" && ev.k === "Escape") store.setState({ attachOpen: false });
  });
  ui.onAction("main-tab", (d) => { if (d.tab) setMainTab(String(d.tab)); });
  ui.onAction("dock-bottom", () => dockToggle("bottom"));
  ui.onAction("dock-right", () => dockToggle("right"));
  ui.onAction("dock-tab-bottom", (d) => { if (d.tab) dockSelect("bottom", String(d.tab)); });
  ui.onAction("dock-tab-right", (d) => { if (d.tab) dockSelect("right", String(d.tab)); });
  ui.onAction("dock-collapse-bottom", () => dockToggle("bottom"));
  ui.onAction("dock-collapse-right", () => dockToggle("right"));
  ui.onAction("dock-close-bottom", (d) => { if (d.tab) dockRemove("bottom", String(d.tab)); });
  ui.onAction("dock-close-right", (d) => { if (d.tab) dockRemove("right", String(d.tab)); });
  ui.onAction("dock-move-bottom", (d) => { if (d.tab) dockMove(String(d.tab), "right", "bottom"); });
  ui.onAction("dock-move-right", (d) => { if (d.tab) dockMove(String(d.tab), "bottom", "right"); });

  relayout();
  const handles = { sidebar, tabstrip, dockBottom, dockRight, statusbar, relayout };
  // Automation/debug handle — MCP `debug_eval` can drive doc clicks etc.
  (globalThis as Record<string, unknown>).__devtoolsShell = handles;
  return handles;
}


