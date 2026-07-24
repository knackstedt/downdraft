import type { ScriptingSystem } from "./script.ts";

export class HotReloader {
  private scripting: ScriptingSystem;
  private watchers: Map<string, (path: string) => void> = new Map();

  constructor(scripting: ScriptingSystem) {
    this.scripting = scripting;
  }

  watch(name: string, path: string, onReload?: (path: string) => void): void {
    const handler = async (changedPath: string) => {
      await this.scripting.hotReload(name, path);
      if (onReload) onReload(changedPath);
    };
    this.watchers.set(name, handler);
  }

  triggerReload(name: string, path: string): void {
    const handler = this.watchers.get(name);
    if (handler) handler(path);
  }

  unwatch(name: string): void {
    this.watchers.delete(name);
  }
}
