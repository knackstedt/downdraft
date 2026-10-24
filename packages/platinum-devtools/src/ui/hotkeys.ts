// ============================================================================
// hotkeys.ts — global keyboard shortcuts on the input bus.
//
// Embedded (overlay) mode: `isVisible` gates every devtools key so a hidden
// overlay never consumes the host game's input; `toggleKey` is the one
// exception — it's handled in both states and flips visibility via onToggle.
// ============================================================================

import type { RendererModuleContext } from "@downdraft/engine/module/renderer-module";
import { mainTabsFor, store } from "../app/store";
import { saveLayout, toggleDrawer } from "./drawer";

export interface HotkeyOptions {
  /** Gate for every key except toggleKey. Default: always visible. */
  isVisible?: () => boolean;
  /** Key that toggles the overlay (e.g. "F12"). null disables. */
  toggleKey?: string | null;
  onToggle?: () => void;
}

export function installHotkeys(mctx: RendererModuleContext, opts: HotkeyOptions = {}): () => void {
  const isVisible = opts.isVisible ?? (() => true);
  const bus = mctx.getInputBus();
  const off = bus.onKeyDown((e, ctrl) => {
    const key = e.key;
    // The toggle key works from either state — it IS the show/hide switch.
    if (typeof opts.toggleKey === "string" && key === opts.toggleKey) {
      opts.onToggle?.();
      ctrl.stopPropagation();
      return;
    }
    if (!isVisible()) return;
    // Esc toggles the bottom drawer (Chrome convention) — unless a panel
    // consumed it for its own purposes.
    if (key === "Escape") {
      toggleDrawer();
      ctrl.stopPropagation();
      return;
    }
    // Ctrl+` also toggles the drawer.
    if (key === "`" && e.ctrlKey) {
      toggleDrawer();
      ctrl.stopPropagation();
      return;
    }
    // Ctrl+= / Ctrl+- / Ctrl+0 — UI zoom.
    if (e.ctrlKey && (key === "=" || key === "+" || key === "-" || key === "_" || key === "0")) {
      const s = store.getState();
      const step = key === "0" ? 1 : s.uiZoom + (key === "-" || key === "_" ? -0.1 : 0.1);
      store.setState({ uiZoom: Math.round(Math.max(0.5, Math.min(2.5, step)) * 10) / 10 });
      saveLayout();
      ctrl.stopPropagation();
      return;
    }
    // Ctrl+1..N — main tab quick-switch (visible tabs only).
    const s0 = store.getState();
    const visTabs = mainTabsFor(s0.targets.find((t) => t.id === s0.activeTargetId) ?? s0.targets[0]);
    if (e.ctrlKey && key >= "1" && key <= String(visTabs.length)) {
      const idx = Number(key) - 1;
      const tab = visTabs[idx];
      if (tab) {
        store.setState({ mainTab: tab });
        ctrl.stopPropagation();
      }
      return;
    }
  }, -20);
  return off;
}
