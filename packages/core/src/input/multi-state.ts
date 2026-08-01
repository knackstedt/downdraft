import { InputState } from "./state.ts";

export class MultiInputState {
  private states: InputState[];
  private maxPlayers: number;

  constructor(maxPlayers: number = 8) {
    this.maxPlayers = maxPlayers;
    this.states = [];
    for (let i = 0; i < maxPlayers; i++) {
      this.states.push(new InputState());
    }
  }

  getPlayerState(idx: number): InputState {
    if (idx < 0 || idx >= this.maxPlayers) {
      return this.states[0];
    }
    return this.states[idx];
  }

  getMaxPlayers(): number {
    return this.maxPlayers;
  }

  endFrame(): void {
    for (let i = 0; i < this.states.length; i++) {
      this.states[i].endFrame();
    }
  }

  resetPlayer(idx: number): void {
    if (idx >= 0 && idx < this.maxPlayers) {
      const s = this.states[idx];
      s.keys.clear();
      s.keysPressed.clear();
      s.keysReleased.clear();
      s.mouseButtons.clear();
      s.mouseButtonsPressed.clear();
      s.mouseButtonsReleased.clear();
      s.gamepadButtons.clear();
      s.mouseDeltaX = 0;
      s.mouseDeltaY = 0;
      s.wheelDelta = 0;
      for (let i = 0; i < s.gamepadAxes.length; i++) s.gamepadAxes[i] = 0;
    }
  }

  resetAll(): void {
    for (let i = 0; i < this.maxPlayers; i++) {
      this.resetPlayer(i);
    }
  }
}
