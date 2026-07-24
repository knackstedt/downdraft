export enum InputContext {
  Editor = 0,
  Game = 1,
  UI = 2,
}

export class InputState {
  keys: Set<number> = new Set();
  keysPressed: Set<number> = new Set();
  keysReleased: Set<number> = new Set();
  mouseX: number = 0;
  mouseY: number = 0;
  mouseDeltaX: number = 0;
  mouseDeltaY: number = 0;
  mouseButtons: Set<number> = new Set();
  mouseButtonsPressed: Set<number> = new Set();
  mouseButtonsReleased: Set<number> = new Set();
  wheelDelta: number = 0;
  gamepadButtons: Set<number> = new Set();
  gamepadAxes: number[] = [0, 0, 0, 0];

  private context: InputContext = InputContext.Editor;
  private contextLocked: boolean = false;

  setContext(ctx: InputContext): void {
    if (!this.contextLocked) {
      this.context = ctx;
    }
  }

  getContext(): InputContext {
    return this.context;
  }

  lockContext(locked: boolean): void {
    this.contextLocked = locked;
  }

  isKeyDown(code: number): boolean {
    return this.keys.has(code);
  }

  wasKeyPressed(code: number): boolean {
    return this.keysPressed.has(code);
  }

  wasKeyReleased(code: number): boolean {
    return this.keysReleased.has(code);
  }

  isMouseDown(button: number): boolean {
    return this.mouseButtons.has(button);
  }

  wasMousePressed(button: number): boolean {
    return this.mouseButtonsPressed.has(button);
  }

  wasMouseReleased(button: number): boolean {
    return this.mouseButtonsReleased.has(button);
  }

  action(mapping: Map<string, number[]>): (action: string) => boolean {
    return (action: string) => {
      const codes = mapping.get(action);
      if (!codes) return false;
      for (let i = 0; i < codes.length; i++) {
        if (this.keys.has(codes[i])) return true;
      }
      return false;
    };
  }

  endFrame(): void {
    this.keysPressed.clear();
    this.keysReleased.clear();
    this.mouseButtonsPressed.clear();
    this.mouseButtonsReleased.clear();
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    this.wheelDelta = 0;
  }

  keyDown(code: number): void {
    if (!this.keys.has(code)) {
      this.keysPressed.add(code);
    }
    this.keys.add(code);
  }

  keyUp(code: number): void {
    if (this.keys.has(code)) {
      this.keysReleased.add(code);
    }
    this.keys.delete(code);
  }

  mouseMove(x: number, y: number, deltaX: number, deltaY: number): void {
    this.mouseX = x;
    this.mouseY = y;
    this.mouseDeltaX += deltaX;
    this.mouseDeltaY += deltaY;
  }

  mouseDown(button: number): void {
    if (!this.mouseButtons.has(button)) {
      this.mouseButtonsPressed.add(button);
    }
    this.mouseButtons.add(button);
  }

  mouseUp(button: number): void {
    if (this.mouseButtons.has(button)) {
      this.mouseButtonsReleased.add(button);
    }
    this.mouseButtons.delete(button);
  }

  wheel(delta: number): void {
    this.wheelDelta += delta;
  }
}
