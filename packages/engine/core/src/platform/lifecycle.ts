// DORMANT — no live consumers; app lifecycle is owned by platform-native
// (NativeWindow/NativeHostContext). Retained only for the core/index.ts
// re-export until deletion (Phase 7 of
// docs/refactor/native-rearchitecture-plan.md).
export class Lifecycle {
  private ready: boolean = false;
  private quitHandlers: Array<() => void> = [];

  isReady(): boolean {
    return this.ready;
  }

  setReady(): void {
    this.ready = true;
  }

  onQuit(fn: () => void): void {
    this.quitHandlers.push(fn);
  }

  quit(): void {
    for (let i = 0; i < this.quitHandlers.length; i++) {
      this.quitHandlers[i]();
    }
  }
}
