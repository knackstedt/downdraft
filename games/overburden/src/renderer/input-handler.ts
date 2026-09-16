// ============================================================================
// Input handler — thin adapter over core's createDomInputHandler.
//
// The DOM event wiring (keyMap, mouse buttons, canvas coords, wheel,
// contextmenu suppression, destroy) is engine-provided; this file exposes the
// legacy flat-field shape the renderer reads each frame plus the game-owned
// fields (hotbar slot, task mode, panning, debug inspect, callbacks).
//
// Held-movement + mouse-button fields are get/set pairs over the engine's
// InputState so the MCP inject_input tools can still drive them directly.
// ============================================================================

import { createDomInputHandler, type DomInputHandler } from "@downdraft/core";

export interface BlockheadsInputState {
  // Movement
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jump: boolean;
  noclip: boolean;

  // Mining (left mouse)
  mouseDown: boolean;
  mouseX: number; // screen pixels
  mouseY: number; // screen pixels

  // Placing (right mouse)
  mouseRight: boolean;

  // Hotbar selection (1-9)
  selectedSlot: number;

  // Accumulated zoom steps since last frame
  zoomDelta: number;

  // Task mode (toggle with T): clicks queue tasks instead of direct mining/placing
  taskMode: boolean;
  // Pending task click (set by mousedown in task mode, consumed by renderer)
  taskClickPending: boolean;
  taskClickButton: number; // 0 = left (mine), 2 = right (move)
  taskClickX: number; // screen pixels
  taskClickY: number; // screen pixels

  // Camera panning (middle-mouse drag, or arrow keys in task mode)
  panning: boolean;
  panStartX: number;
  panStartY: number;

  // Debug cell inspect (toggle with F6): when active, a left-click logs the
  // block data for all 4 render depth layers at the clicked cell.
  debugInspect: boolean;
  // Pending inspect click (set by mousedown when debugInspect is on, consumed
  // once by the renderer so it logs exactly once per click).
  inspectClickPending: boolean;
  inspectClickX: number; // screen pixels
  inspectClickY: number; // screen pixels

  // Debug force fruit spawn (F7): when pressed, rolls the fruit-spawn dice
  // for all fruit-capable leaf blocks immediately. Consumed once by the
  // renderer which calls workerHost.forceFruitSpawn().
  forceFruitSpawnPending: boolean;

  // Character gender toggle (C key): when pressed, switches between male/female
  // player models. The renderer sets this callback to wire into CharacterPass.
  onToggleGender?: () => void;

  // Map mode toggle (M key / Esc when in map mode): when pressed, snaps
  // between full map view and the previous zoom level. The renderer wires
  // this to toggle the camera zoom + recenter on the player.
  onToggleMap?: () => void;
  // Exit map mode (Esc when in map mode): restore the pre-map zoom. The
  // renderer checks isMapMode() before acting so Esc still works as pause
  // when not in map mode.
  onExitMap?: () => void;

  // Cycle active blockhead (Tab / Shift+Tab). The renderer wires this to
  // cycle which blockhead receives direct WASD/mouse input.
  onCycleActiveBh?: (reverse: boolean) => void;

  // Use the active hotbar item (G key). The renderer wires this to call the
  // worker's useItem RPC (e.g. spawn egg).
  onUseItem?: () => void;

  /** Underlying engine handler (update()/injectInput()/destroy()). */
  readonly handler: DomInputHandler;
  /** Remove DOM listeners (hot-reload safe). */
  destroy(): void;
}

export function createInputHandler(canvas: HTMLCanvasElement): BlockheadsInputState {
  // Game-owned fields not covered by the shared handler.
  const game = {
    noclip: false,
    selectedSlot: 0,
    zoomDelta: 0,
    taskMode: false,
    taskClickPending: false,
    taskClickButton: 0,
    taskClickX: 0,
    taskClickY: 0,
    panning: false,
    panStartX: 0,
    panStartY: 0,
    debugInspect: false,
    inspectClickPending: false,
    inspectClickX: 0,
    inspectClickY: 0,
    forceFruitSpawnPending: false,
  };

  const cbs: {
    onToggleGender?: () => void;
    onToggleMap?: () => void;
    onExitMap?: () => void;
    onCycleActiveBh?: (reverse: boolean) => void;
    onUseItem?: () => void;
  } = {};

  const handler = createDomInputHandler({
    canvas,
    preset: "wasd", // a/d/w/s/arrows + space → left/right/up/down/jump
    mouseCoords: "css", // screen pixels (renderer maps through the camera)
    onKeyPress: {
      // Zoom
      "=": (e) => { game.zoomDelta += 1; e.preventDefault(); },
      "+": (e) => { game.zoomDelta += 1; e.preventDefault(); },
      "-": (e) => { game.zoomDelta -= 1; e.preventDefault(); },
      "_": (e) => { game.zoomDelta -= 1; e.preventDefault(); },
      // Hotbar selection (1-9)
      "1": (e) => { game.selectedSlot = 0; e.preventDefault(); },
      "2": (e) => { game.selectedSlot = 1; e.preventDefault(); },
      "3": (e) => { game.selectedSlot = 2; e.preventDefault(); },
      "4": (e) => { game.selectedSlot = 3; e.preventDefault(); },
      "5": (e) => { game.selectedSlot = 4; e.preventDefault(); },
      "6": (e) => { game.selectedSlot = 5; e.preventDefault(); },
      "7": (e) => { game.selectedSlot = 6; e.preventDefault(); },
      "8": (e) => { game.selectedSlot = 7; e.preventDefault(); },
      "9": (e) => { game.selectedSlot = 8; e.preventDefault(); },
      // Noclip toggle (F3)
      F3: (e) => { game.noclip = !game.noclip; e.preventDefault(); },
      // Debug cell inspect toggle (F6)
      F6: (e) => {
        game.debugInspect = !game.debugInspect;
        console.log(`[Overburden] Cell inspect ${game.debugInspect ? "enabled" : "disabled"} (F6) — click a cell to log its 4 render layers`);
        e.preventDefault();
      },
      // Debug force fruit spawn (F7): roll the fruit-spawn dice for all
      // fruit-capable leaves immediately (without waiting for the daily tick).
      F7: (e) => { game.forceFruitSpawnPending = true; e.preventDefault(); },
      // Character gender toggle (C key)
      c: (e) => { cbs.onToggleGender?.(); e.preventDefault(); },
      C: (e) => { cbs.onToggleGender?.(); e.preventDefault(); },
      // Map mode toggle (M key): snap to full map or restore previous zoom.
      m: (e) => { cbs.onToggleMap?.(); e.preventDefault(); },
      M: (e) => { cbs.onToggleMap?.(); e.preventDefault(); },
      // Cycle active blockhead (Tab / Shift+Tab)
      Tab: (e) => { cbs.onCycleActiveBh?.(e.shiftKey); e.preventDefault(); },
      // Use active hotbar item (G key) — e.g. spawn egg
      g: (e) => { cbs.onUseItem?.(); e.preventDefault(); },
      G: (e) => { cbs.onUseItem?.(); e.preventDefault(); },
      // Esc: exit map mode (if active). The renderer's onExitMap checks
      // isMapMode() so this is a no-op when not in map mode, letting Esc
      // fall through to the app's pause handler. Don't preventDefault.
      Escape: () => { cbs.onExitMap?.(); },
    },
    onMouseDown: (e, pos) => {
      // Debug cell inspect: left-click logs the 4 render layers at the cell.
      // Handled before task-mode/mining so it works in every mode; it only
      // logs and doesn't suppress the normal click behavior.
      if (game.debugInspect && e.button === 0) {
        game.inspectClickPending = true;
        game.inspectClickX = pos.x;
        game.inspectClickY = pos.y;
      }
      if (e.button === 1) {
        // Middle-click panning in both modes.
        game.panning = true;
        game.panStartX = e.clientX;
        game.panStartY = e.clientY;
        e.preventDefault();
        return;
      }
      if (game.taskMode) {
        // Left/right click → queue task (mouseDown/mouseRight getters are
        // masked while taskMode is on, so the worker doesn't also mine).
        game.taskClickPending = true;
        game.taskClickButton = e.button;
        game.taskClickX = pos.x;
        game.taskClickY = pos.y;
      }
    },
    onMouseUp: (e) => {
      if (e.button === 1) game.panning = false;
    },
    onWheel: (e) => {
      // Shared handler already accumulated the notch into state.wheelDelta;
      // mirror it into the game's zoomDelta (drained by the renderer).
      game.zoomDelta += e.deltaY < 0 ? 1 : e.deltaY > 0 ? -1 : 0;
    },
  });
  const { held, state } = handler;

  const target: BlockheadsInputState = {
    // Held movement — backed by the engine's held-action bag; writable so
    // the MCP inject_input tool can drive them directly.
    get left() { return held.left ?? false; },
    set left(v: boolean) { held.left = v; },
    get right() { return held.right ?? false; },
    set right(v: boolean) { held.right = v; },
    get up() { return held.up ?? false; },
    set up(v: boolean) { held.up = v; },
    get down() { return held.down ?? false; },
    set down(v: boolean) { held.down = v; },
    get jump() { return held.jump ?? false; },
    set jump(v: boolean) { held.jump = v; },
    get noclip() { return game.noclip; },
    set noclip(v: boolean) { game.noclip = v; },

    // Mouse buttons are masked while taskMode is on — a task click queues a
    // task instead of mining/placing (matches the legacy early-return).
    get mouseDown() { return !game.taskMode && state.isMouseDown(0); },
    set mouseDown(v: boolean) { v ? state.mouseDown(0) : state.mouseUp(0); },
    get mouseRight() { return !game.taskMode && state.isMouseDown(2); },
    set mouseRight(v: boolean) { v ? state.mouseDown(2) : state.mouseUp(2); },
    get mouseX() { return state.mouseX; },
    set mouseX(v: number) { state.mouseX = v; },
    get mouseY() { return state.mouseY; },
    set mouseY(v: number) { state.mouseY = v; },

    get selectedSlot() { return game.selectedSlot; },
    set selectedSlot(v: number) { game.selectedSlot = v; },
    get zoomDelta() { return game.zoomDelta; },
    set zoomDelta(v: number) { game.zoomDelta = v; },
    get taskMode() { return game.taskMode; },
    set taskMode(v: boolean) { game.taskMode = v; },
    get taskClickPending() { return game.taskClickPending; },
    set taskClickPending(v: boolean) { game.taskClickPending = v; },
    get taskClickButton() { return game.taskClickButton; },
    set taskClickButton(v: number) { game.taskClickButton = v; },
    get taskClickX() { return game.taskClickX; },
    set taskClickX(v: number) { game.taskClickX = v; },
    get taskClickY() { return game.taskClickY; },
    set taskClickY(v: number) { game.taskClickY = v; },
    get panning() { return game.panning; },
    set panning(v: boolean) { game.panning = v; },
    get panStartX() { return game.panStartX; },
    set panStartX(v: number) { game.panStartX = v; },
    get panStartY() { return game.panStartY; },
    set panStartY(v: number) { game.panStartY = v; },
    get debugInspect() { return game.debugInspect; },
    set debugInspect(v: boolean) { game.debugInspect = v; },
    get inspectClickPending() { return game.inspectClickPending; },
    set inspectClickPending(v: boolean) { game.inspectClickPending = v; },
    get inspectClickX() { return game.inspectClickX; },
    set inspectClickX(v: number) { game.inspectClickX = v; },
    get inspectClickY() { return game.inspectClickY; },
    set inspectClickY(v: number) { game.inspectClickY = v; },
    get forceFruitSpawnPending() { return game.forceFruitSpawnPending; },
    set forceFruitSpawnPending(v: boolean) { game.forceFruitSpawnPending = v; },

    get onToggleGender() { return cbs.onToggleGender; },
    set onToggleGender(cb: (() => void) | undefined) { cbs.onToggleGender = cb; },
    get onToggleMap() { return cbs.onToggleMap; },
    set onToggleMap(cb: (() => void) | undefined) { cbs.onToggleMap = cb; },
    get onExitMap() { return cbs.onExitMap; },
    set onExitMap(cb: (() => void) | undefined) { cbs.onExitMap = cb; },
    get onCycleActiveBh() { return cbs.onCycleActiveBh; },
    set onCycleActiveBh(cb: ((reverse: boolean) => void) | undefined) { cbs.onCycleActiveBh = cb; },
    get onUseItem() { return cbs.onUseItem; },
    set onUseItem(cb: (() => void) | undefined) { cbs.onUseItem = cb; },

    handler,
    destroy: () => handler.destroy(),
  };

  return target;
}
