// ============================================================================
// Input handler — pointer events on the tile canvas overlay.
// ============================================================================

export interface InputHandler {
  mouseX: number;
  mouseY: number;
  selectedCol: number;  // -1 = none
  selectedRow: number;  // -1 = none
  hasClick: boolean;    // true when a new click occurred (consumed by renderer)
  clickCol: number;
  clickRow: number;
  destroy(): void;
}

export function createInputHandler(canvas: HTMLCanvasElement): InputHandler {
  const state: InputHandler = {
    mouseX: 0,
    mouseY: 0,
    selectedCol: -1,
    selectedRow: -1,
    hasClick: false,
    clickCol: -1,
    clickRow: -1,
    destroy() {},
  };

  const getCanvasPos = (e: PointerEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return {
      x: (e.clientX - rect.left) * dpr,
      y: (e.clientY - rect.top) * dpr,
    };
  };

  const onPointerMove = (e: PointerEvent): void => {
    const pos = getCanvasPos(e);
    state.mouseX = pos.x;
    state.mouseY = pos.y;
  };

  const onPointerDown = (e: PointerEvent): void => {
    const pos = getCanvasPos(e);
    state.mouseX = pos.x;
    state.mouseY = pos.y;
    state.hasClick = true;
    // clickCol/clickRow are set by the renderer after hit-testing.
    state.clickCol = -1;
    state.clickRow = -1;
  };

  canvas.style.pointerEvents = "auto";
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerdown", onPointerDown);

  state.destroy = () => {
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerdown", onPointerDown);
  };

  return state;
}
