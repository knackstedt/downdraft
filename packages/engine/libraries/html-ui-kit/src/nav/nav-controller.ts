// ============================================================================
// nav-controller.ts — gamepad/keyboard spatial navigation over an html-ui doc.
//
// One NavController per UiPanelHandle. The doc's focusables are enumerated via
// navSnapshot (single backend roundtrip); directional moves are resolved
// locally with a directional-distance + alignment score (generalized from
// Ember's useGridFocus). `data-nav-zone` on a container creates a scope; a
// zone stack traps focus inside modals/blades and remembers the last focused
// node per zone.
//
// Focus is real DOM focus (dd_osr_focus → :focus styles) plus a
// `data-nav-focus="1"` attribute for an explicit focus ring in kit themes.
// Confirm synthesizes a pointer click at the node's rect center, so existing
// data-action/kit verb handlers work unchanged.
// ============================================================================

import type { NavNodeInfo, UiPanelHandle } from "@downdraft/engine/modules/html-ui";

export type NavDirection = "up" | "down" | "left" | "right";
export type NavAction = NavDirection | "confirm" | "cancel" | "next" | "prev" | "menu";

export interface Rect { x: number; y: number; w: number; h: number }

export interface NavControllerOptions {
  /** Selector enumerating focusable nodes. Default covers kit widgets,
   *  links, inputs and explicit opt-ins. */
  focusableSelector?: string;
  /** Initial zone restriction (a `data-nav-zone` value). */
  zone?: string;
  onConfirm?: (info: NavNodeInfo) => void;
  onCancel?: () => void;
  onMenu?: () => void;
  onMove?: (from: NavNodeInfo | null, to: NavNodeInfo | null) => void;
}

const DEFAULT_SEL =
  "[data-nav],[data-action],button,a,input,textarea,select,[tabindex],.dd-btn";

interface ZoneFrame {
  zone: string | null;
  /** Node id that was focused when this zone was left (zone memory). */
  lastFocus: number;
}

export class NavController {
  private handle: UiPanelHandle;
  private opts: NavControllerOptions;
  private nodes: NavNodeInfo[] = [];
  private dirty = true;
  private snapshotInFlight: Promise<NavNodeInfo[]> | null = null;
  /** Current focused node handle (0 = none), mirrored from focus events. */
  focused = 0;
  /** Last nav-resolved position — used when DOM focus hasn't caught up. */
  private cursor: Rect | null = null;
  private zones: ZoneFrame[] = [];
  private zoneMemory = new Map<string | null, number>();
  private unsubEvents: (() => void) | null = null;

  constructor(handle: UiPanelHandle, opts: NavControllerOptions = {}) {
    this.handle = handle;
    this.opts = opts;
    if (opts.zone !== undefined) this.zones.push({ zone: opts.zone, lastFocus: 0 });
    this.unsubEvents = handle.onEvent((ev) => {
      if (ev.t === "focus") this.focused = ev.n;
      else if (ev.t === "blur" && this.focused === ev.n) this.focused = 0;
      // Any DOM event may imply structure changed — schedule a refresh
      // lazily; the next nav action will see fresh state.
    });
  }

  /** Re-enumerate focusables. Safe to call eagerly; concurrent calls share
   *  one backend roundtrip. */
  refresh(): Promise<NavNodeInfo[]> {
    if (!this.snapshotInFlight) {
      this.snapshotInFlight = this.handle
        .navSnapshot(this.opts.focusableSelector ?? DEFAULT_SEL)
        .then((nodes) => {
          this.nodes = nodes.filter((n) => n.rect && !n.disabled);
          this.dirty = false;
          this.snapshotInFlight = null;
          return this.nodes;
        });
    }
    return this.snapshotInFlight;
  }

  /** Mark the snapshot stale (call after setHtml/mutate/resize). */
  invalidate(): void {
    this.dirty = true;
  }

  /** Push a zone scope — nav stays inside `zone` until popZone(). */
  pushZone(zone: string | null): void {
    this.zoneMemory.set(this.activeZone(), this.focused);
    this.zones.push({ zone, lastFocus: 0 });
    this.dirty = true;
  }

  /** Pop the current zone scope and restore the remembered focus. */
  popZone(): void {
    if (this.zones.length === 0) return;
    this.zones.pop();
    const remembered = this.zoneMemory.get(this.activeZone());
    this.dirty = true;
    if (remembered) void this.focusNode(remembered);
  }

  activeZone(): string | null {
    return this.zones.length ? this.zones[this.zones.length - 1].zone : null;
  }

  private candidates(): NavNodeInfo[] {
    const zone = this.activeZone();
    return zone === null ? this.nodes : this.nodes.filter((n) => n.zone === zone);
  }

  private byNode(id: number): NavNodeInfo | null {
    return this.nodes.find((n) => n.node === id) ?? null;
  }

  /** Sync lookup of the focused node in the last snapshot (may be stale —
   *  cheap check for callers that can't await, e.g. key interception). */
  focusedInfo(): NavNodeInfo | null {
    return this.focused ? this.byNode(this.focused) : null;
  }

  /** Focused node info, or the first candidate when nothing is focused yet. */
  async current(): Promise<NavNodeInfo | null> {
    if (this.dirty) await this.refresh();
    return this.cursorNode(this.candidates());
  }

  /** Dispatch one nav action. Async because the snapshot may refresh first. */
  async dispatch(action: NavAction): Promise<void> {
    if (this.dirty) await this.refresh();
    const cands = this.candidates();

    switch (action) {
      case "confirm": {
        const target = this.byNode(this.focused) ?? this.cursorNode(cands);
        if (!target) return;
        this.handle.click(target.node);
        this.opts.onConfirm?.(target);
        return;
      }
      case "cancel": {
        if (this.zones.length > 1) this.popZone();
        else this.opts.onCancel?.();
        return;
      }
      case "menu": this.opts.onMenu?.(); return;
      case "next": case "prev": {
        this.step(action === "next" ? 1 : -1, cands);
        return;
      }
      default: {
        this.spatialMove(action, cands);
      }
    }
  }

  /** Focus a specific node (DOM focus + nav-focus attr + scroll). */
  async focusNode(node: number): Promise<void> {
    const info = this.byNode(node);
    const prev = this.focused ? this.byNode(this.focused) : null;
    this.handle.mutate([
      ...(prev ? [{ op: "rattr", node: prev.node, name: "data-nav-focus" } as const] : []),
      { op: "focus", node },
      { op: "attr", node, name: "data-nav-focus", value: "1" },
      { op: "scrollIntoView", node, vertical: "nearest", horizontal: "nearest" },
    ]);
    if (info?.rect) this.cursor = info.rect;
    this.focused = node;
    this.opts.onMove?.(prev, info);
  }

  private cursorNode(cands: NavNodeInfo[]): NavNodeInfo | null {
    if (this.focused) {
      const f = this.byNode(this.focused);
      if (f && (!this.activeZone() || f.zone === this.activeZone())) return f;
    }
    return cands[0] ?? null;
  }

  /** next/prev — document-order cycle within the active zone. */
  private step(dir: 1 | -1, cands: NavNodeInfo[]): void {
    if (!cands.length) return;
    const cur = this.cursorNode(cands);
    const i = cur ? cands.indexOf(cur) : -1;
    const next = cands[(i + dir + cands.length) % cands.length];
    void this.focusNode(next.node);
  }

  /**
   * Directional pick: score = distance along the move axis + a perpendicular
   * penalty. Rejects candidates not in the move half-plane. Falls back to a
   * document-order step when nothing qualifies (edges of grids).
   */
  private spatialMove(dir: NavDirection, cands: NavNodeInfo[]): void {
    const cur = this.cursorNode(cands);
    if (!cur || !cur.rect) {
      if (cands[0]) void this.focusNode(cands[0].node);
      return;
    }
    const c = cur.rect;
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    const horiz = dir === "left" || dir === "right";
    const sign = dir === "down" || dir === "right" ? 1 : -1;

    let best: NavNodeInfo | null = null;
    let bestScore = Infinity;
    for (const n of cands) {
      if (n === cur || !n.rect) continue;
      const r = n.rect;
      const nx = r.x + r.w / 2, ny = r.y + r.h / 2;
      const primary = horiz ? (nx - cx) * sign : (ny - cy) * sign;
      const perp = horiz ? Math.abs(ny - cy) : Math.abs(nx - cx);
      if (primary <= 1) continue;
      // Strongly prefer candidates overlapping the current row/column band.
      const overlap = horiz
        ? Math.min(c.y + c.h, r.y + r.h) - Math.max(c.y, r.y)
        : Math.min(c.x + c.w, r.x + r.w) - Math.max(c.x, r.x);
      const score = primary + perp * 2.5 - Math.max(0, overlap) * 1.5;
      if (score < bestScore) { bestScore = score; best = n; }
    }
    if (best) {
      void this.focusNode(best.node);
    } else {
      // Edge of the layout — wrap in document order (couch-UI friendly).
      this.step(sign, cands);
    }
  }

  dispose(): void {
    this.unsubEvents?.();
    this.unsubEvents = null;
  }
}
