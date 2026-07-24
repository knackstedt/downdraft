import { InputContext, InputState } from "./state.ts";

export class InputContextRouter {
  private state: InputState;
  private contextMappings: Map<InputContext, Map<string, number[]>> = new Map();
  private currentContext: InputContext = InputContext.Editor;

  constructor(state: InputState) {
    this.state = state;
  }

  registerContext(ctx: InputContext, mappings: Map<string, number[]>): void {
    this.contextMappings.set(ctx, mappings);
  }

  setContext(ctx: InputContext): void {
    this.currentContext = ctx;
    this.state.setContext(ctx);
  }

  getActiveContext(): InputContext {
    if (this.currentContext === InputContext.UI) return InputContext.UI;
    if (this.currentContext === InputContext.Game) return InputContext.Game;
    return InputContext.Editor;
  }

  isActionDown(action: string): boolean {
    const mappings = this.contextMappings.get(this.currentContext);
    if (!mappings) return false;
    const codes = mappings.get(action);
    if (!codes) return false;
    for (let i = 0; i < codes.length; i++) {
      if (this.state.isKeyDown(codes[i])) return true;
    }
    return false;
  }

  wasActionPressed(action: string): boolean {
    const mappings = this.contextMappings.get(this.currentContext);
    if (!mappings) return false;
    const codes = mappings.get(action);
    if (!codes) return false;
    for (let i = 0; i < codes.length; i++) {
      if (this.state.wasKeyPressed(codes[i])) return true;
    }
    return false;
  }
}
