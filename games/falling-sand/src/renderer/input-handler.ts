import { InputState } from "../shared/types";

export function createInputHandler(canvas: HTMLCanvasElement): InputState {
  const state: InputState = {
    left: false,
    right: false,
    up: false,
    down: false,
    jump: false,
    mouseDown: false,
    mouseRight: false,
    mouseMiddle: false,
    mouseX: 0,
    mouseY: 0,
    lastMouseX: 0,
    lastMouseY: 0,
    hasLastMouse: false,
    selectedMaterial: 1,
    brushRadius: 3,
  };

  function onKey(e: KeyboardEvent, down: boolean) {
    if (e.key === "a" || e.key === "A" || e.key === "ArrowLeft") state.left = down;
    if (e.key === "d" || e.key === "D" || e.key === "ArrowRight") state.right = down;
    if (e.key === "w" || e.key === "W" || e.key === "ArrowUp") state.up = down;
    if (e.key === "s" || e.key === "S" || e.key === "ArrowDown") state.down = down;
    if (e.key === " " || e.key === "Spacebar") state.jump = down;
  }

  window.addEventListener("keydown", (e) => onKey(e, true));
  window.addEventListener("keyup", (e) => onKey(e, false));

  function toCanvasCoords(e: MouseEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  canvas.addEventListener("mousedown", (e) => {
    if (e.button === 0) state.mouseDown = true;
    if (e.button === 1) state.mouseMiddle = true;
    if (e.button === 2) state.mouseRight = true;
    const { x, y } = toCanvasCoords(e);
    state.mouseX = x;
    state.mouseY = y;
    e.preventDefault();
  });
  canvas.addEventListener("mouseup", (e) => {
    if (e.button === 0) state.mouseDown = false;
    if (e.button === 1) state.mouseMiddle = false;
    if (e.button === 2) state.mouseRight = false;
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("auxclick", (e) => e.preventDefault());

  canvas.addEventListener("mousemove", (e) => {
    const { x, y } = toCanvasCoords(e);
    state.mouseX = x;
    state.mouseY = y;
  });

  return state;
}
