// ============================================================================
// TouchOsd — on-screen display for mobile touch controls
// ============================================================================
//
// Renders two layers above the game canvas (and below the pixi-ui overlay):
//
//   1. A joystick canvas (z-index 40, pointer-events: none) that draws the
//      movement joystick base ring + thumb at the active move-touch position.
//      The joystick appears where the move touch starts and fades out shortly
//      after the touch ends (show-on-touch, fade-when-idle). A faint hint ring
//      in the left-half zone is drawn when fully idle.
//
//   2. DOM action buttons (z-index 60, pointer-events: auto) for jump, mine,
//      place, zoom in/out, and hotbar slots 0-8. Buttons are semi-transparent
//      circles styled with inline CSS (no external CSS dependency). Pressing a
//      button routes through the TouchInputAdapter's action methods so the
//      input flows through the same sink as touch drags.
//
// Both layers are appended to document.body (not #root, which is
// pointer-events: none) and removed on dispose().
//
// z-index stacking (see downdraft-base.css):
//   game canvas     z 0   (pointer-events auto — touch adapter listens here)
//   pixi-ui canvas  z 50  (pointer-events none/auto — pass-through overlay)
//   OSD joystick    z 55  (pointer-events none — touches pass through)
//   OSD buttons     z 60  (pointer-events auto — buttons capture their taps)
//   DOM #root       z 100 (pointer-events none — React/Solid UI)

import type { TouchInputAdapter } from "./touch-input-adapter";

export type TouchOsdButtonId =
  | "jump"
  | "mine"
  | "place"
  | "zoom-in"
  | "zoom-out"
  | { hotbar: number }; // 0-8

export interface TouchOsdOptions {
  /** The adapter to read joystick state from + route button presses to. */
  adapter: TouchInputAdapter;
  /** Which action buttons to render. Empty array = joystick-only. */
  buttons?: TouchOsdButtonId[];
  /** Auto-hide the joystick shortly after the move touch ends. Default true. */
  fadeOnIdle?: boolean;
  /** Idle fade delay in ms. Default 250. */
  fadeDelayMs?: number;
}

interface ButtonHandle {
  el: HTMLDivElement;
  press: () => void;
  release: () => void;
}

const HOTBAR_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

export class TouchOsd {
  private adapter: TouchInputAdapter;
  private buttons: TouchOsdButtonId[];
  private fadeOnIdle: boolean;
  private fadeDelayMs: number;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private rafId = 0;
  private buttonEls: ButtonHandle[] = [];

  // Fade state: opacity 0..1, target opacity, last release timestamp.
  private opacity = 0;
  private targetOpacity = 0;
  private lastActiveTime = 0;

  constructor(options: TouchOsdOptions) {
    this.adapter = options.adapter;
    this.buttons = options.buttons ?? [];
    this.fadeOnIdle = options.fadeOnIdle ?? true;
    this.fadeDelayMs = options.fadeDelayMs ?? 250;

    // --- Joystick canvas (z 55, pointer-events none) ---
    // z-index 55 sits above the pixi-ui overlay canvas (z 50) so the joystick
    // is visible even when the overlay has pointer-events: auto (pass-through
    // mode). The joystick canvas itself is pointer-events: none, so touches
    // pass through to the pixi-ui canvas beneath.
    this.canvas = document.createElement("canvas");
    this.canvas.dataset.ddOsd = "joystick";
    this.canvas.style.position = "fixed";
    this.canvas.style.inset = "0";
    this.canvas.style.width = "100vw";
    this.canvas.style.height = "100vh";
    this.canvas.style.zIndex = "55";
    this.canvas.style.pointerEvents = "none";
    this.canvas.style.display = "block";
    document.body.appendChild(this.canvas);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("TouchOsd: 2D context unavailable");
    this.ctx = ctx;
    this.resizeCanvas();

    // --- Action buttons (z 60, pointer-events auto) ---
    this.createButtons();

    // --- Start the render loop ---
    this.loop = this.loop.bind(this);
    this.rafId = requestAnimationFrame(this.loop);

    // Resize observer to keep the joystick canvas in sync with viewport.
    window.addEventListener("resize", this.onResize);
  }

  /** Update the list of buttons. Rebuilds the DOM buttons. */
  setButtons(buttons: TouchOsdButtonId[]): void {
    this.buttons = buttons;
    this.destroyButtons();
    this.createButtons();
  }

  private onResize = (): void => {
    this.resizeCanvas();
  };

  private resizeCanvas(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // --- Buttons ---

  private createButtons(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;

    // Layout strategy:
    //   - Jump/Mine/Place: cluster in the bottom-right corner.
    //   - Zoom in/out: top-right corner.
    //   - Hotbar 1-9: compact row along the bottom edge, centered.
    const actionBtns = this.buttons.filter((b) => typeof b === "string") as string[];
    const hotbarBtns = this.buttons
      .filter((b): b is { hotbar: number } => typeof b === "object" && b !== null)
      .map((b) => b.hotbar);

    // Action buttons (jump/mine/place/zoom) — bottom-right cluster.
    const actionSize = Math.max(56, Math.min(88, Math.floor(Math.min(w, h) * 0.11)));
    const actionGap = Math.floor(actionSize * 0.35);
    const actionRight = Math.floor(w * 0.04);
    const actionBottom = Math.floor(h * 0.06);
    // Order bottom-up so "jump" is highest (closest to thumb reach).
    const order: string[] = ["zoom-in", "zoom-out", "place", "mine", "jump"];
    let actionY = h - actionBottom - actionSize;
    const seen = new Set<string>();
    for (const id of order) {
      if (!actionBtns.includes(id) || seen.has(id)) continue;
      seen.add(id);
      this.makeActionButton(id as TouchOsdButtonId, w - actionRight - actionSize, actionY, actionSize);
      actionY -= actionSize + actionGap;
    }
    // Any action buttons not in the canonical order (defensive) — stack below.
    for (const id of actionBtns) {
      if (seen.has(id)) continue;
      seen.add(id);
      this.makeActionButton(id as TouchOsdButtonId, w - actionRight - actionSize, actionY, actionSize);
      actionY -= actionSize + actionGap;
    }

    // Hotbar row — bottom edge, centered.
    if (hotbarBtns.length > 0) {
      const hbSize = Math.max(40, Math.min(56, Math.floor(Math.min(w, h) * 0.075)));
      const hbGap = Math.floor(hbSize * 0.25);
      const totalW = hotbarBtns.length * hbSize + (hotbarBtns.length - 1) * hbGap;
      const startX = Math.floor((w - totalW) / 2);
      const hbY = h - Math.floor(h * 0.04) - hbSize;
      hotbarBtns.forEach((slot, i) => {
        this.makeHotbarButton(slot, startX + i * (hbSize + hbGap), hbY, hbSize);
      });
    }
  }

  private makeActionButton(id: TouchOsdButtonId, x: number, y: number, size: number): void {
    const label = this.buttonLabel(id);
    const el = this.makeButtonEl(x, y, size, label);
    const { press, release } = this.buttonActions(id);
    this.wireButton(el, press, release);
    this.buttonEls.push({ el, press, release });
  }

  private makeHotbarButton(slot: number, x: number, y: number, size: number): void {
    const label = HOTBAR_KEYS[slot] ?? String(slot + 1);
    const el = this.makeButtonEl(x, y, size, label);
    const press = () => this.adapter.selectHotbarSlot(slot);
    const release = () => { /* hotbar is a tap, no hold state */ };
    this.wireButton(el, press, release);
    this.buttonEls.push({ el, press, release });
  }

  private makeButtonEl(x: number, y: number, size: number, label: string): HTMLDivElement {
    const el = document.createElement("div");
    el.dataset.ddOsd = "button";
    el.textContent = label;
    Object.assign(el.style, {
      position: "fixed",
      left: `${x}px`,
      top: `${y}px`,
      width: `${size}px`,
      height: `${size}px`,
      borderRadius: "50%",
      background: "rgba(40, 50, 70, 0.45)",
      border: "2px solid rgba(180, 200, 230, 0.55)",
      color: "rgba(230, 240, 255, 0.9)",
      fontFamily: "ui-monospace, monospace",
      fontSize: `${Math.floor(size * 0.4)}px`,
      fontWeight: "700",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      userSelect: "none",
      webkitUserSelect: "none",
      touchAction: "none",
      zIndex: "60",
      pointerEvents: "auto",
      transition: "background 80ms, transform 80ms",
    } as Partial<CSSStyleDeclaration>);
    document.body.appendChild(el);
    return el;
  }

  private wireButton(el: HTMLDivElement, press: () => void, release: () => void): void {
    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      el.style.background = "rgba(80, 120, 200, 0.7)";
      el.style.transform = "scale(0.92)";
      press();
    };
    const onUp = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      el.style.background = "rgba(40, 50, 70, 0.45)";
      el.style.transform = "scale(1)";
      release();
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointerleave", onUp);
    el.addEventListener("pointercancel", onUp);
    // Store handlers for cleanup via dataset closure (el is removed on dispose).
    (el as any).__osdCleanup = () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointerleave", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
  }

  private buttonLabel(id: TouchOsdButtonId): string {
    switch (id) {
      case "jump": return "↑";
      case "mine": return "⛏";
      case "place": return "▣";
      case "zoom-in": return "+";
      case "zoom-out": return "−";
      default: return "?";
    }
  }

  private buttonActions(id: TouchOsdButtonId): { press: () => void; release: () => void } {
    switch (id) {
      case "jump":
        return {
          press: () => this.adapter.pressJump(),
          release: () => this.adapter.releaseJump(),
        };
      case "mine":
        return {
          press: () => this.adapter.pressButton(0),
          release: () => this.adapter.releaseButton(0),
        };
      case "place":
        return {
          press: () => this.adapter.pressButton(2),
          release: () => this.adapter.releaseButton(2),
        };
      case "zoom-in":
        return {
          press: () => this.adapter.zoom(1),
          release: () => { /* zoom is a tap */ },
        };
      case "zoom-out":
        return {
          press: () => this.adapter.zoom(-1),
          release: () => { /* zoom is a tap */ },
        };
      default:
        return { press: () => {}, release: () => {} };
    }
  }

  private destroyButtons(): void {
    for (const { el } of this.buttonEls) {
      (el as any).__osdCleanup?.();
      el.remove();
    }
    this.buttonEls = [];
  }

  // --- Render loop ---

  private loop(): void {
    this.draw();
    this.rafId = requestAnimationFrame(this.loop);
  }

  private draw(): void {
    const ctx = this.ctx;
    const w = window.innerWidth;
    const h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);

    const joy = this.adapter.getMoveJoystick();
    const now = performance.now();

    if (joy) {
      this.targetOpacity = 1;
      this.lastActiveTime = now;
    } else if (this.fadeOnIdle) {
      // Fade out after the idle delay.
      this.targetOpacity = (now - this.lastActiveTime) > this.fadeDelayMs ? 0 : this.opacity;
    } else {
      this.targetOpacity = 0;
    }

    // Ease opacity toward target.
    const fadeSpeed = 1 / Math.max(60, this.fadeDelayMs * 0.6); // per-frame step
    if (this.opacity < this.targetOpacity) {
      this.opacity = Math.min(this.targetOpacity, this.opacity + fadeSpeed);
    } else if (this.opacity > this.targetOpacity) {
      this.opacity = Math.max(this.targetOpacity, this.opacity - fadeSpeed);
    }

    if (this.opacity <= 0.01) {
      // Draw a faint hint ring in the left-half zone when fully idle.
      this.drawHintRing(ctx, w, h);
      return;
    }

    ctx.globalAlpha = this.opacity;

    if (joy) {
      const baseRadius = 48;
      const thumbRadius = 24;
      // Clamp the thumb within the base radius.
      let dx = joy.currentX - joy.startX;
      let dy = joy.currentY - joy.startY;
      const dist = Math.hypot(dx, dy);
      const maxDist = baseRadius;
      if (dist > maxDist) {
        dx = (dx / dist) * maxDist;
        dy = (dy / dist) * maxDist;
      }
      const thumbX = joy.startX + dx;
      const thumbY = joy.startY + dy;

      // Base ring
      ctx.beginPath();
      ctx.arc(joy.startX, joy.startY, baseRadius, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(180, 200, 230, 0.6)";
      ctx.lineWidth = 3;
      ctx.stroke();
      // Inner fill
      ctx.beginPath();
      ctx.arc(joy.startX, joy.startY, baseRadius, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(40, 50, 70, 0.25)";
      ctx.fill();

      // Thumb
      ctx.beginPath();
      ctx.arc(thumbX, thumbY, thumbRadius, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(120, 160, 220, 0.7)";
      ctx.fill();
      ctx.strokeStyle = "rgba(200, 220, 240, 0.8)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  }

  private drawHintRing(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    // Faint ring in the bottom-left to hint at the movement zone.
    const cx = Math.floor(w * 0.18);
    const cy = Math.floor(h * 0.72);
    const r = 48;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(180, 200, 230, 0.12)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  /** Tear down: cancel rAF, remove canvas + buttons, detach listeners. */
  dispose(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    window.removeEventListener("resize", this.onResize);
    this.destroyButtons();
    this.canvas.remove();
  }
}
