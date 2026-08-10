export type Vec2 = { x: number; y: number };

export interface InputState {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jump: boolean;
  mouseDown: boolean;
  mouseRight: boolean;
  mouseX: number;
  mouseY: number;
  lastMouseX: number;
  lastMouseY: number;
  hasLastMouse: boolean;
  selectedMaterial: number;
  brushRadius: number;
}

export interface Camera2DState {
  x: number;
  y: number;
  zoom: number;
}
