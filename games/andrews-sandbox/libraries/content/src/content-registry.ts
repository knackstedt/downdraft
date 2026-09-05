// ============================================================================
// ContentRegistry — tracks all discoverable content (props, models, textures)
// from plugins and drag-drop imports. Renderer-side.
// ============================================================================

export interface ContentEntry {
  id: string;
  name: string;
  category: string;
  /** URI for the GLB/GLTF model file (if this is a model prop). */
  modelUri?: string;
  /** URI for a thumbnail image. */
  thumbnailUri?: string;
  /** Plugin source id, or "builtin" / "drag-drop". */
  pluginSource: string;
  /** Default physics properties. */
  physics: {
    mass: number;
    restitution: number;
    friction: number;
    gravityScale: number;
  };
  /** Default visual scale. */
  scale: number;
  /** Whether this prop can be painted. */
  paintable: boolean;
  /** Physics shape override ("box" | "sphere"). If undefined, inferred from id/model. */
  shape?: "box" | "sphere";
}

/** Lightweight item for UI lists. */
export interface ContentListItem {
  id: string;
  name: string;
  category: string;
  thumbnailUri?: string;
  pluginSource?: string;
}

export class ContentRegistry {
  private items = new Map<string, ContentEntry>();
  private listeners = new Set<(items: ContentListItem[]) => void>();

  register(entry: ContentEntry): void {
    this.items.set(entry.id, entry);
    this.notifyListeners();
  }

  get(id: string): ContentEntry | undefined {
    return this.items.get(id);
  }

  list(): ContentEntry[] {
    return Array.from(this.items.values());
  }

  listItems(): ContentListItem[] {
    return this.list().map((e) => ({
      id: e.id,
      name: e.name,
      category: e.category,
      thumbnailUri: e.thumbnailUri,
      pluginSource: e.pluginSource,
    }));
  }

  remove(id: string): void {
    this.items.delete(id);
    this.notifyListeners();
  }

  clear(): void {
    this.items.clear();
    this.notifyListeners();
  }

  onChange(cb: (items: ContentListItem[]) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notifyListeners(): void {
    const items = this.listItems();
    for (const cb of this.listeners) {
      try { cb(items); } catch { /* ignore */ }
    }
  }
}
