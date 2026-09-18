// ============================================================================
// wgslHotReload — shader source registry for fine-grained WGSL HMR
// ============================================================================
//
// Zero-dependency module (no imports) to avoid circular dependency concerns.
// The wgslHmrPlugin (vite) registers shader sources at module-load time and
// calls reload() when a `*.wgsl?raw` module is hot-updated. Consumers
// (MaterialLibrary, game pass classes, entity-shaders) subscribe to be
// notified of changes so they can rebuild GPU pipelines without a full page
// reload. When there are no subscribers for a given shader, reload() falls
// back to a full page reload so edits always take effect.
//
// In production builds this registry is inert: register() still runs (harmless
// Map insert) but reload() is never called because import.meta.hot is absent.

export type WgslReloadFn = (newSource: string) => void;

class WgslHotReloadRegistry {
  private sources = new Map<string, string>();
  private listeners = new Map<string, Set<WgslReloadFn>>();

  /** Register a shader source by its absolute file path. */
  register(id: string, source: string): void {
    this.sources.set(id, source);
  }

  /** Get the most recently registered source for a shader. */
  get(id: string): string | undefined {
    return this.sources.get(id);
  }

  /**
   * Subscribe to reload notifications for a shader id.
   * Returns an unsubscribe function.
   */
  subscribe(id: string, fn: WgslReloadFn): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.listeners.delete(id);
    };
  }

  /**
   * Notify subscribers that a shader was reloaded. If there are no
   * subscribers, fall back to a full page reload so the edit always
   * takes effect.
   */
  reload(id: string, newSource: string): void {
    this.sources.set(id, newSource);
    const set = this.listeners.get(id);
    if (set && set.size > 0) {
      set.forEach((fn) => fn(newSource));
    } else if (typeof window !== "undefined") {
      // No fine-grained subscriber — reload the page so the change is visible.
      window.location.reload();
    }
  }
}

export const wgslHotReload = new WgslHotReloadRegistry();
