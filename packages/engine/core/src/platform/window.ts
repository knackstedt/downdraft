// DORMANT — no live consumers; superseded by platform-native's NativeWindow.
// Retained only for the core/index.ts re-export until deletion (Phase 7 of
// docs/refactor/native-rearchitecture-plan.md).
export interface WindowConfig {
  width: number;
  height: number;
  title: string;
  resizable: boolean;
  transparent: boolean;
}

export interface WindowState {
  width: number;
  height: number;
  scaleFactor: number;
  resized: boolean;
}

export class WindowManager {
  private config: WindowConfig;
  private state: WindowState;
  private resizeHandlers: Array<(width: number, height: number) => void> = [];

  constructor(config: WindowConfig) {
    this.config = config;
    this.state = {
      width: config.width,
      height: config.height,
      scaleFactor: 1,
      resized: false,
    };
  }

  getConfig(): WindowConfig {
    return this.config;
  }

  getState(): WindowState {
    return this.state;
  }

  resize(width: number, height: number): void {
    this.state.width = width;
    this.state.height = height;
    this.state.resized = true;
    for (let i = 0; i < this.resizeHandlers.length; i++) {
      this.resizeHandlers[i](width, height);
    }
  }

  setScaleFactor(scale: number): void {
    this.state.scaleFactor = scale;
  }

  getRenderWidth(): number {
    return Math.floor(this.state.width * this.state.scaleFactor);
  }

  getRenderHeight(): number {
    return Math.floor(this.state.height * this.state.scaleFactor);
  }

  onResize(fn: (width: number, height: number) => void): void {
    this.resizeHandlers.push(fn);
  }

  clearResizedFlag(): void {
    this.state.resized = false;
  }
}
