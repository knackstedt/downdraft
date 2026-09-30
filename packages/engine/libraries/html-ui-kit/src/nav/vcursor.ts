// ============================================================================
// vcursor.ts — controller-driven virtual cursor over html-ui panels.
//
// VirtualCursor owns a fullscreen, non-interactive overlay panel containing a
// cursor arrow; it tracks a screen-space position and routes synthetic
// pointer events (move/down/up/wheel) through host.panelAtHandle →
// handle.sendPointer, so hover, click, scroll and drag all reach the real
// doc pipeline exactly like a mouse.
//
// PadCursorDriver polls a GamepadSource slot each frame: right stick moves
// the cursor (velocity response curve), A / right-trigger clicks, and
// holding LT turns the right stick into scroll. Steam-Deck-style mapping.
// ============================================================================

import type { GamepadSource } from "@downdraft/engine/input/local-player-manager";
import type { HtmlUiHost, UiPanelHandle } from "@downdraft/engine/modules/html-ui";
import { GP_AXIS, GP_BTN } from "@downdraft/engine/sab/gamepad-devices";
import { kitStyleTag } from "../theme";

export interface VirtualCursorOptions {
  screenW: number;
  screenH: number;
  /** Overlay z-order (default 2000 — above OSK's 1000). */
  z?: number;
  /** Cursor sprite size in px (default 18). */
  size?: number;
}

const CURSOR_CSS = `
html,body { margin:0; padding:0; }
/* overflow:visible — kit's body{overflow:hidden} clips everything when the
   body has no in-flow content (all-absolute children collapse its height). */
body { background: transparent; overflow: visible; }
#vc { position:absolute; left:0; top:0; width:18px; height:18px; }
.vc-stem { position:absolute; left:0; top:1px; width:7px; height:13px;
  background:#000; }
.vc-head { position:absolute; left:7px; top:3px; width:0; height:0;
  border-top:5px solid transparent; border-bottom:5px solid transparent;
  border-left:9px solid #000; }
.vc-stem-i { position:absolute; left:1px; top:2px; width:5px; height:11px;
  background:#f5f7fa; }
.vc-head-i { position:absolute; left:7px; top:4px; width:0; height:0;
  border-top:4px solid transparent; border-bottom:4px solid transparent;
  border-left:8px solid #f5f7fa; }
`;

function cursorHtml(): string {
  return `<html><head>${kitStyleTag()}<style>${CURSOR_CSS}</style></head>
<body><div id="vc"><div class="vc-stem"></div><div class="vc-head"></div>
<div class="vc-stem-i"></div><div class="vc-head-i"></div></div></body></html>`;
}

/**
 * A mouse-like pointer driven programmatically (typically by a gamepad via
 * PadCursorDriver). Position is screen-space CSS px; events land on the
 * topmost interactive panel under the cursor, or no-one when over the world.
 */
export class VirtualCursor {
  x: number;
  y: number;
  private host: HtmlUiHost;
  private overlay: UiPanelHandle;
  private screenW: number;
  private screenH: number;
  private hover: UiPanelHandle | null = null;
  private captured: UiPanelHandle | null = null;
  private shown = true;

  constructor(host: HtmlUiHost, opts: VirtualCursorOptions) {
    this.host = host;
    this.screenW = opts.screenW;
    this.screenH = opts.screenH;
    this.x = opts.screenW / 2;
    this.y = opts.screenH / 2;
    this.overlay = host.mount({
      id: "dd-vcursor",
      rect: { x: 0, y: 0, w: opts.screenW, h: opts.screenH },
      z: opts.z ?? 2000,
      scale: 1,
      interactive: false,
      html: cursorHtml(),
    });
    this.place();
  }

  /** Screen resized — the overlay is fullscreen so it must track. */
  setScreen(w: number, h: number): void {
    this.screenW = w; this.screenH = h;
    this.overlay.setRect({ x: 0, y: 0, w, h });
    this.x = Math.min(this.x, w - 1);
    this.y = Math.min(this.y, h - 1);
    this.place();
  }

  moveBy(dx: number, dy: number): void {
    this.warp(this.x + dx, this.y + dy);
  }

  warp(x: number, y: number): void {
    this.x = Math.max(0, Math.min(this.screenW - 1, x));
    this.y = Math.max(0, Math.min(this.screenH - 1, y));
    this.place();
    if (!this.shown) return;
    const target = this.captured ?? this.host.panelAtHandle(this.x, this.y);
    this.hover = target;
    target?.sendPointer({ kind: "move", x: this.x - target.rect.x, y: this.y - target.rect.y });
  }

  press(button: "left" | "middle" | "right" = "left"): void {
    const p = this.hover ?? this.host.panelAtHandle(this.x, this.y);
    if (!p) return;
    this.captured = p;
    p.sendPointer({ kind: "down", x: this.x - p.rect.x, y: this.y - p.rect.y, button });
  }

  release(button: "left" | "middle" | "right" = "left"): void {
    const p = this.captured ?? this.host.panelAtHandle(this.x, this.y);
    this.captured = null;
    if (!p) return;
    p.sendPointer({ kind: "up", x: this.x - p.rect.x, y: this.y - p.rect.y, button });
  }

  click(button: "left" | "middle" | "right" = "left"): void {
    this.press(button);
    this.release(button);
  }

  scroll(dx: number, dy: number): void {
    const p = this.hover ?? this.host.panelAtHandle(this.x, this.y);
    p?.sendPointer({ kind: "wheel", x: this.x - p.rect.x, y: this.y - p.rect.y, deltaX: dx, deltaY: dy });
  }

  setVisible(v: boolean): void {
    this.shown = v;
    this.overlay.setStyle("#vc", "visibility", v ? "visible" : "hidden");
  }

  private place(): void {
    this.overlay.mutate([
      { op: "style", sel: "#vc", prop: "left", value: `${this.x}px` },
      { op: "style", sel: "#vc", prop: "top", value: `${this.y}px` },
    ]);
  }

  dispose(): void {
    this.overlay.dispose();
  }
}

export interface PadCursorOptions {
  /** Cursor speed at full deflection, px/s (default 700). */
  speed?: number;
  /** Right-stick deadzone (default 0.18). */
  deadzone?: number;
  /** Response exponent — >1 gives precision near center (default 1.6). */
  exponent?: number;
  /** Wheel delta per second at full stick while LT held (default 600). */
  scrollSpeed?: number;
}

/** Right stick → cursor motion; A or RT → click; LT held → stick scrolls. */
export class PadCursorDriver {
  private prevClick = false;

  constructor(
    private src: GamepadSource,
    private slot: number,
    private cursor: VirtualCursor,
    private opts: Required<PadCursorOptions> = {
      speed: 700, deadzone: 0.18, exponent: 1.6, scrollSpeed: 600,
    },
  ) {}

  update(dtMs: number): void {
    const snap = this.src.read(this.slot);
    if (!snap) { this.prevClick = false; return; }
    const o = this.opts;
    const dz = o.deadzone;
    const rx = snap.axes[GP_AXIS.RIGHT_X] ?? 0;
    const ry = snap.axes[GP_AXIS.RIGHT_Y] ?? 0;
    const lt = snap.axes[GP_AXIS.LEFT_TRIGGER] ?? 0;
    const rt = snap.axes[GP_AXIS.RIGHT_TRIGGER] ?? 0;

    const curve = (v: number) => {
      const m = Math.abs(v);
      if (m < dz) return 0;
      return Math.sign(v) * Math.pow((m - dz) / (1 - dz), o.exponent);
    };
    const dt = dtMs / 1000;
    const vx = curve(rx), vy = curve(ry);
    if (lt > 0.4) {
      // Scroll mode: right stick becomes wheel deltas.
      if (vx || vy) this.cursor.scroll(vx * o.scrollSpeed * dt, vy * o.scrollSpeed * dt);
    } else if (vx || vy) {
      this.cursor.moveBy(vx * o.speed * dt, vy * o.speed * dt);
    }

    const click = (snap.buttonsLo & (1 << GP_BTN.SOUTH)) !== 0 || rt > 0.6;
    if (click && !this.prevClick) this.cursor.press();
    if (!click && this.prevClick) this.cursor.release();
    this.prevClick = click;
  }
}
