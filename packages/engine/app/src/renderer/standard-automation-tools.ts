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
//       renderOnce: () => renderer.renderOnce(),
//       input: () => renderer.getInputHandler(),   // { injectInput, clearInjectedInput }
//       getPlayerState: (i) => readPlayer(i),
//       getWorldState: () => readWorld(),
//       getUiState: () => useGameStore.getState(),
//       extraTools: [...gameSpecificTools],
//     }),
//   });
// ============================================================================

import { KEY, type RenderSurface } from "@downdraft/engine";
import type { InspectableRegistry } from "@downdraft/engine/libraries/inspectable";
import { createLogger } from "@downdraft/engine/util/logger";
import { downdraft } from "./index";
import {
    blobToBase64,
    createMcpHarness,
    errorResult,
    jsonResult,
    type McpToolRegistration
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
  | "get_element_style"
  | "inspectable_list"
  | "inspectable_get"
  | "inspectable_set";

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
  /** The game render surface (layer 0). Used by capture_screenshot + dispatch_click. */
  surface: RenderSurface | (() => RenderSurface | null);

  /**
   * Render one frame when the render loop is paused (deterministic mode), so
   * screenshots reflect current state. Called by capture_screenshot when the
   * game reports not-running. Omit if the canvas is always live.
   */
  renderOnce?: () => void;
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
   * InspectableRegistry for the inspectable_list/get/set tools — schema'd
   * read/write nodes over game state (player customization, settings, …) so
   * agents mutate semantics directly instead of synthesizing input. Nodes'
   * set() callbacks route through the game's normal apply pipeline.
   */
  inspectables?: InspectableRegistry;

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

function resolveSurface(surface: StandardAutomationContext["surface"]): RenderSurface | null {
  return typeof surface === "function" ? surface() : surface;
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
          "Capture the current frame as a PNG image. By default composites the game canvas with the UI overlay (HUD, menus, etc.). Set fullPage=false to capture only the game canvas. Returns the image inline as base64.",
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
        const surface = resolveSurface(ctx.surface);
        if (!surface) return errorResult("Surface not available");
        const fullPage = (params.fullPage as boolean | undefined) ?? ctx.fullPageDefault ?? true;
        const width = surface.width;
        const height = surface.height;

        // If the render loop is paused (test/headless mode), render one frame
        // first so the screenshot reflects current simulation state.
        if (ctx.isRunning && !ctx.isRunning()) ctx.renderOnce?.();

        if (fullPage) {
          // Host capture: captureFrame() returns the fully composited
          // swapchain (game + all overlay layers) — no DOM composite
          // needed.
          if (typeof downdraft?.captureFrame === "function") {
            try {
              const framePng = await downdraft.captureFrame();
              if (framePng && framePng.byteLength > 0) {
                const u8 = new Uint8Array(framePng);
                let bin = "";
                for (let i = 0; i < u8.length; i += 0x8000) {
                  bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
                }
                const base64 = btoa(bin);
                return {
                  content: [
                    { type: "text", text: JSON.stringify({ width, height, fullPage: true }, null, 2) },
                    { type: "image", data: base64, mimeType: "image/png" },
                  ],
                };
              }
            } catch (e) {
              log.warn("mcp", `Host frame capture failed, falling back to canvas-only: ${(e as Error).message}`);
            }
          }
        }

        // Surface-only capture. toBlob is a canvas-compat API — it exists on
        // HTMLCanvasElement and the native surface's canvas-compat layer,
        // but is not part of the RenderSurface contract.
        const toBlob = (surface as { toBlob?: (cb: (b: Blob | null) => void, type?: string) => void }).toBlob;
        if (typeof toBlob !== "function") {
          return errorResult("Screenshot capture requires canvas.toBlob or a host captureFrame()");
        }
        const blob = await new Promise<Blob | null>((resolve) => {
          toBlob.call(surface, (b) => resolve(b), "image/png");
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
            ctrlKey: { type: "boolean", default: false },
            shiftKey: { type: "boolean", default: false },
            altKey: { type: "boolean", default: false },
            metaKey: { type: "boolean", default: false },
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
          ctrlKey: !!params.ctrlKey, shiftKey: !!params.shiftKey,
          altKey: !!params.altKey, metaKey: !!params.metaKey,
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
      handler: async (params: Record<string, unknown>) => {
        const surface = resolveSurface(ctx.surface);
        if (!surface) return errorResult("Surface not available");
        // Coordinates are input-space (backing-buffer px) — the default
        // must center in that space, not CSS px, at scaleFactor ≠ 1.
        const x = (params.x as number) ?? surface.width / 2;
        const y = (params.y as number) ?? surface.height / 2;
        const type = (params.type as string) ?? "click";
        const button = (params.button as number) ?? 0;
        const rect = surface.getBoundingClientRect();
        const clientX = rect.left + x;
        const clientY = rect.top + y;
        // There is no DOM tree — the surface itself is the input target.
        const target = surface as unknown as EventTarget;
        // MiniEventTarget (native event target) has no capture/bubble —
        // mirror DOM propagation by also dispatching on window.
        const fire = (ev: Event) => {
          target.dispatchEvent(ev);
          (window as any).dispatchEvent?.(ev);
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
          // movementX/Y: real MouseEvents default them to 0 — leaving them
          // undefined makes unguarded consumers (`yaw += e.movementX`) go
          // NaN, which poisons the camera transform and blanks the scene.
          if (isPointer && PtrEvent) {
            fire(new PtrEvent(name, {
              bubbles: true, cancelable: true, clientX, clientY, button, buttons,
              pointerId: 1, pointerType: "mouse", isPrimary: true,
              movementX: 0, movementY: 0,
            }));
          } else if (!isPointer) {
            fire(new MouseEvent(name, { bubbles: true, cancelable: true, clientX, clientY, button, buttons, movementX: 0, movementY: 0 }));
          }
        };
        if (type === "click") {
          // A real click is a full press/release cycle — UI hit-testing needs
          // the pointerdown→pointerup pair to register press and click. The
          // native blitz doc hit-tests on pointer position, so a pointermove
          // must precede the pair to place the cursor on the target first.
          fireOne("pointermove", true, 0);
          fireOne("mousemove", false, 0);
          fireOne("pointerdown", true, downMask);
          fireOne("mousedown", false, downMask);
          // Blitz registers the press on its frame tick — down and up in the
          // same JS turn never cross a frame boundary, so no click fires.
          // Hold the press across ~2 frames like a real click.
          await new Promise((r) => setTimeout(r, 80));
          fireOne("pointerup", true, 0);
          fireOne("mouseup", false, 0);
          fireOne("click", false, 0);
          // Blitz resolves the press→click on the next pointer event, so a
          // trailing move flushes the click through.
          fireOne("pointermove", true, 0);
          fireOne("mousemove", false, 0);
        } else {
          const buttons = type === "mouseup" || type === "mousemove" ? 0 : downMask;
          const pointerType = POINTER_COMPANION[type];
          if (pointerType) fireOne(pointerType, true, buttons);
          fireOne(type, false, buttons);
        }
        const targetEl = target as { tagName?: string; id?: string; className?: unknown };
        return jsonResult({
          dispatched: true, x, y, type,
          targetTag: targetEl.tagName ?? targetEl.id ?? "surface",
          targetClass: targetEl.className?.toString().slice(0, 80),
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

  // ── inspectable_list / inspectable_get / inspectable_set ──
  const inspectables = ctx.inspectables;
  if (want("inspectable_list") && inspectables) {
    tools.push({
      def: {
        name: "inspectable_list",
        description:
          "List the game's inspectable state nodes — schema'd read/write points over game state " +
          "(player customization, settings, etc.). Returns each node's path, type, valid " +
          "range/options, readOnly flag, and current value. Mutate them with inspectable_set " +
          "instead of synthesizing input — writes run through the game's normal apply pipeline.",
        inputSchema: {
          type: "object",
          properties: {
            prefix: { type: "string", description: "Limit to nodes under this path prefix (e.g. 'player.customization')" },
            tree: { type: "boolean", default: false, description: "Also return a nested tree keyed by path segments" },
          },
        },
      },
      handler: (params: Record<string, unknown>) => {
        const prefix = params.prefix as string | undefined;
        const nodes = inspectables.list(prefix).map((info) => {
          let value: unknown, error: string | undefined;
          try {
            value = inspectables.get(info.path).value;
          } catch (e) {
            error = (e as Error).message;
          }
          return { ...info, value, error };
        });
        return jsonResult({
          nodes,
          ...(params.tree ? { tree: inspectables.tree(prefix) } : {}),
        });
      },
    });
  }
  if (want("inspectable_get") && inspectables) {
    tools.push({
      def: {
        name: "inspectable_get",
        description: "Read the current value and schema of a single inspectable node. Discover paths with inspectable_list.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Node path (e.g. 'player.customization.girth')" },
          },
          required: ["path"],
        },
      },
      handler: (params: Record<string, unknown>) => {
        const path = params.path as string;
        try {
          return jsonResult({ ...inspectables.describe(path), ...inspectables.get(path) });
        } catch (e) {
          return errorResult((e as Error).message);
        }
      },
    });
  }
  if (want("inspectable_set") && inspectables) {
    tools.push({
      def: {
        name: "inspectable_set",
        description:
          "Write a value to an inspectable node (see inspectable_list for paths, types, and valid " +
          "options/ranges). The write is validated then routed through the game's apply function — " +
          "engine side-effects (mesh re-resolution, sim dispatch, saves) happen as if the game's " +
          "own UI had made the change. Returns the post-write value.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Node path (e.g. 'player.customization.girth')" },
            value: { description: "JSON value matching the node's declared type" },
          },
          required: ["path", "value"],
        },
      },
      handler: async (params: Record<string, unknown>) => {
        try {
          const res = await inspectables.set(params.path as string, params.value);
          return jsonResult({ applied: true, ...res });
        } catch (e) {
          return errorResult((e as Error).message);
        }
      },
    });
  }

  return [...tools, ...(ctx.extraTools ?? [])];
}

// ── createGameMcp — one-liner harness setup ──
//
// Every game ended the same way: wrap createStandardAutomationTools() in
// createMcpHarness() inside a try/catch, deriving serverName from the host
// appId. This folds that ceremony into one call:
//
//   createGameMcp({
//     appId: "downdraft-mygame",           // → serverName "<appId>-automation"
//     surface: () => renderer.getSurface(),
//     getUiState: () => store.getState(),
//     tools: [...gameSpecificTools],
//   });
//
// Non-fatal by design — logs a warning and returns when the host bridge or
// tool construction fails (matches the per-game try/catch it replaces).
export interface GameMcpOptions extends StandardAutomationContext {
  /** Host appId (e.g. "downdraft-falling-sand") — serverName becomes `<appId>-automation`. */
  appId: string;
  /** Game-specific tools appended after the standard set (alias of extraTools). */
  tools?: McpToolRegistration[];
  /** MCP server version. Default "0.1.0". */
  serverVersion?: string;
}

export function createGameMcp(opts: GameMcpOptions): void {
  const { appId, tools, serverVersion, ...ctx } = opts;
  try {
    createMcpHarness({
      serverName: `${appId}-automation`,
      serverVersion,
      tools: createStandardAutomationTools({
        ...ctx,
        extraTools: [...(ctx.extraTools ?? []), ...(tools ?? [])],
      }),
    });
  } catch (e) {
    log.warn("mcp", `${appId} automation harness setup failed (non-fatal): ${e}`);
  }
}
