// ============================================================================
// Input handler — captures keyboard + mouse input for the mining RPG.
//
// Keyboard: WASD/arrows for movement, Space for jump, P for pause,
//   "=" to zoom in, "-" to zoom out.
// Mouse: left-click for digging, position tracked in screen pixels (converted
// to world coords by the renderer using the camera).
// ============================================================================

export interface MiningInputState {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jump: boolean;
  mouseDown: boolean;
  mouseRight: boolean;
  mouseX: number; // screen pixels
  mouseY: number; // screen pixels
  digRadius: number;
  // Accumulated zoom steps since the last frame. Each "=" keydown adds +1,
  // each "-" keydown adds -1 (OS key-repeat produces a steady stream while
  // held). The renderer drains this each frame and applies
  //   zoom *= ZOOM_STEP_FACTOR ^ zoomDelta
  // then resets it to 0.
  zoomDelta: number;
  // Edge-triggered: set true on F keydown, consumed by the renderer each frame.
  fPressed: boolean;
  // Edge-triggered: set true on G keydown, consumed by the renderer each frame.
  gPressed: boolean;
  // Edge-triggered: set true on F1 keydown, consumed by the renderer each
  // frame. Toggles fog-of-war + shadows (lighting) off for debugging.
  f1Pressed: boolean;
}

export function createMiningInputHandler(canvas: HTMLCanvasElement): MiningInputState {
  // Initialize mouse to the center of the canvas so that before the user
  // moves the mouse, screenToWorld maps to the viewport center (roughly
  // where the player is) instead of the top-left corner (0,0). Without
  // this, right-clicking to throw a bomb before moving the mouse would
  // throw it up-and-to-the-left toward screen (0,0).
  const rect0 = canvas.getBoundingClientRect();
  const state: MiningInputState = {
    left: false,
    right: false,
    up: false,
    down: false,
    jump: false,
    mouseDown: false,
    mouseRight: false,
    mouseX: rect0.width / 2,
    mouseY: rect0.height / 2,
    digRadius: 3,
    zoomDelta: 0,
    fPressed: false,
    gPressed: false,
    f1Pressed: false,
  };

  const keyMap: Record<string, keyof MiningInputState> = {
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
    // Zoom controls — "=" (and "+", since that's the shifted form on most
    // layouts) zoom in, "-" zooms out. keydown repeats while held, which
    // produces a smooth, OS-throttled zoom stream.
    if (e.key === "=" || e.key === "+") {
      state.zoomDelta += 1;
      e.preventDefault();
    } else if (e.key === "-" || e.key === "_") {
      state.zoomDelta -= 1;
      e.preventDefault();
    } else if (e.key === "f" || e.key === "F") {
      // Edge-triggered: set true, renderer consumes and resets to false
      state.fPressed = true;
      e.preventDefault();
    } else if (e.key === "g" || e.key === "G") {
      state.gPressed = true;
      e.preventDefault();
    } else if (e.key === "F1") {
      // Edge-triggered: toggle fog-of-war + shadows. preventDefault stops the
      // browser from opening its own help overlay.
      state.f1Pressed = true;
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
    if (e.button === 0) state.mouseDown = true;
    if (e.button === 2) state.mouseRight = true;
  });

  window.addEventListener("mouseup", (e) => {
    if (e.button === 0) state.mouseDown = false;
    if (e.button === 2) state.mouseRight = false;
  });

  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    state.mouseX = e.clientX - rect.left;
    state.mouseY = e.clientY - rect.top;
  });

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  return state;
}
