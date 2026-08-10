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
  selectedMaterial: number;
  brushRadius: number;
  magnet: boolean;
}

export interface Camera2DState {
  x: number;
  y: number;
  zoom: number;
}
