import { createLogger } from "@downdraft/engine";
import type { EngineContext } from "./engine-context";

const log = createLogger();

export interface UndoAction {
  description: string;
  undo: () => void;
  redo: () => void;
}

export class UndoRedoManager {
  private undoStack: UndoAction[] = [];
  private redoStack: UndoAction[] = [];
  private maxStack: number = 100;
  private ctx: EngineContext;

  constructor(ctx: EngineContext) {
    this.ctx = ctx;
  }

  execute(action: UndoAction): void {
    this.undoStack.push(action);
    if (this.undoStack.length > this.maxStack) {
      this.undoStack.shift();
    }
    this.redoStack.length = 0;
  }

  undo(): boolean {
    const action = this.undoStack.pop();
    if (!action) return false;
    try {
      action.undo();
      this.redoStack.push(action);
      return true;
    } catch (e) {
      log.error("UndoRedo", `Undo failed: ${e}`);
      this.undoStack.push(action);
      return false;
    }
  }

  redo(): boolean {
    const action = this.redoStack.pop();
    if (!action) return false;
    try {
      action.redo();
      this.undoStack.push(action);
      return true;
    } catch (e) {
      log.error("UndoRedo", `Redo failed: ${e}`);
      this.redoStack.push(action);
      return false;
    }
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  getHistory(): { undo: string[]; redo: string[] } {
    return {
      undo: this.undoStack.map((a) => a.description),
      redo: this.redoStack.map((a) => a.description),
    };
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
