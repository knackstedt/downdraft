// ============================================================================
// Input handler — captures keyboard + mouse input for the mining RPG.
//
// Keyboard: WASD/arrows for movement, Space for jump, P for pause.
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
}

export function createMiningInputHandler(canvas: HTMLCanvasElement): MiningInputState {
  const state: MiningInputState = {
    left: false,
    right: false,
    up: false,
    down: false,
    jump: false,
    mouseDown: false,
    mouseRight: false,
    mouseX: 0,
    mouseY: 0,
    digRadius: 3,
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
