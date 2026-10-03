// ============================================================================
// SelectionModel — the editor's selection state (entity keys, not Entities).
//
// Selection lives outside the document: it is editor session state, not
// authored content. Selection commands are journaled to the event log only
// (agents can observe selection changes) but never reach the undo stack.
// ============================================================================

export class SelectionModel {
  private keys: string[] = [];
  private listeners = new Set<(keys: string[]) => void>();

  get(): string[] {
    return [...this.keys];
  }

  primary(): string | null {
    return this.keys.length > 0 ? this.keys[this.keys.length - 1]! : null;
  }

  isSelected(key: string): boolean {
    return this.keys.includes(key);
  }

  get size(): number {
    return this.keys.length;
  }

  set(keys: string[]): void {
    this.keys = [...new Set(keys)];
    this.emit();
  }

  add(key: string): void {
    if (!this.keys.includes(key)) {
      this.keys.push(key);
      this.emit();
    }
  }

  remove(key: string): void {
    const idx = this.keys.indexOf(key);
    if (idx >= 0) {
      this.keys.splice(idx, 1);
      this.emit();
    }
  }

  toggle(key: string): void {
    if (this.isSelected(key)) this.remove(key);
    else this.add(key);
  }

  clear(): void {
    if (this.keys.length > 0) {
      this.keys = [];
      this.emit();
    }
  }

  onChange(fn: (keys: string[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const snapshot = this.get();
    this.listeners.forEach((fn) => fn(snapshot));
  }
}
