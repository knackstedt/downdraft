// ============================================================================
// Input handler — captures keyboard + mouse input for Blockheads.
//
// Keyboard: WASD/arrows for movement, Space for jump, +/- for zoom,
//   number keys 1-9 for hotbar block selection.
// Mouse: left-click for mining, right-click for placing, middle/right-drag
//   for panning, wheel for zoom.
// ============================================================================

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
}

export function createInputHandler(canvas: HTMLCanvasElement): BlockheadsInputState {
  const rect0 = canvas.getBoundingClientRect();
  const state: BlockheadsInputState = {
    left: false,
    right: false,
    up: false,
    down: false,
    jump: false,
    noclip: false,
    mouseDown: false,
    mouseX: rect0.width / 2,
    mouseY: rect0.height / 2,
    mouseRight: false,
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
  };

  const keyMap: Record<string, keyof BlockheadsInputState> = {
    "a": "left",
    "A": "left",
    "ArrowLeft": "left",
    "d": "right",
    "D": "right",
    "ArrowRight": "right",
    "w": "up",
    "W": "up",
    "ArrowUp": "up",
    "s": "down",
    "S": "down",
    "ArrowDown": "down",
    " ": "jump",
    "Space": "jump",
  };

  window.addEventListener("keydown", (e) => {
    const key = keyMap[e.key];
    if (key) {
      (state[key] as boolean) = true;
      e.preventDefault();
      return;
    }
    // Zoom
    if (e.key === "=" || e.key === "+") {
      state.zoomDelta += 1;
      e.preventDefault();
    } else if (e.key === "-" || e.key === "_") {
      state.zoomDelta -= 1;
      e.preventDefault();
    }
    // Hotbar selection (1-9)
    else if (e.key >= "1" && e.key <= "9") {
      state.selectedSlot = parseInt(e.key, 10) - 1;
      e.preventDefault();
    }
    // Noclip toggle (F3)
    else if (e.key === "F3") {
      state.noclip = !state.noclip;
      e.preventDefault();
    }
  });

  window.addEventListener("keyup", (e) => {
    const key = keyMap[e.key];
    if (key) {
      (state[key] as boolean) = false;
      e.preventDefault();
    }
  });

  canvas.addEventListener("mousedown", (e) => {
    if (state.taskMode) {
      // Middle-click (button 1) starts panning in task mode
      if (e.button === 1) {
        state.panning = true;
        state.panStartX = e.clientX;
        state.panStartY = e.clientY;
        e.preventDefault();
        return;
      }
      // Left/right click → queue task
      const rect = canvas.getBoundingClientRect();
      state.taskClickPending = true;
      state.taskClickButton = e.button;
      state.taskClickX = e.clientX - rect.left;
      state.taskClickY = e.clientY - rect.top;
      return;
    }
    if (e.button === 0) state.mouseDown = true;
    if (e.button === 2) state.mouseRight = true;
    // Middle-click panning in normal mode too
    if (e.button === 1) {
      state.panning = true;
      state.panStartX = e.clientX;
      state.panStartY = e.clientY;
      e.preventDefault();
    }
  });

  window.addEventListener("mouseup", (e) => {
    if (e.button === 0) state.mouseDown = false;
    if (e.button === 2) state.mouseRight = false;
    if (e.button === 1) state.panning = false;
  });

  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    state.mouseX = e.clientX - rect.left;
    state.mouseY = e.clientY - rect.top;
  });

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  // Mouse wheel for zoom (scroll up = zoom in, scroll down = zoom out)
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.deltaY < 0) {
      state.zoomDelta += 1;
    } else if (e.deltaY > 0) {
      state.zoomDelta -= 1;
    }
  }, { passive: false });

  return state;
}
