import { InputState } from "./state";

export class InputMapping {
  private bindings: Map<string, number[]> = new Map();
  private state: InputState;

  constructor(state: InputState) {
    this.state = state;
  }

  bind(action: string, codes: number[]): void {
    this.bindings.set(action, codes);
  }

  unbind(action: string): void {
    this.bindings.delete(action);
  }

  isActionDown(action: string): boolean {
    const codes = this.bindings.get(action);
    if (!codes) return false;
    for (let i = 0; i < codes.length; i++) {
      if (this.state.isKeyDown(codes[i])) return true;
    }
    return false;
  }

  wasActionPressed(action: string): boolean {
    const codes = this.bindings.get(action);
    if (!codes) return false;
    for (let i = 0; i < codes.length; i++) {
      if (this.state.wasKeyPressed(codes[i])) return true;
    }
    return false;
  }

  getBindings(): Map<string, number[]> {
    return this.bindings;
  }
}
