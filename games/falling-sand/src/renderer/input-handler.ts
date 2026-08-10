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
    mouseX: 0,
    mouseY: 0,
    selectedMaterial: 1,
    brushRadius: 3,
    magnet: false,
  };

  function onKey(e: KeyboardEvent, down: boolean) {
    if (e.key === "a" || e.key === "A" || e.key === "ArrowLeft") state.left = down;
    if (e.key === "d" || e.key === "D" || e.key === "ArrowRight") state.right = down;
    if (e.key === "w" || e.key === "W" || e.key === "ArrowUp") state.up = down;
    if (e.key === "s" || e.key === "S" || e.key === "ArrowDown") state.down = down;
    if (e.key === " " || e.key === "Spacebar") state.jump = down;
    if (e.key === "e" || e.key === "E") {
      if (down) state.magnet = !state.magnet;
    }
  }

  window.addEventListener("keydown", (e) => onKey(e, true));
  window.addEventListener("keyup", (e) => onKey(e, false));

  canvas.addEventListener("mousedown", (e) => {
    if (e.button === 0) state.mouseDown = true;
    if (e.button === 2) state.mouseRight = true;
    e.preventDefault();
  });
  canvas.addEventListener("mouseup", (e) => {
    if (e.button === 0) state.mouseDown = false;
    if (e.button === 2) state.mouseRight = false;
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    state.mouseX = (e.clientX - rect.left) * dpr;
    state.mouseY = (e.clientY - rect.top) * dpr;
  });

  return state;
}
