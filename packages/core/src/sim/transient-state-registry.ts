// ============================================================================
// TransientStateRegistry — framework-level registry for transient state that
// must be stripped during hot-reload serialization and reset after restore.
//
// Games register two kinds of concerns:
//   1. Transient flags — bit masks applied to fields in serialized state arrays
//      (e.g., player flags like PILOTING, CLIMBING) that depend on unserialized
//      system internal state and must be cleared during save.
//   2. Reset callbacks — functions that clear system-internal Maps/Sets/state
//      that accumulate during runtime but aren't part of the serialized state.
//
// Defense in depth: if a game forgets to register a transient flag, the reset
// callback still clears dependent system state. If a game forgets a reset
// callback, transient flags are still stripped. Both together prevent frozen
// state after hot-reload.
// ============================================================================

type ResetCallback = () => void;

interface TransientFlagEntry {
  category: string;
  mask: number;
}

export class TransientStateRegistry {
  private transientFlags: TransientFlagEntry[] = [];
  private resetCallbacks: ResetCallback[] = [];

  registerTransientFlags(category: string, mask: number): void {
    this.transientFlags.push({ category, mask });
  }

  registerResetCallback(fn: ResetCallback): void {
    this.resetCallbacks.push(fn);
  }

  stripTransientFlags(state: Record<string, unknown>): void {
    for (const entry of this.transientFlags) {
      const arr = state[entry.category];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i];
        if (item && typeof item === "object" && "flags" in item) {
          const typed = item as { flags: number };
          typed.flags = typed.flags & ~entry.mask;
        }
      }
    }
  }

  resetAll(): void {
    for (let i = 0; i < this.resetCallbacks.length; i++) {
      try {
        this.resetCallbacks[i]();
      } catch (err) {
        console.error(`[TransientStateRegistry] Reset callback ${i} failed: ${err}`);
      }
    }
  }

  clear(): void {
    this.transientFlags.length = 0;
    this.resetCallbacks.length = 0;
  }

  getTransientFlagCount(): number {
    return this.transientFlags.length;
  }

  getResetCallbackCount(): number {
    return this.resetCallbacks.length;
  }
}
