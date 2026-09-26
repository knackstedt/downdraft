// ============================================================================
// createStandardAutomationTools — the standard MCP automation tool set.
//
// Games previously hand-rolled ~10 identical tools in their mcp/setup.ts
// (to-the-ocean, overburden, sandjongg): capture_screenshot, inject_input,
// clear_injected_input, dispatch_key, dispatch_click, wait_for_condition,
// set_test_state, get_player_state, get_world_state, get_ui_state, plus the
// DOM-inspection trio (get_element_bounds, inspect_dom, get_element_style).
//
// This factory centralizes them. Everything game-specific is injected via
// the context object — state providers, input injector, render hooks.
//
// Usage:
//
//   createMcpHarness({
//     serverName: "downdraft-mygame-automation",
//     tools: createStandardAutomationTools({
//       canvas: () => renderer.getCanvas(),
//       renderOneFrame: () => renderer.renderOneFrame(),
//       input: () => renderer.getInputHandler(),   // { injectInput, clearInjectedInput }
//       getPlayerState: (i) => readPlayer(i),
//       getWorldState: () => readWorld(),
//       getUiState: () => useGameStore.getState(),
//       extraTools: [...gameSpecificTools],
//     }),
//   });
// ============================================================================

import { KEY } from "@downdraft/engine";
import { createLogger } from "@downdraft/engine/util/logger";
import { downdraft } from "./index";
import {
    blobToBase64,
    compositeScreenshot,
    errorResult,
    jsonResult,
    type McpToolRegistration,
} from "./mcp-harness";

const log = createLogger("info");

// ── Types ──

/** Standard injected-input frame shape (matches the per-game handlers'). */
export interface InjectedInputFrame {
  keys: Set<number>;
  leftMouse: boolean;
  rightMouse: boolean;
  mouseDx: number;
  mouseDy: number;
  wheel: number;
  framesRemaining: number;
}

/** Minimal input-injection surface for inject_input/clear_injected_input. */
export interface StandardInputInjector {
  injectInput(frame: InjectedInputFrame): void;
  clearInjectedInput(): void;
}

export type StandardToolName =
  | "capture_screenshot"
  | "inject_input"
  | "clear_injected_input"
  | "dispatch_key"
  | "dispatch_click"
  | "wait_for_condition"
  | "set_test_state"
  | "get_player_state"
  | "get_world_state"
  | "get_ui_state"
  | "get_element_bounds"
  | "inspect_dom"
  | "get_element_style";

// dispatch_click: real pointer input produces a pointer* event before its
// compat mouse* event (pointerdown→mousedown, pointermove→mousemove,
// pointerup→mouseup).
const POINTER_COMPANION: Record<string, string> = {
  mousedown: "pointerdown",
  mouseup: "pointerup",
  mousemove: "pointermove",
};
// DOM `buttons` bitmask per `button` index (0=left→1, 1=middle→4, 2=right→2).
const MOUSE_BUTTON_MASK = [1, 4, 2];

// dispatch_key: KeyboardEventInit carries no keyCode, but engine UI code
// (e.g. UITextInput) reads it — derive the legacy DOM value from `key`.
const DOM_KEY_CODES: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18,
  Pause: 19, CapsLock: 20, Escape: 27, " ": 32, PageUp: 33, PageDown: 34,
  End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39,
  ArrowDown: 40, Insert: 45, Delete: 46, Meta: 91,
};
function domKeyCodeFor(key: string): number {
  if (key.length === 1) {
    const c = key.toUpperCase().charCodeAt(0);
    if (c >= 32 && c <= 126) return c;
  }
  return DOM_KEY_CODES[key] ?? 0;
}

export interface StandardAutomationContext {
  /** The game canvas (layer 0). Used by capture_screenshot + dispatch_click. */
  canvas: HTMLCanvasElement | (() => HTMLCanvasElement | null);

  /**
   * Extra canvases to composite between the game canvas and the DOM overlay
   * in full-page screenshots (e.g. a 2D tile canvas). Default: none.
   */
  extraLayers?: () => HTMLCanvasElement[];

  /**
   * Render one frame when the render loop is paused (deterministic mode), so
   * screenshots reflect current state. Called by capture_screenshot when the
   * game reports not-running. Omit if the canvas is always live.
   */
  renderOneFrame?: () => void;
  /** Whether the render loop is running. Default: true (always live). */
  isRunning?: () => boolean;
  /**
   * Default value of the `fullPage` param in capture_screenshot when the
   * caller omits it. Default: true (composite game canvas + DOM overlay).
   */
  fullPageDefault?: boolean;

  /**
   * Input injector for inject_input / clear_injected_input. Typically
   * `() => renderer.getInputHandler()`. Omit to exclude those tools.
   */
  input?: () => StandardInputInjector | null;
  /** Key-name → DOM keyCode overrides merged over core's KEY map. */
  keyMap?: Record<string, number>;

  /**
   * State providers for the get_*_state tools and wait_for_condition's
   * `player`/`world`/`tick` variables. Omit any to exclude that tool; a
   * missing provider also removes the corresponding variable from
   * wait_for_condition (it will be undefined).
   */
  /**
   * The playerIndex param is `undefined` when the caller omits it, so
   * providers can apply a game-specific default (e.g. the active player).
   */
  getPlayerState?: (playerIndex: number | undefined) => unknown;
  getWorldState?: () => unknown | Promise<unknown>;
  getUiState?: () => unknown;

  /**
   * Extra variables exposed to wait_for_condition expressions, keyed by name.
   * E.g. `{ ui: () => store.getState() }` exposes `ui` in the predicate.
   */
  conditionVars?: Record<string, () => unknown>;

  /**
   * Game-specific test-state handler for set_test_state — receives the raw
   * params (minus the built-in keys handled here: pauseRendering,
   * resumeRendering, targetFPS). Omit to exclude the built-in tool.
   */
  setTestState?: (params: Record<string, unknown>) => void | Promise<void>;
  /** Pause the render loop (set_test_state pauseRendering). */
  pauseRendering?: () => void;
  /** Resume the render loop (set_test_state resumeRendering). */
  resumeRendering?: () => void;
  /** Set a target FPS cap (set_test_state targetFPS). */
  setTargetFPS?: (fps: number) => void;

  /** Game-specific tools appended to the standard set. */
  extraTools?: McpToolRegistration[];
  /** Restrict to a subset of standard tools. Default: all applicable. */
  include?: StandardToolName[];
  /** Exclude standard tools by name. Default: none. */
  exclude?: StandardToolName[];
}

// ── Helpers ──

const DEFAULT_KEY_MAP: Record<string, number> = { ...KEY };

function resolveKeys(keys: (string | number)[], keyMap: Record<string, number>): Set<number> {
  const out = new Set<number>();
  keys.forEach((k) => {
    if (typeof k === "number") out.add(k);
    else {
      const code = keyMap[k.toUpperCase()];
      if (code !== undefined) out.add(code);
    }
  });
  return out;
}

function resolveCanvas(canvas: StandardAutomationContext["canvas"]): HTMLCanvasElement | null {
  return typeof canvas === "function" ? canvas() : canvas;
}

// ── Factory ──

/**
 * Build the standard MCP automation tool set. Returns McpToolRegistration[]
 * suitable for `createMcpHarness({ tools })`.
 */
export function createStandardAutomationTools(ctx: StandardAutomationContext): McpToolRegistration[] {
  const keyMap = { ...DEFAULT_KEY_MAP, ...ctx.keyMap };
  const tools: McpToolRegistration[] = [];

  const want = (name: StandardToolName): boolean => {
    if (ctx.include && !ctx.include.includes(name)) return false;
    if (ctx.exclude?.includes(name)) return false;
    return true;
  };

  // ── capture_screenshot ──
  if (want("capture_screenshot")) {
    tools.push({
      def: {
        name: "capture_screenshot",
        description:
          "Capture the current frame as a PNG image. By default composites the game canvas with the DOM/React overlay (HUD, menus, etc.). Set fullPage=false to capture only the game canvas. Returns the image inline as base64.",
        inputSchema: {
          type: "object",
          properties: {
            fullPage: {
              type: "boolean",
              default: true,
              description: "If true, composite the game canvas + extra layers + DOM overlay. If false, capture only the game canvas.",
            },
          },
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const canvas = resolveCanvas(ctx.canvas);
        if (!canvas) return errorResult("Canvas not available");
        const fullPage = (params.fullPage as boolean | undefined) ?? ctx.fullPageDefault ?? true;
        const width = canvas.width;
        const height = canvas.height;

        // If the render loop is paused (test/headless mode), render one frame
        // first so the screenshot reflects current simulation state.
        if (ctx.isRunning && !ctx.isRunning()) ctx.renderOneFrame?.();

        if (fullPage) {
          if (typeof downdraft?.capturePage === "function") {
            try {
              const overlayPng = await downdraft.capturePage();
              if (overlayPng && overlayPng.byteLength > 0) {
                // Composite: game canvas → extra layers → DOM overlay.
                const offscreen = document.createElement("canvas");
                offscreen.width = width;
                offscreen.height = height;
                const off2d = offscreen.getContext("2d");
                if (off2d) {
                  off2d.drawImage(canvas, 0, 0, width, height);
                  (ctx.extraLayers?.() ?? []).forEach((layer) => {
                    off2d.drawImage(layer, 0, 0, width, height);
                  });
                  const overlayBlob = new Blob([overlayPng], { type: "image/png" });
                  const overlayBitmap = await createImageBitmap(overlayBlob);
                  off2d.drawImage(overlayBitmap, 0, 0, width, height);
                  overlayBitmap.close();
                  const blob = await new Promise<Blob | null>((resolve) => {
                    offscreen.toBlob((b) => resolve(b), "image/png");
                  });
                  if (blob) {
                    const base64 = await blobToBase64(blob);
                    return {
                      content: [
                        { type: "text", text: JSON.stringify({ width, height, fullPage: true }, null, 2) },
                        { type: "image", data: base64, mimeType: "image/png" },
                      ],
                    };
                  }
                }
                // Fall back to the shared 2-layer composite.
                const blob = await compositeScreenshot(canvas, overlayPng, width, height);
                if (blob) {
                  const base64 = await blobToBase64(blob);
                  return {
                    content: [
                      { type: "text", text: JSON.stringify({ width, height, fullPage: true }, null, 2) },
                      { type: "image", data: base64, mimeType: "image/png" },
                    ],
                  };
                }
              }
            } catch (e) {
              log.warn("MCP", `Composite screenshot failed, falling back to canvas-only: ${(e as Error).message}`);
            }
          }
        }

        // Canvas-only capture.
        const blob = await new Promise<Blob | null>((resolve) => {
          canvas.toBlob((b) => resolve(b), "image/png");
        });
        if (!blob) return errorResult("Screenshot capture failed");
        const base64 = await blobToBase64(blob);
        return {
          content: [
            { type: "text", text: JSON.stringify({ width, height, fullPage: false }, null, 2) },
            { type: "image", data: base64, mimeType: "image/png" },
          ],
        };
      },
    });
  }

  // ── inject_input ──
  if (want("inject_input") && ctx.input) {
    tools.push({
      def: {
        name: "inject_input",
        description: "Inject keyboard/mouse input for a number of frames. Useful for automation tests when no real user is interacting with the game.",
        inputSchema: {
          type: "object",
          properties: {
            playerIndex: { type: "number", description: "Player slot index", default: 0 },
            keys: {
              type: "array",
              items: { type: "string" },
              description: "Key names to hold (e.g. ['W','A','SPACE']) or keyCodes if numbers",
              default: [],
            },
            leftMouse: { type: "boolean", default: false },
            rightMouse: { type: "boolean", default: false },
            mouseDx: { type: "number", default: 0 },
            mouseDy: { type: "number", default: 0 },
            wheel: { type: "number", default: 0 },
            frames: { type: "number", description: "Number of frames to hold the input", default: 1 },
          },
        },
      },
      handler: (params: Record<string, unknown>) => {
        const input = ctx.input!();
        if (!input) return errorResult("Input handler not initialized");
        const frames = Math.max(1, Math.floor((params.frames as number) ?? 1));
        input.injectInput({
          keys: resolveKeys((params.keys as (string | number)[]) ?? [], keyMap),
          leftMouse: !!params.leftMouse,
          rightMouse: !!params.rightMouse,
          mouseDx: (params.mouseDx as number) ?? 0,
          mouseDy: (params.mouseDy as number) ?? 0,
          wheel: (params.wheel as number) ?? 0,
          framesRemaining: frames,
        });
        return jsonResult({ injected: true, frames, playerIndex: (params.playerIndex as number) ?? 0 });
      },
    });
  }

  // ── clear_injected_input ──
  if (want("clear_injected_input") && ctx.input) {
    tools.push({
      def: {
        name: "clear_injected_input",
        description: "Clear any pending injected input frames.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: () => {
        const input = ctx.input!();
        if (!input) return errorResult("Input handler not initialized");
        input.clearInjectedInput();
        return jsonResult({ cleared: true });
      },
    });
  }

  // ── dispatch_key ──
  if (want("dispatch_key")) {
    tools.push({
      def: {
        name: "dispatch_key",
        description: "Dispatch a real DOM keyboard event on the main thread (keydown or keyup). This tests the full input pipeline: DOM event → game handler.",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string", description: "Key value (e.g. 'i', 'Tab', 'Escape')" },
            code: { type: "string", description: "Key code (e.g. 'KeyI', 'Tab', 'Escape')" },
            type: { type: "string", enum: ["keydown", "keyup"], default: "keydown" },
            repeat: { type: "boolean", default: false },
          },
          required: ["key"],
        },
      },
      handler: (params: Record<string, unknown>) => {
        const key = params.key as string;
        const code = (params.code as string) ?? key;
        const type = (params.type as string) ?? "keydown";
        const ev = new KeyboardEvent(type, {
          key, code, keyCode: domKeyCodeFor(key),
          bubbles: true, cancelable: true, repeat: !!params.repeat,
        } as KeyboardEventInit);
        // Real KeyboardEvent ignores keyCode in the init dict — force it.
        try { Object.defineProperty(ev, "keyCode", { value: domKeyCodeFor(key) }); } catch { /* polyfill already set it */ }
        window.dispatchEvent(ev);
        return jsonResult({ dispatched: true, key, code, type });
      },
    });
  }

  // ── dispatch_click ──
  if (want("dispatch_click")) {
    tools.push({
      def: {
        name: "dispatch_click",
        description: "Dispatch a real DOM click event at canvas-relative coordinates. The event hits the topmost element at that point (mimics a real user click through UI overlays).",
        inputSchema: {
          type: "object",
          properties: {
            x: { type: "number", description: "X coordinate (default: center of canvas)" },
            y: { type: "number", description: "Y coordinate (default: center of canvas)" },
            type: { type: "string", enum: ["click", "mousedown", "mouseup", "mousemove", "wheel"], default: "click", description: "Event type — 'click' fires the full press/release sequence (pointerdown→mousedown→pointerup→mouseup→click); mousedown/mouseup/mousemove fire just that event plus its pointer* companion. 'wheel' fires a WheelEvent with deltaX/deltaY." },
            button: { type: "number", description: "Mouse button (0=left, 1=middle, 2=right). Default 0." },
            deltaX: { type: "number", description: "Wheel deltaX in pixels (type=wheel only). Default 0." },
            deltaY: { type: "number", description: "Wheel deltaY in pixels (type=wheel only). Default 120 (one detent down)." },
          },
        },
      },
      handler: (params: Record<string, unknown>) => {
        const canvas = resolveCanvas(ctx.canvas);
        if (!canvas) return errorResult("Canvas not available");
        const x = (params.x as number) ?? canvas.clientWidth / 2;
        const y = (params.y as number) ?? canvas.clientHeight / 2;
        const type = (params.type as string) ?? "click";
        const button = (params.button as number) ?? 0;
        const rect = canvas.getBoundingClientRect();
        const clientX = rect.left + x;
        const clientY = rect.top + y;
        const target = document.elementFromPoint(clientX, clientY) ?? canvas;
        // MiniEventTarget (native DOM polyfill) has no capture/bubble —
        // mirror real propagation by also dispatching on window. In a real
        // DOM this would double-fire, so only do it under the polyfill.
        const isNativeDom = typeof (globalThis as any).__nativeHost !== "undefined";
        const fire = (ev: Event) => {
          target.dispatchEvent(ev);
          if (isNativeDom) (window as any).dispatchEvent?.(ev);
        };
        if (type === "wheel") {
          const deltaX = (params.deltaX as number) ?? 0;
          const deltaY = (params.deltaY as number) ?? 120;
          fire(new WheelEvent("wheel", {
            bubbles: true, cancelable: true, clientX, clientY, deltaX, deltaY, deltaMode: 0,
          }));
          return jsonResult({ dispatched: true, x, y, type, deltaX, deltaY });
        }
        // Real pointer input produces the pointer* event before its compat
        // mouse* event. RendererInputBus listens on pointer*; older UI code
        // listens on mouse* — emit both so either sees a real click.
        const PtrEvent = (globalThis as any).PointerEvent;
        const downMask = MOUSE_BUTTON_MASK[button] ?? 1;
        const fireOne = (name: string, isPointer: boolean, buttons: number) => {
          if (isPointer && PtrEvent) {
            fire(new PtrEvent(name, {
              bubbles: true, cancelable: true, clientX, clientY, button, buttons,
              pointerId: 1, pointerType: "mouse", isPrimary: true,
            }));
          } else if (!isPointer) {
            fire(new MouseEvent(name, { bubbles: true, cancelable: true, clientX, clientY, button, buttons }));
          }
        };
        if (type === "click") {
          // A real click is a full press/release cycle — UI hit-testing needs
          // the pointerdown→pointerup pair to register press and click.
          fireOne("pointerdown", true, downMask);
          fireOne("mousedown", false, downMask);
          fireOne("pointerup", true, 0);
          fireOne("mouseup", false, 0);
          fireOne("click", false, 0);
        } else {
          const buttons = type === "mouseup" || type === "mousemove" ? 0 : downMask;
          const pointerType = POINTER_COMPANION[type];
          if (pointerType) fireOne(pointerType, true, buttons);
          fireOne(type, false, buttons);
        }
        return jsonResult({
          dispatched: true, x, y, type,
          targetTag: target.tagName,
          targetClass: (target as HTMLElement).className?.toString().slice(0, 80),
        });
      },
    });
  }

  // ── wait_for_condition ──
  if (want("wait_for_condition")) {
    tools.push({
      def: {
        name: "wait_for_condition",
        description: "Poll until a condition on game state is met or a timeout occurs. Conditions are JS predicate expressions evaluated against named state variables (e.g. 'player.position[1] < -2').",
        inputSchema: {
          type: "object",
          properties: {
            condition: {
              type: "string",
              description: "JavaScript predicate expression. Variables: player, world, tick (when providers configured) plus any conditionVars.",
            },
            timeoutMs: { type: "number", default: 5000, description: "Maximum time to wait in milliseconds" },
            intervalMs: { type: "number", default: 50, description: "Polling interval" },
          },
          required: ["condition"],
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const condition = params.condition as string;
        const timeoutMs = (params.timeoutMs as number) ?? 5000;
        const intervalMs = (params.intervalMs as number) ?? 50;
        const start = performance.now();

        const extraNames = Object.keys(ctx.conditionVars ?? {});
        const names = ["player", "world", "tick", ...extraNames];

        return new Promise((resolve) => {
          const check = async () => {
            const player = ctx.getPlayerState?.(0) ?? null;
            const world = (await ctx.getWorldState?.()) ?? null;
            const tick = (world as { tick?: number } | null)?.tick ?? 0;
            const extraValues = extraNames.map((n) => ctx.conditionVars![n]());
            try {
              // eslint-disable-next-line no-new-func
              const fn = new Function(...names, `"use strict"; return (${condition});`);
              if (fn(player, world, tick, ...extraValues)) {
                resolve(jsonResult({ satisfied: true, elapsedMs: performance.now() - start, player, world }));
                return;
              }
            } catch (e) {
              resolve(errorResult(`Condition evaluation error: ${(e as Error).message}`));
              return;
            }
            if (performance.now() - start > timeoutMs) {
              resolve(errorResult(`Timeout waiting for condition: ${condition}`));
              return;
            }
            setTimeout(check, intervalMs);
          };
          check();
        });
      },
    });
  }

  // ── set_test_state ──
  if (want("set_test_state") && (ctx.setTestState || ctx.pauseRendering || ctx.resumeRendering || ctx.setTargetFPS)) {
    tools.push({
      def: {
        name: "set_test_state",
        description: "Set deterministic game state for tests. Built-in keys: pauseRendering, resumeRendering, targetFPS. Additional keys are forwarded to the game's setTestState handler.",
        inputSchema: {
          type: "object",
          properties: {
            pauseRendering: { type: "boolean", description: "Pause the continuous render loop to save CPU. Screenshot capture still works (renders on demand)." },
            resumeRendering: { type: "boolean", description: "Resume the continuous render loop." },
            targetFPS: { type: "number", description: "Set a target FPS limit for the render loop (0 = unlimited)." },
          },
        },
      },
      handler: async (params: Record<string, unknown>) => {
        if (params.pauseRendering) ctx.pauseRendering?.();
        if (params.resumeRendering) ctx.resumeRendering?.();
        if (params.targetFPS !== undefined) ctx.setTargetFPS?.(params.targetFPS as number);
        if (ctx.setTestState) {
          const { pauseRendering: _p, resumeRendering: _r, targetFPS: _t, ...rest } = params;
          await ctx.setTestState(rest);
        }
        return jsonResult({ applied: true, params });
      },
    });
  }

  // ── get_player_state ──
  if (want("get_player_state") && ctx.getPlayerState) {
    tools.push({
      def: {
        name: "get_player_state",
        description: "Read the current state of a player from the simulation SharedArrayBuffer.",
        inputSchema: {
          type: "object",
          properties: { playerIndex: { type: "number", default: 0 } },
        },
      },
      handler: (params: Record<string, unknown>) => {
        const playerIndex = params.playerIndex as number | undefined;
        const state = ctx.getPlayerState!(playerIndex);
        if (state === null || state === undefined) return errorResult(`Player ${playerIndex} not available`);
        return jsonResult(state);
      },
    });
  }

  // ── get_world_state ──
  if (want("get_world_state") && ctx.getWorldState) {
    tools.push({
      def: {
        name: "get_world_state",
        description: "Read global simulation state (tick, entity count, weather, etc.).",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        const state = await ctx.getWorldState!();
        if (state === null || state === undefined) return errorResult("World state not available");
        return jsonResult(state);
      },
    });
  }

  // ── get_ui_state ──
  if (want("get_ui_state") && ctx.getUiState) {
    tools.push({
      def: {
        name: "get_ui_state",
        description: "Read the current UI store state (menu visibility, pointer lock, readiness flags, etc.).",
        inputSchema: { type: "object", properties: {} },
      },
      handler: () => jsonResult(ctx.getUiState!()),
    });
  }

  // ── get_element_bounds ──
  if (want("get_element_bounds")) {
    tools.push({
      def: {
        name: "get_element_bounds",
        description: "Get the bounding box of a DOM element matching a CSS selector. Returns {x, y, width, height, top, left, bottom, right} or found:false.",
        inputSchema: {
          type: "object",
          properties: { selector: { type: "string", description: "CSS selector" } },
          required: ["selector"],
        },
      },
      handler: (params: Record<string, unknown>) => {
        const selector = params.selector as string;
        try {
          const el = document.querySelector(selector);
          if (!el) return jsonResult({ found: false, selector });
          const rect = el.getBoundingClientRect();
          return jsonResult({
            found: true, selector,
            x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right,
          });
        } catch (e) {
          return errorResult(`Failed to query selector "${selector}": ${(e as Error).message}`);
        }
      },
    });
  }

  // ── inspect_dom ──
  if (want("inspect_dom")) {
    tools.push({
      def: {
        name: "inspect_dom",
        description: "Inspect the main thread's DOM for debugging CSS/layout issues. 'stylesheets' lists all <style>/<link> tags; 'element' gets details for a selector.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["stylesheets", "element"] },
            selector: { type: "string", description: "CSS selector (for action='element')" },
          },
          required: ["action"],
        },
      },
      handler: (params: Record<string, unknown>) => {
        const action = params.action as string;
        if (action === "stylesheets") {
          const styles = Array.from(document.querySelectorAll("style, link[rel='stylesheet']")).map((el) => {
            const tag = el.tagName.toLowerCase();
            if (tag === "style") {
              const text = el.textContent ?? "";
              return { tag, length: text.length, preview: text.slice(0, 200) };
            }
            return { tag, href: (el as HTMLLinkElement).href };
          });
          return jsonResult({ stylesheets: styles, count: styles.length });
        }
        if (action === "element" && params.selector) {
          const el = document.querySelector(params.selector as string);
          if (!el) return jsonResult({ found: false, selector: params.selector });
          const cs = getComputedStyle(el);
          return jsonResult({
            found: true,
            selector: params.selector,
            tagName: el.tagName,
            className: el.className,
            id: el.id,
            style: {
              width: cs.width, height: cs.height,
              maxWidth: cs.maxWidth, maxHeight: cs.maxHeight,
              display: cs.display, position: cs.position,
              top: cs.top, left: cs.left, overflow: cs.overflow,
            },
            bounds: el.getBoundingClientRect().toJSON(),
            childCount: el.children.length,
          });
        }
        return errorResult("Invalid action or missing selector");
      },
    });
  }

  // ── get_element_style ──
  if (want("get_element_style")) {
    tools.push({
      def: {
        name: "get_element_style",
        description: "Get computed style of a DOM element matching a CSS selector. Pass properties[] to read specific CSS properties.",
        inputSchema: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector" },
            properties: { type: "array", items: { type: "string" }, description: "CSS properties to read" },
          },
          required: ["selector"],
        },
      },
      handler: (params: Record<string, unknown>) => {
        const selector = params.selector as string;
        const props = (params.properties as string[]) ?? [];
        try {
          const el = document.querySelector(selector);
          if (!el) return jsonResult({ found: false, selector });
          const cs = getComputedStyle(el);
          const result: Record<string, unknown> = { found: true, selector };
          props.forEach((p) => { result[p] = cs.getPropertyValue(p);; });
          result._className = el.className;
          return jsonResult(result);
        } catch (e) {
          return errorResult(`Failed to query style for "${selector}": ${(e as Error).message}`);
        }
      },
    });
  }

  return [...tools, ...(ctx.extraTools ?? [])];
}
