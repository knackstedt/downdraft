import type { InputState } from "../shared/types";

export function createInputHandler(canvas: HTMLCanvasElement): InputState {
  const state: InputState = {
    mouseDown: false,
    mouseRight: false,
    mouseX: 0,
    mouseY: 0,
    lastMouseX: 0,
    lastMouseY: 0,
    hasLastMouse: false,
    selectedMaterial: 1,
    brushRadius: 4,
  };

  function toCanvasCoords(e: MouseEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  canvas.addEventListener("mousedown", (e) => {
    if (e.button === 0) state.mouseDown = true;
    if (e.button === 2) state.mouseRight = true;
    const { x, y } = toCanvasCoords(e);
    state.mouseX = x;
    state.mouseY = y;
    state.hasLastMouse = false;
    e.preventDefault();
  });
  canvas.addEventListener("mouseup", (e) => {
    if (e.button === 0) state.mouseDown = false;
    if (e.button === 2) state.mouseRight = false;
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("auxclick", (e) => e.preventDefault());

  canvas.addEventListener("mousemove", (e) => {
    const { x, y } = toCanvasCoords(e);
    state.lastMouseX = state.mouseX;
    state.lastMouseY = state.mouseY;
    state.mouseX = x;
    state.mouseY = y;
    state.hasLastMouse = true;
  });

  return state;
}
