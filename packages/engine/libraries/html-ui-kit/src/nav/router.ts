// ============================================================================
// router.ts — batteries-included nav wiring for an HtmlUiHost.
//
//   UiNavRouter owns one NavController per mounted panel, routes a shared
//   input stream (any connected pad + optional keyboard) to the topmost
//   panel, and auto-opens the OSK when a pad confirms an editable node.
//   createHtmlUi wires this up when `nav` is enabled; games can also build
//   one directly for bespoke integration.
// ============================================================================

import type { GamepadSource } from "@downdraft/engine/input/local-player-manager";
import type { HtmlUiHost, UiPanelHandle } from "@downdraft/engine/modules/html-ui";
import { NavController, type NavAction, type NavControllerOptions } from "./nav-controller";
import { keyToNavAction, PadNavDriver, type NavInputOptions } from "./nav-input";
import { openOsk, type OskOptions, type OskSession } from "./osk";

export interface UiNavRouterOptions {
  screenW: number;
  screenH: number;
  /** Pad source — any connected pad drives nav (one driver per slot). */
  source?: GamepadSource | null;
  /** PadNavDriver tuning (deadzone, repeat, thresholds). */
  pad?: NavInputOptions;
  /** Auto-open the OSK when a pad confirms an editable node. Default true. */
  autoOsk?: boolean;
  /** OSK overrides (layout). Screen size comes from this router. */
  osk?: Omit<OskOptions, "screenW" | "screenH">;
  /** Extra NavController options applied to every attached panel. */
  nav?: NavControllerOptions;
}

/**
 * Focus-stack + input router for controller navigation. The "active" panel
 * is the most recently attached live panel — mount a modal on top and it
 * captures nav; dispose it and focus returns underneath.
 */
export class UiNavRouter {
  /** Master switch — false suspends pad/key routing (OSK stays interactive). */
  enabled = true;

  private readonly host: HtmlUiHost;
  private opts: UiNavRouterOptions;
  private readonly ctrls = new Map<UiPanelHandle, NavController>();
  private order: UiPanelHandle[] = [];
  private pads = new Map<number, PadNavDriver>();
  private source: GamepadSource | null;
  private oskSession: OskSession | null = null;
  /** Which device kind produced the in-flight dispatch — read by onConfirm. */
  private lastVia: "pad" | "key" = "key";
  private lastTime: number | undefined;

  constructor(host: HtmlUiHost, opts: UiNavRouterOptions) {
    this.host = host;
    this.opts = opts;
    this.source = opts.source ?? null;
  }

  setScreen(w: number, h: number) {
    this.opts = { ...this.opts, screenW: w, screenH: h };
  }

  /** Register a panel for navigation; returns its controller (cached). */
  attach(handle: UiPanelHandle, navOpts?: NavControllerOptions): NavController {
    let c = this.ctrls.get(handle);
    if (c) return c;
    const userConfirm = navOpts?.onConfirm ?? this.opts.nav?.onConfirm;
    c = new NavController(handle, {
      ...this.opts.nav,
      ...navOpts,
      onConfirm: (info) => {
        userConfirm?.(info);
        const autoOsk = this.opts.autoOsk !== false;
        if (info.editable && autoOsk && this.lastVia === "pad") {
          void this.maybeOpenOsk(handle, info.node);
        }
      },
    });
    this.ctrls.set(handle, c);
    if (!this.order.includes(handle)) this.order.push(handle);
    return c;
  }

  detach(handle: UiPanelHandle) {
    this.ctrls.delete(handle);
    this.order = this.order.filter((h) => h !== handle);
  }

  /** Refresh nav snapshots (call after mutating structure). */
  invalidate(handle?: UiPanelHandle) {
    if (handle) { this.ctrls.get(handle)?.invalidate(); return; }
    for (const c of this.ctrls.values()) c.invalidate();
  }

  /** NavController for the topmost attached panel. */
  active(): NavController | null {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const c = this.ctrls.get(this.order[i]!);
      if (c) return c;
    }
    return null;
  }

  /** Make a specific panel's controller the nav target. */
  setActive(handle: UiPanelHandle | null) {
    if (!handle) return;
    this.order = this.order.filter((h) => h !== handle);
    this.order.push(handle);
  }

  /** Dispatch an action; `via` records the source device for OSK logic. */
  dispatch(a: NavAction, via: "pad" | "key" = "key") {
    this.lastVia = via;
    if (this.oskSession) {
      if (this.oskSession.dispatch(a)) return;
      this.oskSession = null;
    }
    if (!this.enabled) return;
    this.active()?.dispatch(a);
  }

  /** Keyboard entry point — returns true when the key was consumed. */
  handleKey(e: { key?: string; keyCode?: number; shiftKey?: boolean }): boolean {
    const a = keyToNavAction(e.key ?? e.keyCode ?? "", e.shiftKey ?? false);
    if (!a) return false;
    // While an editable element holds DOM focus, keys belong to the doc —
    // arrows/backspace are text input, not navigation. (OSK keys still route.)
    if (!this.oskSession && this.active()?.focusedInfo()?.editable) return false;
    if (this.oskSession || this.enabled) { this.dispatch(a, "key"); return true; }
    return false;
  }

  /** Poll connected pads — call once per frame (createHtmlUi does this). */
  update(nowMs?: number) {
    if (!this.source) return;
    for (const slot of this.source.listConnected()) {
      let d = this.pads.get(slot);
      if (!d) {
        d = new PadNavDriver(this.source, slot, (a) => this.dispatch(a, "pad"), this.opts.pad);
        this.pads.set(slot, d);
      }
      d.update(nowMs);
    }
  }

  /** Open the OSK for a node unless it opted out with `data-no-osk`. */
  private async maybeOpenOsk(handle: UiPanelHandle, node: number) {
    const noOsk = await handle.getAttr(node, "data-no-osk");
    if (noOsk !== null && noOsk !== undefined) return;
    if (this.oskSession) return; // an OSK may have opened meanwhile
    this.oskSession = openOsk(this.host, handle, node, {
      screenW: this.opts.screenW,
      screenH: this.opts.screenH,
      ...this.opts.osk,
    });
  }

  /** While an OSK session is open, expose it (for inspection/tests). */
  get osk(): OskSession | null { return this.oskSession; }

  dispose() {
    this.oskSession?.close(false);
    this.oskSession = null;
    this.ctrls.clear();
    this.order = [];
    this.pads.clear();
  }
}
