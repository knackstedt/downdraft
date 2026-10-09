// ============================================================================
// nav-input.ts — normalize input sources into NavAction events with
// edge-detection and hold-repeat.
//
// PadNavDriver polls a GamepadSource slot each frame (call update() from the
// app's frame loop). Directions come from dpad buttons AND the left stick
// (with hysteresis), repeat after an initial delay; A=confirm, B=cancel,
// START=menu, LB/RB=prev/next. KeyboardNavDriver maps arrow keys +
// Enter/Escape/Tab onto the same action stream — desktop testing without a
// pad, and arrow-key nav for free on any keyboard.
// ============================================================================

import type { GamepadSource } from "@downdraft/engine/input/local-player-manager";
import { GP_AXIS, GP_BTN } from "@downdraft/engine/sab/gamepad-devices";
import type { NavAction, NavDirection } from "./nav-controller";

export interface NavInputOptions {
  /** Stick magnitude that counts as a direction press (default 0.5). */
  stickThreshold?: number;
  /** Release threshold — must be < stickThreshold for stable edges (default 0.35). */
  stickRelease?: number;
  /** ms before a held direction repeats (default 400). */
  repeatDelayMs?: number;
  /** ms between repeats while held (default 130). */
  repeatIntervalMs?: number;
  /** Edge hook for every button transition (mapped nav buttons included) —
   *  lets apps bind unmapped buttons (SELECT-mode toggles, etc.). */
  onButtonEdge?: (bit: number, down: boolean) => void;
}

type DirectionState = { held: boolean; since: number; lastFire: number };

/** Map W3C gamepad bit + axes → NavAction edges with repeat. Frame-driven. */
export class PadNavDriver {
  private src: GamepadSource;
  private slot: number;
  private dispatch: (a: NavAction) => void;
  private opts: Required<Omit<NavInputOptions, "onButtonEdge">> & Pick<NavInputOptions, "onButtonEdge">;
  private dirs = new Map<NavDirection, DirectionState>();
  private prevBtn = 0;
  private prevDirAxis: NavDirection | null = null;

  constructor(source: GamepadSource, slot: number, dispatch: (a: NavAction) => void, opts: NavInputOptions = {}) {
    this.src = source;
    this.slot = slot;
    this.dispatch = dispatch;
    this.opts = {
      stickThreshold: opts.stickThreshold ?? 0.5,
      stickRelease: opts.stickRelease ?? 0.35,
      repeatDelayMs: opts.repeatDelayMs ?? 400,
      repeatIntervalMs: opts.repeatIntervalMs ?? 130,
    };
    for (const d of (["up", "down", "left", "right"] as const).values()) {
      this.dirs.set(d, { held: false, since: 0, lastFire: 0 });
    }
  }

  /** Poll the pad and dispatch actions. Call once per frame. */
  update(now = performance.now()): void {
    const snap = this.src.read(this.slot);
    if (!snap) { this.prevBtn = 0; this.releaseAll(); return; }

    // ── Dpad buttons + stick → direction holds ──
    const pressed = new Set<NavDirection>();
    const b = snap.buttonsLo;
    if (b & (1 << GP_BTN.DPAD_UP)) pressed.add("up");
    if (b & (1 << GP_BTN.DPAD_DOWN)) pressed.add("down");
    if (b & (1 << GP_BTN.DPAD_LEFT)) pressed.add("left");
    if (b & (1 << GP_BTN.DPAD_RIGHT)) pressed.add("right");

    const lx = snap.axes[GP_AXIS.LEFT_X] ?? 0;
    const ly = snap.axes[GP_AXIS.LEFT_Y] ?? 0;
    // Hysteresis: engage at stickThreshold, release at stickRelease.
    const axisDir = (prev: NavDirection | null): NavDirection | null => {
      const t = prev ? this.opts.stickRelease : this.opts.stickThreshold;
      if (Math.abs(lx) < t && Math.abs(ly) < t) return null;
      return Math.abs(lx) > Math.abs(ly)
        ? (lx > 0 ? "right" : "left")
        : (ly > 0 ? "down" : "up");
    };
    const stickDir = axisDir(this.prevDirAxis);
    this.prevDirAxis = stickDir;
    if (stickDir) pressed.add(stickDir);

    for (const [dir, st] of this.dirs.entries()) {
      const isDown = pressed.has(dir);
      if (isDown && !st.held) {
        st.held = true; st.since = now; st.lastFire = now;
        this.dispatch(dir);
      } else if (isDown && st.held) {
        if (now - st.since >= this.opts.repeatDelayMs
          && now - st.lastFire >= this.opts.repeatIntervalMs) {
          st.lastFire = now;
          this.dispatch(dir);
        }
      } else if (!isDown) {
        st.held = false;
      }
    }

    // ── Buttons → discrete actions (edge-triggered) ──
    const changed = b ^ this.prevBtn;
    if (changed && this.opts.onButtonEdge) {
      for (let bit = 0; bit < 20; bit++) {
        if (changed & (1 << bit)) this.opts.onButtonEdge(bit, (b & (1 << bit)) !== 0);
      }
    }
    const press = (bit: number) => (b & (1 << bit)) !== 0 && (this.prevBtn & (1 << bit)) === 0;
    if (press(GP_BTN.SOUTH)) this.dispatch("confirm");
    if (press(GP_BTN.EAST)) this.dispatch("cancel");
    if (press(GP_BTN.START)) this.dispatch("menu");
    if (press(GP_BTN.LEFT_SHOULDER)) this.dispatch("prev");
    if (press(GP_BTN.RIGHT_SHOULDER)) this.dispatch("next");
    this.prevBtn = b;
  }

  private releaseAll(): void {
    for (const st of this.dirs.values()) st.held = false;
    this.prevDirAxis = null;
  }
}

const KEY_ACTIONS: Record<number, NavAction> = {
  38: "up", 40: "down", 37: "left", 39: "right", // arrows
  13: "confirm", // Enter
  27: "cancel",  // Escape
  9: "next",     // Tab (shift+Tab → prev handled via event)
};

const KEY_NAMES: Record<string, NavAction> = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  Enter: "confirm", Escape: "cancel", Tab: "next",
};

/** Arrow-key nav for keyboard users / dev without a pad. Accepts a DOM
 *  keyCode (browser) or `key` string (native) — wire into the app's keydown
 *  path; returns false for unhandled keys. */
export function keyToNavAction(key: number | string, shiftKey = false): NavAction | null {
  if (typeof key === "number") {
    if (key === 9) return shiftKey ? "prev" : "next";
    return KEY_ACTIONS[key] ?? null;
  }
  if (key === "Tab") return shiftKey ? "prev" : "next";
  return KEY_NAMES[key] ?? null;
}
